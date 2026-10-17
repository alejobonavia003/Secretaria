// Pruebas sin red ni coste del flujo "Limpieza de eventos" (flujos/limpieza-eventos.json).
// Ejecuta el código real de herramientas/flujo-limpieza/*.js con entradas simuladas y un reloj fijo.
// Uso: node herramientas/probar-limpieza.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-limpieza.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const nodo = (f) => leer('flujo-limpieza', f);

let pasan = 0;
const fallan = [];
function afirmar(nombre, condicion, detalle) {
  if (condicion) pasan += 1;
  else {
    fallan.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}
async function lanza(nombre, promesa, trozo) {
  try {
    await promesa;
    afirmar(nombre, false, 'debía lanzar un error y no lo hizo');
  } catch (e) {
    afirmar(nombre, String(e.message).includes(trozo), `error recibido: ${e.message}`);
  }
}

// Reloj fijo: martes 20 de octubre de 2026, 03:00 en Madrid (01:00 UTC)
const RealDate = Date;
const AHORA = new RealDate('2026-10-20T01:00:00.000Z').getTime();
class Fija extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(AHORA);
    else super(...a);
  }
  static now() {
    return AHORA;
  }
}
globalThis.Date = Fija;

const CONFIG = { supabase_url: 'https://abc.supabase.co', dias_retencion: 7, lote: 50 };
const LIMITE = '2026-10-13T01:00:00.000Z'; // ahora - 7 días

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }) };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { input = [], nodos = {} } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', codigo);
  const salida = await fn({ all: () => items, first: () => items[0] }, simular(nodos));
  return salida.map((x) => x.json);
}

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const ev = (n, extra = {}) => ({ id: U(n), titulo: `Evento ${n}`, estado: 'pendiente', fecha_inicio: '2026-10-05T08:00:00+00:00', fecha_fin: '2026-10-05T09:00:00+00:00', ...extra });

