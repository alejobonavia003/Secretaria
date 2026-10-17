// Pruebas sin red ni coste del flujo "Reiniciar todo" (flujos/reiniciar-todo.json).
// Ejecuta el código real de herramientas/flujo-reinicio/*.js con entradas simuladas.
// Uso: node herramientas/probar-reinicio.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-reinicio.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const nodo = (f) => leer('flujo-reinicio', f);

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

const CAL = 'abc123@group.calendar.google.com';
const RAIZ = 'RAIZ-ID-1234567890';
const CONFIG = { calendar_id: CAL, carpeta_raiz_id: RAIZ, conservar: ['Entrada', 'Trabajo', 'Notas'], real: false };
const CARPETA = 'application/vnd.google-apps.folder';

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

const f = (n, name, mimeType = 'application/pdf') => ({ id: `ID-${String(n).padStart(10, '0')}`, name, mimeType });

async function main() {
  console.log('Configuración');
  {
    const base = nodo('configuracion.js');
    await lanza('sin poner el calendario, lanza', correr(base), 'CALENDAR_ID');
    const conCal = base.replace('TU-CALENDARIO@group.calendar.google.com', CAL);
    await lanza('sin poner la carpeta raíz, lanza', correr(conCal), 'CARPETA_RAIZ_ID');
    const listo = conCal.replace('TU-CARPETA-RAIZ', RAIZ);
    const [c] = await correr(listo);
    afirmar('con CONFIRMAR vacío (como viene) solo ensaya', c.config.real === false && c.config.calendar_id === CAL && c.config.carpeta_raiz_id === RAIZ);
    afirmar('se conservan Entrada y Notas', JSON.stringify(c.config.conservar) === JSON.stringify(['Entrada', 'Notas']));
    const [v] = await correr(listo.replace("const CONFIRMAR = '';", "const CONFIRMAR = 'BORRAR TODO';"));
    afirmar('solo la frase exacta BORRAR TODO activa el borrado', v.config.real === true);
    for (const casi of ['borrar todo', 'BORRAR', 'SI', ' BORRAR TODO']) {
      const [x] = await correr(listo.replace("const CONFIRMAR = '';", `const CONFIRMAR = '${casi}';`));
      afirmar(`«${casi}» no basta`, x.config.real === false);
    }
    await lanza('un ID de carpeta con caracteres raros se rechaza', correr(conCal.replace('TU-CARPETA-RAIZ', 'x or name contains a')), 'CARPETA_RAIZ_ID');
  }

  console.log('Planificar raíz');
  {
    const raiz = { files: [f(1, 'Entrada', CARPETA), f(2, 'Trabajo', CARPETA), f(3, 'notas', CARPETA), f(4, 'Fotos', CARPETA), f(5, 'suelto.pdf'), f(6, 'Trabajo')] };
    const r = await correr(nodo('planificar-raiz.js'), { input: [raiz] });
    afirmar('una salida por cada carpeta conservada que existe (sin distinguir mayúsculas)', r.length === 3 && r.map((x) => x.carpeta).join() === 'Entrada,Trabajo,notas', JSON.stringify(r.map((x) => x.carpeta)));
    const papelera = r.flatMap((x) => x.para_papelera).map((x) => x.nombre).sort();
    afirmar('a la papelera va el resto: otras carpetas, archivos sueltos y un ARCHIVO que se llame como una carpeta conservada', papelera.join() === 'Fotos,Trabajo,suelto.pdf', papelera.join());
    afirmar('la lista de la raíz viaja solo en la primera salida', r[0].para_papelera.length === 3 && r[1].para_papelera.length === 0);
    const q = decodeURIComponent(new URL(r[1].url).searchParams.get('q'));
    afirmar('lista los hijos de esa carpeta, sin lo que ya está en la papelera', q === "'ID-0000000002' in parents and trashed=false", q);
    afirmar('pide solo lo necesario y 1000 por página', new URL(r[1].url).searchParams.get('pageSize') === '1000' && new URL(r[1].url).searchParams.get('fields') === 'nextPageToken,files(id,name,mimeType)');
    const sin = await correr(nodo('planificar-raiz.js'), { input: [{ files: [f(5, 'suelto.pdf')] }] });
    afirmar('sin ninguna carpeta conservada devuelve una salida inocua y sigue', sin.length === 1 && sin[0].inocua === true && sin[0].para_papelera.length === 1);
    const vacia = await correr(nodo('planificar-raiz.js'), { input: [{ files: [] }] });
    afirmar('raíz vacía: nada que hacer, sin error', vacia.length === 1 && vacia[0].para_papelera.length === 0);
    const rara = await correr(nodo('planificar-raiz.js'), { input: [{ files: [{ id: "x' or '1'='1", name: 'Fotos', mimeType: CARPETA }, f(7, 'Fotos', CARPETA)] }] });
    afirmar('un id con caracteres raros se ignora (no entra en ninguna consulta)', rara[0].para_papelera.length === 1 && rara[0].para_papelera[0].id === 'ID-0000000007');
    const pag = await correr(nodo('planificar-raiz.js'), { input: [{ files: [f(1, 'Entrada', CARPETA)], nextPageToken: 'mas' }] });
    afirmar('si la raíz viene paginada se avisa', pag[0].raiz_incompleta === true);
  }

  console.log('Reunir y decidir');
  {
    const plan = [
      { carpeta: 'Entrada', inocua: false, raiz_incompleta: false, para_papelera: [{ id: 'ID-FOTOS-0001', nombre: 'Fotos' }] },
      { carpeta: 'Trabajo', inocua: false, para_papelera: [] },
      { carpeta: 'Notas', inocua: false, para_papelera: [] },
    ];
    const hijos = [{ files: [f(1, 'foto.jpg', 'image/jpeg')] }, { files: [f(2, 'Facturas', CARPETA), f(1, 'foto.jpg', 'image/jpeg')] }, { files: [] }];
    const eventos = { items: [{ id: 'ev1', summary: 'Dentista' }, { id: 'ev2' }] };
    const nodos = { 'Planificar raíz': plan, 'Leer contenido de las carpetas': hijos, 'Leer eventos de Calendar': [eventos] };
    const ens = await correr(nodo('reunir.js'), { input: [{}], nodos });
    afirmar('ensayo: UN item con el informe y sin operaciones', ens.length === 1 && ens[0].modo === 'ensayo' && ens[0].drive_a_la_papelera === 3 && ens[0].eventos_de_calendar === 2, JSON.stringify(ens));
    afirmar('el ensayo enseña ejemplos legibles', ens[0].ejemplos.includes('Calendar · calendario · (sin título)') && ens[0].ejemplos.some((e) => e.startsWith('Drive · Trabajo · Facturas')));
    const real = await correr(nodo('reunir.js'), { input: [{}], nodos: { ...nodos, config: { ...CONFIG, real: true } } });
    afirmar('real: una operación por item, sin repetir ids (un archivo visto dos veces cuenta una)', real.length === 5 && real.every((o) => o.modo === 'real') && new Set(real.map((o) => `${o.tipo}:${o.id}`)).size === 5, JSON.stringify(real.map((o) => o.id)));
    afirmar('cada operación sabe de qué tipo es', real.filter((o) => o.tipo === 'drive').length === 3 && real.filter((o) => o.tipo === 'calendar').length === 2);
    const nada = await correr(nodo('reunir.js'), { input: [{}], nodos: { 'Planificar raíz': [{ carpeta: null, inocua: true, para_papelera: [] }], 'Leer contenido de las carpetas': [{}], 'Leer eventos de Calendar': [{ items: [] }], config: { ...CONFIG, real: true } } });
    afirmar('real sin nada que borrar: modo «nada», sin error', nada.length === 1 && nada[0].modo === 'nada');
    const pag = await correr(nodo('reunir.js'), { input: [{}], nodos: { ...nodos, 'Leer eventos de Calendar': [{ items: [], nextPageToken: 'mas' }] } });
    afirmar('si una lista viene paginada se avisa de que hay que repetir', pag[0].incompleto === true && pag[0].nota.includes('vuelve a ejecutar'));
    const vacioEv = await correr(nodo('reunir.js'), { input: [{}], nodos: { ...nodos, 'Leer eventos de Calendar': [{}] } });
    afirmar('un calendario sin eventos (respuesta sin items) no rompe', vacioEv[0].eventos_de_calendar === 0);
    const muchos = { files: Array.from({ length: 1000 }, (_, i) => f(i + 1, `a${i}`)) };
    await lanza('más de 3000 operaciones se rechaza', correr(nodo('reunir.js'), { input: [{}], nodos: { 'Planificar raíz': [{ carpeta: 'Entrada', inocua: false, para_papelera: [] }, { carpeta: 'Trabajo', inocua: false, para_papelera: [] }, { carpeta: 'Notas', inocua: false, para_papelera: [] }], 'Leer contenido de las carpetas': [muchos, { files: Array.from({ length: 1000 }, (_, i) => f(2000 + i, `b${i}`)) }, { files: Array.from({ length: 1000 }, (_, i) => f(4000 + i, `c${i}`)) }], 'Leer eventos de Calendar': [{ items: [{ id: 'x' }] }] } }), '3000');
  }

  console.log('Resumen');
  {
    const ops = [
      { modo: 'real', tipo: 'drive', id: 'd1', nombre: 'Fotos', incompleto: false },
      { modo: 'real', tipo: 'drive', id: 'd2', nombre: 'a.pdf', incompleto: false },
      { modo: 'real', tipo: 'calendar', id: 'e1', nombre: 'Dentista', incompleto: false },
      { modo: 'real', tipo: 'calendar', id: 'e2', nombre: 'Viejo', incompleto: false },
      { modo: 'real', tipo: 'calendar', id: 'e3', nombre: 'Roto', incompleto: false },
    ];
    const [r] = await correr(nodo('resumen.js'), {
      nodos: {
        'Reunir y decidir': ops,
        'Mandar a la papelera de Drive': [{ statusCode: 200 }, { statusCode: 403 }],
        'Borrar evento de Calendar': [{ statusCode: 204 }, { statusCode: 410 }, { statusCode: 500 }],
      },
    });
    afirmar('cuenta lo hecho (410 cuenta como borrado: ya no existía) y apunta los fallos', r.drive_a_la_papelera === 1 && r.eventos_borrados === 2 && r.fallos.length === 2 && r.fallos.includes('Drive · a.pdf: 403') && r.fallos.includes('Calendar · Roto: 500'), JSON.stringify(r));
    afirmar('con fallos pide repetir', r.nota.includes('vuelve a ejecutar'));
    const [ok] = await correr(nodo('resumen.js'), { nodos: { 'Reunir y decidir': ops.slice(0, 1), 'Mandar a la papelera de Drive': [{ statusCode: 200 }] } });
    afirmar('sin fallos y con una rama sin ejecutar, no rompe y recuerda vaciar la base de datos', ok.drive_a_la_papelera === 1 && ok.eventos_borrados === 0 && ok.fallos.length === 0 && ok.nota.includes('SQL'), JSON.stringify(ok));
    const [e] = await correr(nodo('resumen.js'), { nodos: { 'Reunir y decidir': [{ modo: 'ensayo', drive_a_la_papelera: 3 }] } });
    afirmar('en ensayo dice claramente que no se ha borrado nada', e.modo === 'ensayo' && e.aviso.startsWith('ENSAYO: no se ha borrado nada'));
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const nodos = flujo.nodes.filter((n) => !n.type.includes('stickyNote'));
    const por = (nombre) => nodos.find((n) => n.name === nombre);
    afirmar('solo se lanza a mano: ni Schedule ni Webhook', nodos.length === 12 && nodos.every((n) => !/schedule|webhook/i.test(n.type)) && nodos.some((n) => n.type === 'n8n-nodes-base.manualTrigger'));
    const http = nodos.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
    afirmar('toda llamada lleva credencial de Google (nada de claves en el JSON)', http.length === 5 && http.every((n) => ['googleDriveOAuth2Api', 'googleCalendarOAuth2Api'].includes(n.parameters.nodeCredentialType)));
    const metodos = http.map((n) => `${n.name}:${n.parameters.method}`);
    afirmar('Drive nunca se borra definitivamente: solo hay GET y PATCH a Drive (DELETE es solo de Calendar)', http.filter((n) => n.parameters.nodeCredentialType === 'googleDriveOAuth2Api').every((n) => ['GET', 'PATCH'].includes(n.parameters.method)) && por('Borrar evento de Calendar').parameters.method === 'DELETE', metodos.join());
    afirmar('a la papelera con trashed:true', por('Mandar a la papelera de Drive').parameters.jsonBody.includes('trashed: true') && !por('Mandar a la papelera de Drive').parameters.url.includes('/files?'));
    afirmar('el borrado va de 5 en 5 por segundo y los errores no cortan', [por('Mandar a la papelera de Drive'), por('Borrar evento de Calendar')].every((n) => n.parameters.options.batching.batch.batchSize === 5 && n.parameters.options.batching.batch.batchInterval === 1000 && n.parameters.options.response.response.neverError === true));
    afirmar('solo toca el calendario y la carpeta de la configuración', por('Leer eventos de Calendar').parameters.url.includes('config.calendar_id') && por('Leer raíz de Drive').parameters.url.includes('config.carpeta_raiz_id'));
    const c = flujo.connections;
    afirmar('el ensayo y el «nada» van directos al resumen; el borrado, por las dos ramas', c['¿Borrar de verdad?'].main[1][0].node === 'Resumen' && c['¿Borrar de verdad?'].main[0][0].node === '¿Es de Drive?' && c['¿Es de Drive?'].main[0][0].node === 'Mandar a la papelera de Drive' && c['¿Es de Drive?'].main[1][0].node === 'Borrar evento de Calendar');
    afirmar('Leer eventos se ejecuta una sola vez aunque haya varias carpetas', por('Leer eventos de Calendar').executeOnce === true);
    const ids = flujo.nodes.map((n) => n.id);
    afirmar('ids únicos', new Set(ids).size === ids.length);
    afirmar('los dos IF tienen ids de condición bien formados', nodos.filter((n) => n.type === 'n8n-nodes-base.if').every((n) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(n.parameters.conditions.conditions[0].id)));
    const json = JSON.stringify(flujo);
    afirmar('el JSON no lleva ningún ID real ni clave', !/AIza|eyJ|sk-/.test(json) && json.includes('TU-CALENDARIO') && json.includes('TU-CARPETA-RAIZ'));
  }

  console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} con fallo.`);
  if (fallan.length) {
    console.log('Fallan:');
    fallan.forEach((n) => console.log(`- ${n}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