async function main() {
  console.log('Calcular límite');
  {
    const [r] = await correr(nodo('calcular.js'));
    afirmar('el límite es ahora menos 7 días, exacto', r.limite === LIMITE, r.limite);
    const url = new URL(r.url_lectura);
    afirmar('consulta items de tipo evento, pendientes o hechos, y nunca los archivados', url.pathname === '/rest/v1/items' && url.searchParams.get('tipo') === 'eq.evento' && url.searchParams.get('estado') === 'in.(pendiente,hecho)' && !r.url_lectura.includes('archivado'));
    afirmar('pide solo lo necesario, los más antiguos primero y con tope', url.searchParams.get('select') === 'id,titulo,fecha_inicio,fecha_fin,estado' && url.searchParams.get('order') === 'fecha_inicio.asc' && url.searchParams.get('limit') === '50');
    afirmar('el filtro de fecha usa el FIN, y el inicio solo si no hay fin', url.searchParams.get('or') === `(fecha_fin.lt."${LIMITE}",and(fecha_fin.is.null,fecha_inicio.lt."${LIMITE}"))`, url.searchParams.get('or'));
    const [otro] = await correr(nodo('calcular.js'), { nodos: { config: { ...CONFIG, dias_retencion: 30, lote: 10 } } });
    afirmar('los días y el lote salen de la configuración', otro.limite === '2026-09-20T01:00:00.000Z' && new URL(otro.url_lectura).searchParams.get('limit') === '10', otro.limite);
  }

  console.log('Planificar archivado');
  {
    const plan = (filas, limite = LIMITE) => correr(nodo('planificar.js'), { input: filas, nodos: { 'Calcular límite': [{ limite }] } });
    afirmar('sin eventos (item vacío de Always Output Data) no hace nada y el flujo termina', (await plan([{}])).length === 0 && (await plan([])).length === 0);

    const [p] = await plan([ev(1), ev(2, { estado: 'hecho' })]);
    afirmar('archiva los eventos pasados con UN solo PATCH que pasa a archivado', p.cuerpo.estado === 'archivado' && JSON.stringify(p.cuerpo) === '{"estado":"archivado"}' && p.planificados === 2);
    const u = new URL(p.url);
    afirmar('el PATCH lleva los ids, repite tipo y estado y no toca los archivados', u.pathname === '/rest/v1/items' && u.searchParams.get('id') === `in.(${U(1)},${U(2)})` && u.searchParams.get('tipo') === 'eq.evento' && u.searchParams.get('estado') === 'in.(pendiente,hecho)' && u.searchParams.get('select') === 'id,titulo', p.url);

    // Defensa: aunque la consulta devolviera algo de más, no se archiva lo que no ha pasado hace una semana
    const mezcla = await plan([
      ev(1),
      ev(2, { fecha_inicio: '2026-10-18T08:00:00+00:00', fecha_fin: '2026-10-18T09:00:00+00:00' }), // terminó hace 2 días
      ev(3, { fecha_inicio: '2026-10-25T08:00:00+00:00', fecha_fin: '2026-10-25T09:00:00+00:00' }), // futuro
      ev(4, { fecha_fin: '2026-10-13T00:59:59+00:00' }), // acaba 1 segundo antes del límite
      ev(5, { fecha_fin: '2026-10-13T01:00:00+00:00' }), // acaba justo en el límite: aún no
    ]);
    afirmar('solo archiva lo que terminó ANTES del límite (ni los recientes, ni los futuros, ni el que acaba justo en el límite)', mezcla.length === 1 && new URL(mezcla[0].url).searchParams.get('id') === `in.(${U(1)},${U(4)})` && mezcla[0].planificados === 2, mezcla[0]?.url);
    const sinFin = await plan([ev(6, { fecha_fin: null, fecha_inicio: '2026-10-05T08:00:00+00:00' }), ev(7, { fecha_fin: null, fecha_inicio: '2026-10-19T08:00:00+00:00' })]);
    afirmar('un evento sin fin cuenta por su inicio', new URL(sinFin[0].url).searchParams.get('id') === `in.(${U(6)})`);
    afirmar('un evento sin ninguna fecha nunca se archiva', (await plan([ev(8, { fecha_fin: null, fecha_inicio: null })])).length === 0);
    afirmar('no archiva lo que ya está archivado', (await plan([ev(9, { estado: 'archivado' })])).length === 0);
    afirmar('descarta ids que no son un uuid (nada raro llega a la URL)', (await plan([ev(1, { id: '1) or (1=1' }), ev(2, { id: U(2).slice(0, 35) }), { id: 5, estado: 'pendiente', fecha_fin: '2026-10-01T00:00:00Z' }])).length === 0);
    afirmar('una fecha ilegible no cuenta como pasada', (await plan([ev(1, { fecha_fin: 'cuando sea' })])).length === 0);
    afirmar('un error de PostgREST en la lectura no archiva nada', (await plan([{ code: 'PGRST', message: 'x' }])).length === 0);
    await lanza('un límite ilegible detiene el flujo con un error claro', plan([ev(1)], 'no es fecha'), 'el límite de fecha no es válido');
  }

  console.log('Resumen');
  {
    const resumen = (filas, planificados) => correr(nodo('resumen.js'), { input: filas, nodos: { 'Planificar archivado': [{ planificados }] } }).then((r) => r[0]);
    const r1 = await resumen([{ id: U(1), titulo: 'Revisión del coche' }, { id: U(2), titulo: 'Dentista' }], 2);
    afirmar('cuenta los archivados y lista sus títulos', r1.archivados === 2 && r1.sin_tocar === 0 && r1.titulos.join() === 'Revisión del coche,Dentista');
    const r2 = await resumen([{ id: U(1), titulo: 'Uno' }], 3);
    afirmar('los que cambiaron entre la lectura y la escritura se cuentan aparte', r2.archivados === 1 && r2.sin_tocar === 2);
    const r3 = await resumen([{}], 2);
    afirmar('un PATCH que no devuelve filas se informa como cero archivados', r3.archivados === 0 && r3.sin_tocar === 2);
  }

  console.log('Efecto en Google Calendar');
  {
    // Lo que hace el flujo "Sincronizar Calendar" con un item archivado: con el código real de su comun.js
    const COMUN = leer('flujo-calendar', 'comun.js').trimEnd();
    const { clasificar } = new Function(`${COMUN}\nreturn { clasificar };`)();
    const base = { id: U(1), tipo: 'evento', titulo: 'Entrevista', estado: 'archivado', fecha_inicio: '2026-10-05T08:00:00+00:00', fecha_fin: '2026-10-05T09:00:00+00:00', updated_at: '2026-10-20T01:00:00+00:00' };
    afirmar('un evento archivado que tiene su evento en Calendar se BORRA de Calendar', clasificar({ ...base, calendar_event_id: 'abc12345def' }).accion === 'borrar');
    afirmar('un evento archivado que nunca llegó a Calendar no hace nada en Calendar', clasificar({ ...base, calendar_event_id: null }).accion !== 'borrar' && clasificar({ ...base, calendar_event_id: null }).accion !== 'sincronizar');
    afirmar('un evento pendiente pasado todavía no se borra', clasificar({ ...base, estado: 'pendiente', calendar_event_id: 'abc12345def' }).accion !== 'borrar');
  }

  console.log('Configuración');
  {
    const cfg = nodo('configuracion.js');
    await lanza('con el marcador de ejemplo avisa de qué falta', correr(cfg), 'SUPABASE_URL');
    const buena = cfg.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co/');
    const [c] = await correr(buena);
    afirmar('con una URL válida devuelve 7 días y lote 50, sin barra final', c.config.supabase_url === 'https://abc.supabase.co' && c.config.dias_retencion === 7 && c.config.lote === 50);
    await lanza('rechaza 0 días', correr(buena.replace('DIAS_RETENCION = 7', 'DIAS_RETENCION = 0')), 'DIAS_RETENCION');
    await lanza('rechaza un lote absurdo', correr(buena.replace('LOTE = 50', 'LOTE = 5000')), 'LOTE');
  }

  console.log('Estructura del flujo');
  {
    const f = construirFlujo();
    const por = Object.fromEntries(f.nodes.map((x) => [x.name, x]));
    const trabajo = f.nodes.filter((x) => !x.type.endsWith('stickyNote'));
    afirmar('8 nodos de trabajo', trabajo.length === 8, String(trabajo.length));
    afirmar('zona Europe/Madrid', f.settings.timezone === 'Europe/Madrid');
    const regla = por['Cada día a las 3:00'].parameters.rule.interval[0];
    afirmar('programación: cada día a las 3:00', regla.field === 'days' && regla.daysInterval === 1 && regla.triggerAtHour === 3 && regla.triggerAtMinute === 0 && por['Cada día a las 3:00'].typeVersion === 1.4);
    afirmar('ids únicos', new Set(f.nodes.map((x) => x.id)).size === f.nodes.length);
    const cadena = ['Configuración', 'Calcular límite', 'Leer eventos antiguos', 'Planificar archivado', 'Archivar', 'Resumen'];
    afirmar('la cadena está completa y en orden', cadena.slice(0, -1).every((n, i) => f.connections[n]?.main[0][0].node === cadena[i + 1]));
    afirmar('los dos disparadores van a Configuración', f.connections['Cada día a las 3:00'].main[0][0].node === 'Configuración' && f.connections['Disparador manual'].main[0][0].node === 'Configuración');
    const l = por['Leer eventos antiguos'];
    afirmar('Leer eventos antiguos: GET con la URL calculada, Supabase, con salida aunque no haya filas y SIN ocultar fallos', l.parameters.method === 'GET' && l.parameters.url === '={{ $json.url_lectura }}' && l.parameters.nodeCredentialType === 'supabaseApi' && l.alwaysOutputData === true && l.onError === undefined);
    const a = por['Archivar'];
    afirmar('Archivar: PATCH por expresión con Supabase, devuelve las filas, reintenta y NO oculta el fallo', a.parameters.method === 'PATCH' && a.parameters.url === '={{ $json.url }}' && a.parameters.nodeCredentialType === 'supabaseApi' && a.parameters.headerParameters.parameters[0].value === 'return=representation' && a.parameters.jsonBody === '={{ JSON.stringify($json.cuerpo) }}' && a.retryOnFail === true && a.onError === undefined);
    afirmar('ningún nodo contiene una clave', !/sb_secret_|EAA[A-Za-z0-9]{20,}|AIza/.test(JSON.stringify(f)));
    const actual = JSON.stringify(f, null, 2) + '\n';
    const enDisco = fs.existsSync(path.join(__dirname, '..', 'flujos', 'limpieza-eventos.json')) ? leer('..', 'flujos', 'limpieza-eventos.json') : null;
    afirmar('flujos/limpieza-eventos.json está al día (si no, ejecuta node herramientas/generar-limpieza.js)', enDisco === actual);
  }

  globalThis.Date = RealDate;
  console.log(`\n${pasan} pruebas correctas, ${fallan.length} fallos.`);
  if (fallan.length) {
    console.log(fallan.map((x) => ` - ${x}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  globalThis.Date = RealDate;
  console.error(e);
  process.exit(1);
});
