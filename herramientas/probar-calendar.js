// Pruebas sin red ni coste del flujo "Sincronizar Calendar" (flujos/sincronizar-calendar.json).
// Ejecuta el código real de herramientas/flujo-calendar/*.js con entradas simuladas.
// Uso: node herramientas/probar-calendar.js
//
// Las fechas en hora de Madrid usan Intl, el mismo motor que tendrá n8n.

const fs = require('fs');
const { credencialesSoloPorNombre } = require('./comun/importacion');
const path = require('path');
const { construirFlujo } = require('./generar-calendar.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const COMUN = fs.readFileSync(path.join(__dirname, 'flujo-calendar', 'comun.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const nodo = (f, conComun = false) => {
  const codigo = fs.readFileSync(path.join(__dirname, 'flujo-calendar', f), 'utf8').replace(/\r\n/g, '\n');
  return conComun ? codigo.split('/*__COMUN__*/').join(COMUN) : codigo;
};

// Las funciones puras de comun.js, para probarlas directamente. Se ejecuta el contenido de ese archivo del
// propio repositorio, leído del disco: nunca texto externo ni datos del usuario (por eso new Function es seguro aquí).
const comun = new Function(`${COMUN}\nreturn { clasificar, idEventoDe, calcularAviso, cuerpoEvento, diaMadrid, esFechaIso };`)();

const CONFIG = { supabase_url: 'https://abc.supabase.co', calendar_id: 'cal123@group.calendar.google.com', aviso_min: 30, duracion_min: 60, lote: 20, zona: 'Europe/Madrid' };
const BASE = 'https://abc.supabase.co/rest/v1';
const API = 'https://www.googleapis.com/calendar/v3/calendars/cal123%40group.calendar.google.com/events';

function simular(nodos) {
  return (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { input = [], nodos = {} } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', 'DateTime', codigo);
  const salida = await fn({ all: () => items, first: () => items[0] }, simular(nodos), undefined);
  return salida.map((x) => x.json);
}

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

// Items de ejemplo tal como los devuelve PostgREST
const ITEM_A = { id: '11111111-2222-4333-8444-555555555555', tipo: 'evento', titulo: 'Dentista', contenido: 'Llevar la tarjeta', estado: 'pendiente', fecha_inicio: '2026-10-15T08:00:00+00:00', fecha_fin: '2026-10-15T09:00:00+00:00', calendar_event_id: null, updated_at: '2026-10-10T12:00:00.123456+00:00' };
const ID_A = '11111111222243338444555555555555';
const ITEM_B = { ...ITEM_A, id: '99999999-aaaa-4bbb-8ccc-dddddddddddd', titulo: 'Reunión', fecha_inicio: '2026-10-15T16:00:00+00:00', fecha_fin: null, contenido: null, calendar_event_id: null, updated_at: '2026-10-15T06:00:00+00:00' };
const ITEM_C = { ...ITEM_A, id: 'cccccccc-1111-4222-8333-444444444444', titulo: 'Reunión', calendar_event_id: 'evt-existente', updated_at: '2026-10-10T13:00:00+00:00' };
const ITEM_NOTA = { ...ITEM_A, id: 'dddddddd-1111-4222-8333-444444444444', tipo: 'nota', calendar_event_id: 'evt-viejo' };
const ITEM_NOTA_SIN_EVENTO = { ...ITEM_NOTA, id: 'dadadada-1111-4222-8333-444444444444', calendar_event_id: null };
const ITEM_HECHO = { ...ITEM_A, id: 'eeeeeeee-1111-4222-8333-444444444444', estado: 'hecho' };
const ITEM_HECHO_CON_EVENTO = { ...ITEM_HECHO, id: 'e1e1e1e1-1111-4222-8333-444444444444', calendar_event_id: 'evt-hecho' };
const ITEM_SIN_FECHA = { ...ITEM_A, id: 'ffffffff-1111-4222-8333-444444444444', fecha_inicio: null };

async function main() {
  console.log('Decisión: sincronizar u omitir');
  {
    afirmar('un evento pendiente con fecha se sincroniza', comun.clasificar(ITEM_A).accion === 'sincronizar');
    afirmar('una nota que nunca fue evento en Calendar se omite', comun.clasificar(ITEM_NOTA_SIN_EVENTO).accion === 'omitir' && comun.clasificar(ITEM_NOTA_SIN_EVENTO).motivo.includes('evento'));
    afirmar('una cita convertida en alarma, tarea o nota (pendiente y con evento en Calendar) borra su evento: ya no es una cita', ['tarea', 'nota'].every((t) => comun.clasificar({ ...ITEM_NOTA, tipo: t }).accion === 'borrar') && comun.clasificar(ITEM_NOTA).motivo.includes('ya no es una cita'));
    afirmar('… pero lo ya hecho conserva su evento como registro', comun.clasificar({ ...ITEM_NOTA, estado: 'hecho' }).accion === 'omitir');
    afirmar('un evento hecho se omite', comun.clasificar(ITEM_HECHO).accion === 'omitir' && comun.clasificar(ITEM_HECHO).motivo.includes('pendiente'));
    afirmar('un evento sin fecha de inicio se omite', comun.clasificar(ITEM_SIN_FECHA).accion === 'omitir' && comun.clasificar(ITEM_SIN_FECHA).motivo.includes('fecha'));
    afirmar('una fecha que no es ISO se omite', comun.clasificar({ ...ITEM_A, fecha_inicio: 'mañana' }).accion === 'omitir');
    afirmar('un evento archivado que nunca llegó a Calendar se omite (no hay nada que borrar)', comun.clasificar({ ...ITEM_A, estado: 'archivado' }).accion === 'omitir' && comun.clasificar({ ...ITEM_A, estado: 'archivado', calendar_event_id: '' }).accion === 'omitir');
    afirmar('un evento archivado con evento en Calendar se borra (cancelado por el usuario)', comun.clasificar({ ...ITEM_C, estado: 'archivado' }).accion === 'borrar' && comun.clasificar({ ...ITEM_C, estado: 'archivado' }).motivo.includes('cancelado'));
    afirmar('solo un item ARCHIVADO se borra: pendiente, hecho o con otro tipo de estado, nunca', ['pendiente', 'hecho', undefined, null, 'otro'].every((e) => comun.clasificar({ ...ITEM_C, estado: e }).accion !== 'borrar'));
    afirmar('un evento completado (hecho) conserva su evento en Calendar como registro', comun.clasificar({ ...ITEM_C, estado: 'hecho' }).accion === 'omitir');
    afirmar('archivar una nota que fue evento también borra su evento antiguo', comun.clasificar({ ...ITEM_NOTA, estado: 'archivado' }).accion === 'borrar');
    afirmar('un id de evento raro no se usa para borrar (va en la URL)', ['a/b', 'a b', '../x', 'ab', 'x'.repeat(2000), 'a?b=c', 5, {}].every((id) => comun.clasificar({ ...ITEM_C, estado: 'archivado', calendar_event_id: id }).accion !== 'borrar'));
  }

  console.log('Identificador y cuerpo del evento');
  {
    afirmar('el id del evento son los 32 hex del UUID', comun.idEventoDe(ITEM_A.id) === ID_A);
    afirmar('el id cumple las reglas de Google (a-v y 0-9, de 5 a 1024)', /^[0-9a-v]{5,1024}$/.test(comun.idEventoDe(ITEM_B.id)));
    afirmar('el mismo item da siempre el mismo id', comun.idEventoDe(ITEM_A.id) === comun.idEventoDe(ITEM_A.id.toUpperCase()));
    let error = null;
    try {
      comun.idEventoDe('no-es-un-uuid');
    } catch (e) {
      error = e;
    }
    afirmar('un id que no es UUID es un error', error !== null && error.message.includes('no es un UUID'));

    const c = comun.cuerpoEvento(ITEM_A, CONFIG);
    afirmar('título y descripción', c.summary === 'Dentista' && c.description === 'Llevar la tarjeta');
    afirmar('inicio y fin con zona de Madrid', c.start.dateTime === '2026-10-15T08:00:00.000Z' && c.end.dateTime === '2026-10-15T09:00:00.000Z' && c.start.timeZone === 'Europe/Madrid' && c.end.timeZone === 'Europe/Madrid');
    afirmar('un aviso emergente de 30 minutos, sin avisos por defecto', JSON.stringify(c.reminders) === JSON.stringify({ useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] }));
    afirmar('el id del item viaja como propiedad privada', c.extendedProperties.private.item_id === ITEM_A.id);
    const sinFin = comun.cuerpoEvento(ITEM_B, CONFIG);
    afirmar('sin fecha_fin dura 60 minutos', sinFin.end.dateTime === '2026-10-15T17:00:00.000Z');
    afirmar('sin contenido, la descripción va vacía (para poder borrarla en un PATCH)', sinFin.description === '');
    const finMalo = comun.cuerpoEvento({ ...ITEM_A, fecha_fin: '2026-10-15T07:00:00+00:00' }, CONFIG);
    afirmar('un fin anterior al inicio se corrige', finMalo.end.dateTime === '2026-10-15T09:00:00.000Z');
    const asig = comun.cuerpoEvento(ITEM_C, CONFIG);
    afirmar('la descripción es el contenido, sin nada más', asig.description === 'Llevar la tarjeta');
    const otroAviso = comun.cuerpoEvento(ITEM_A, { ...CONFIG, aviso_min: 5 });
    afirmar('los minutos de aviso salen de la configuración', otroAviso.reminders.overrides[0].minutes === 5);
  }

  console.log('Aviso urgente por WhatsApp');
  {
    const aviso = (inicio, referencia, aviso_min = 30) => comun.calcularAviso({ fecha_inicio: inicio, referencia, aviso_min });
    afirmar('mismo día con margen: avisa a la hora del aviso', aviso('2026-10-15T16:00:00Z', '2026-10-15T12:00:00Z') === '2026-10-15T15:30:00.000Z', String(aviso('2026-10-15T16:00:00Z', '2026-10-15T12:00:00Z')));
    afirmar('otro día lejano: no hace falta', aviso('2026-10-16T08:00:00Z', '2026-10-14T10:00:00Z') === null);
    afirmar('otro día con mucho margen: no hace falta', aviso('2026-10-15T08:00:00Z', '2026-10-14T18:00:00Z') === null);
    afirmar('cruce de medianoche con menos de 2 horas: avisa', aviso('2026-10-14T22:30:00Z', '2026-10-14T21:00:00Z') === '2026-10-14T22:00:00.000Z', String(aviso('2026-10-14T22:30:00Z', '2026-10-14T21:00:00Z')));
    afirmar('cruce de medianoche con 3 horas de margen: no hace falta', aviso('2026-10-15T00:30:00Z', '2026-10-14T21:00:00Z') === null);
    afirmar('justo 2 horas hasta el aviso (otro día): no es "menos de 2 horas"', aviso('2026-10-14T23:30:00Z', '2026-10-14T21:00:00Z') === null);
    afirmar('un minuto menos de 2 horas (otro día): avisa', aviso('2026-10-14T23:29:00Z', '2026-10-14T21:00:00Z') === '2026-10-14T22:59:00.000Z', String(aviso('2026-10-14T23:29:00Z', '2026-10-14T21:00:00Z')));
    afirmar('la hora del aviso ya pasó: avisa en el acto', aviso('2026-10-15T12:10:00Z', '2026-10-15T12:00:00Z') === '2026-10-15T12:00:00.000Z', String(aviso('2026-10-15T12:10:00Z', '2026-10-15T12:00:00Z')));
    afirmar('el evento ya ha empezado: no avisa', aviso('2026-10-15T11:00:00Z', '2026-10-15T12:00:00Z') === null);
    afirmar('empieza justo ahora: no avisa', aviso('2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z') === null);
    afirmar('día del cambio de hora (octubre): mismo día en hora de Madrid', aviso('2026-10-25T07:00:00Z', '2026-10-24T22:30:00Z') === '2026-10-25T06:30:00.000Z', String(aviso('2026-10-25T07:00:00Z', '2026-10-24T22:30:00Z')));
    afirmar('el aviso usa los minutos de la configuración', aviso('2026-10-15T16:00:00Z', '2026-10-15T12:00:00Z', 60) === '2026-10-15T15:00:00.000Z');
    afirmar('fechas inválidas: null', aviso('x', '2026-10-15T12:00:00Z') === null && aviso('2026-10-15T16:00:00Z', 'x') === null);
    afirmar('con offset en lugar de UTC se calcula igual', aviso('2026-10-15T18:00:00+02:00', '2026-10-15T14:00:00+02:00') === '2026-10-15T15:30:00.000Z');
    afirmar('día natural de Madrid', comun.diaMadrid(Date.parse('2026-10-14T22:30:00Z')) === '2026-10-15' && comun.diaMadrid(Date.parse('2026-10-14T21:59:00Z')) === '2026-10-14');
  }

  console.log('Planificar sincronización');
  {
    const planificar = (filas) => correr(nodo('planificar-sincronizacion.js', true), { nodos: { Configuración: [{ config: CONFIG }], 'Leer pendientes': filas } });
    const plan = await planificar([ITEM_A, ITEM_C, ITEM_NOTA, ITEM_HECHO, ITEM_SIN_FECHA, {}]);
    afirmar('solo los eventos sincronizables, en orden', plan.length === 2 && plan[0].item_id === ITEM_A.id && plan[1].item_id === ITEM_C.id, JSON.stringify(plan.map((p) => p.item_id)));
    afirmar('un evento nuevo se crea con POST', plan[0].accion === 'crear' && plan[0].metodo === 'POST' && plan[0].url === API, plan[0].url);
    afirmar('la creación lleva el id derivado del item y el cuerpo completo', plan[0].cuerpo.id === ID_A && plan[0].cuerpo.summary === 'Dentista' && plan[0].id_evento === ID_A);
    afirmar('un evento que ya existe se actualiza con PATCH sobre su id', plan[1].accion === 'actualizar' && plan[1].metodo === 'PATCH' && plan[1].url === `${API}/evt-existente`, plan[1].url);
    afirmar('la actualización no lleva id en el cuerpo', !('id' in plan[1].cuerpo));
    afirmar('cada petición recuerda el item y su updated_at', plan[0].updated_at === ITEM_A.updated_at && plan[0].fecha_inicio === ITEM_A.fecha_inicio);
    const vacio = await planificar([{}]);
    afirmar('sin pendientes no emite nada (la rama no se ejecuta)', vacio.length === 0);
    const soloOmitidos = await planificar([ITEM_NOTA]);
    afirmar('solo omitidos: no emite nada hacia Google', soloOmitidos.length === 0);
    const codificado = await correr(nodo('planificar-sincronizacion.js', true), { nodos: { Configuración: [{ config: { ...CONFIG, calendar_id: 'a b@group.calendar.google.com' } }], 'Leer pendientes': [{ ...ITEM_C, calendar_event_id: 'x/y' }] } });
    afirmar('el calendario y el id del evento se codifican en la URL', codificado[0].url === 'https://www.googleapis.com/calendar/v3/calendars/a%20b%40group.calendar.google.com/events/x%2Fy', codificado[0].url);
  }

  console.log('Planificar omitidos');
  {
    const omitidos = (filas) => correr(nodo('planificar-omitidos.js', true), { nodos: { Configuración: [{ config: CONFIG }], 'Leer pendientes': filas } });
    const o = await omitidos([ITEM_A, ITEM_NOTA_SIN_EVENTO, ITEM_HECHO_CON_EVENTO, ITEM_SIN_FECHA, {}]);
    afirmar('solo los que no se sincronizan', o.length === 3 && o.map((x) => x.etiqueta.split(' ')[1]).join() === [ITEM_NOTA_SIN_EVENTO.id, ITEM_HECHO_CON_EVENTO.id, ITEM_SIN_FECHA.id].join(), o.map((x) => x.etiqueta).join(' | '));
    afirmar('limpian la marca con una condición sobre updated_at', o[0].metodo === 'PATCH' && o[0].cuerpo.calendar_pendiente === false && Object.keys(o[0].cuerpo).length === 1 && o[0].url === `${BASE}/items?id=eq.${ITEM_NOTA_SIN_EVENTO.id}&updated_at=eq.2026-10-10T12%3A00%3A00.123456%2B00%3A00`, o[0].url);
    afirmar('la etiqueta avisa de que el evento sigue en Calendar (lo hecho conserva su evento)', o[1].etiqueta.includes('el evento sigue en Calendar') && !o[0].etiqueta.includes('el evento sigue'), o.map((x) => x.etiqueta).join(' | '));
    afirmar('sin omitidos no emite nada', (await omitidos([ITEM_A, {}])).length === 0);

    // Cada pendiente lo atiende exactamente una rama
    const CANCELADO = { ...ITEM_C, id: 'babababa-1111-4222-8333-444444444444', estado: 'archivado', calendar_event_id: 'evt-a-borrar' };
    const todos = [ITEM_A, ITEM_B, ITEM_C, ITEM_NOTA, ITEM_NOTA_SIN_EVENTO, ITEM_HECHO, ITEM_SIN_FECHA, { ...ITEM_A, id: 'abababab-1111-4222-8333-444444444444', estado: 'archivado' }, CANCELADO];
    const google = await correr(nodo('planificar-sincronizacion.js', true), { nodos: { Configuración: [{ config: CONFIG }], 'Leer pendientes': todos } });
    const resto = await omitidos(todos);
    const borrar = await correr(nodo('planificar-borrados.js', true), { nodos: { Configuración: [{ config: CONFIG }], 'Leer pendientes': todos } });
    const atendidos = [...google.map((g) => g.item_id), ...resto.map((x) => x.etiqueta.split(' ')[1]), ...borrar.map((b) => b.item_id)];
    afirmar('cada item pendiente lo atiende exactamente una rama (sincronizar, omitir o borrar)', atendidos.length === todos.length && new Set(atendidos).size === todos.length && todos.every((t) => atendidos.includes(t.id)), atendidos.join());
    afirmar('el cancelado y la cita convertida en otra cosa solo los atiende la rama de borrados', borrar.length === 2 && borrar.map((b) => b.item_id).sort().join() === [CANCELADO.id, ITEM_NOTA.id].sort().join() && !google.some((g) => g.item_id === ITEM_NOTA.id) && !resto.some((x) => x.etiqueta.includes(ITEM_NOTA.id)) && !google.some((g) => g.item_id === CANCELADO.id) && !resto.some((x) => x.etiqueta.includes(CANCELADO.id)));
  }

  console.log('Planificar borrados');
  {
    const CANCELADO = { ...ITEM_C, estado: 'archivado', calendar_event_id: 'evt-a-borrar', updated_at: '2026-10-11T09:30:00.654321+00:00' };
    const borrados = (filas) => correr(nodo('planificar-borrados.js', true), { nodos: { Configuración: [{ config: CONFIG }], 'Leer pendientes': filas } });
    const b = await borrados([ITEM_A, CANCELADO, ITEM_HECHO, ITEM_NOTA_SIN_EVENTO, {}]);
    afirmar('solo emite los items archivados con evento en Calendar', b.length === 1 && b[0].item_id === CANCELADO.id, JSON.stringify(b));
    const convertida = await borrados([ITEM_NOTA]);
    afirmar('también emite el de una cita pendiente que ya no es cita (alarma o tarea)', convertida.length === 1 && convertida[0].item_id === ITEM_NOTA.id && convertida[0].url === `${API}/evt-viejo`, JSON.stringify(convertida));
    afirmar('DELETE a la URL del evento del calendario de la configuración, sin cuerpo', b[0].metodo === 'DELETE' && b[0].url === `${API}/evt-a-borrar` && !('cuerpo' in b[0]), JSON.stringify(b[0]));
    afirmar('lleva el updated_at leído y el id del evento', b[0].updated_at === CANCELADO.updated_at && b[0].id_evento === 'evt-a-borrar');
    afirmar('nunca borra el evento de una cita pendiente, de algo completado o de algo sin evento', (await borrados([ITEM_A, ITEM_C, ITEM_HECHO, { ...ITEM_HECHO, calendar_event_id: 'evt-hecho' }, { ...ITEM_NOTA, estado: 'hecho' }, { ...ITEM_A, estado: 'archivado' }])).length === 0);
    afirmar('un id de evento raro se codifica y, si no es seguro, no se borra', (await borrados([{ ...CANCELADO, calendar_event_id: 'a/b?x' }])).length === 0);
    afirmar('sin items no emite nada (la rama no se ejecuta)', (await borrados([{}])).length === 0);
  }

  console.log('Registrar borrados');
  {
    const CANCELADO = { ...ITEM_C, estado: 'archivado', calendar_event_id: 'evt-a-borrar', updated_at: '2026-10-11T09:30:00.654321+00:00' };
    const OTRO = { ...CANCELADO, id: 'cdcdcdcd-1111-4222-8333-444444444444', calendar_event_id: 'evt-otro', updated_at: '2026-10-11T09:31:00+00:00' };
    const plan = [CANCELADO, OTRO].map((it) => ({ accion: 'borrar', metodo: 'DELETE', item_id: it.id, updated_at: it.updated_at, id_evento: it.calendar_event_id }));
    const reg = (respuestas, p = plan) => correr(nodo('registrar-borrados.js'), { input: respuestas, nodos: { Configuración: [{ config: CONFIG }], 'Planificar borrados': p } });
    const ok = await reg([{ statusCode: 204, body: '' }, { statusCode: 204, body: '' }]);
    afirmar('un DELETE correcto (204) hace que el item se olvide del evento y de su aviso', ok.length === 2 && JSON.stringify(ok[0].cuerpo) === '{"calendar_event_id":null,"calendar_pendiente":false,"aviso_whatsapp_en":null,"aviso_whatsapp_enviado_at":null}' && ok[0].etiqueta.startsWith('borrado'));
    afirmar('la escritura lleva la condición sobre updated_at del item (si cambió mientras tanto, sigue pendiente)', ok[0].url === `${BASE}/items?id=eq.${CANCELADO.id}&updated_at=eq.2026-10-11T09%3A30%3A00.654321%2B00%3A00` && ok[0].metodo === 'PATCH' && ok[0].prefer === 'return=minimal', ok[0].url);
    const gone = await reg([{ statusCode: 404, body: {} }, { statusCode: 410, body: {} }]);
    afirmar('un 404 o un 410 (ya no existía, se borró a mano) también cuenta como hecho', gone.length === 2 && gone.every((g) => g.etiqueta.startsWith('ya no existía')));
    const mixto = await reg([{ statusCode: 500, body: 'error' }, { statusCode: 204, body: '' }]);
    afirmar('un fallo aislado no impide anotar el resto y se reintenta al minuto siguiente', mixto.length === 1 && mixto[0].url.includes(OTRO.id));
    await lanza('si no se borra ninguno es un error (la ejecución sale en rojo)', reg([{ statusCode: 403, body: { error: 'x' } }, { statusCode: 401, body: {} }]), '2 fallo(s)');
    const red = await reg([{ error: { message: 'ECONNRESET' } }, { statusCode: 204, body: '' }]);
    afirmar('un error de red se trata como fallo', red.length === 1);
    afirmar('sin respuestas no hace nada', (await reg([], [])).length === 0);
  }

  console.log('Registrar');
  {
    const registrar = (plan, respuestas) => correr(nodo('registrar.js', true), { input: respuestas, nodos: { Configuración: [{ config: CONFIG }], 'Planificar sincronización': plan } });
    const crearA = { accion: 'crear', item_id: ITEM_A.id, updated_at: ITEM_A.updated_at, id_evento: ID_A, fecha_inicio: ITEM_A.fecha_inicio };
    const crearB = { accion: 'crear', item_id: ITEM_B.id, updated_at: ITEM_B.updated_at, id_evento: 'idb', fecha_inicio: ITEM_B.fecha_inicio };
    const actC = { accion: 'actualizar', item_id: ITEM_C.id, updated_at: ITEM_C.updated_at, id_evento: 'evt-existente', fecha_inicio: ITEM_C.fecha_inicio };
    const guardia = (item) => `${BASE}/items?id=eq.${item.id}&updated_at=eq.${encodeURIComponent(item.updated_at)}`;

    const ok = await registrar([crearA, crearB, actC], [{ statusCode: 200, body: { id: ID_A } }, { statusCode: 200, body: { id: 'idb' } }, { statusCode: 200, body: {} }]);
    afirmar('un éxito limpia la marca y guarda el id del evento', ok[0].cuerpo.calendar_event_id === ID_A && ok[0].cuerpo.calendar_pendiente === false && ok[0].metodo === 'PATCH' && ok[0].prefer === 'return=minimal');
    afirmar('con la condición sobre updated_at del item', ok[0].url === guardia(ITEM_A) && ok[1].url === guardia(ITEM_B) && ok[2].url === guardia(ITEM_C), ok[0].url);
    afirmar('un evento de otro día lejano no lleva aviso urgente', ok[0].cuerpo.aviso_whatsapp_en === null && ok[0].cuerpo.aviso_whatsapp_enviado_at === null);
    afirmar('un evento del mismo día lleva el aviso urgente, 30 minutos antes', ok[1].cuerpo.aviso_whatsapp_en === '2026-10-15T15:30:00.000Z', String(ok[1].cuerpo.aviso_whatsapp_en));
    afirmar('sin id en la respuesta de Google se usa el derivado', ok[2].cuerpo.calendar_event_id === 'evt-existente');
    afirmar('una escritura por evento y en el mismo orden', ok.length === 3 && ok[0].etiqueta.startsWith('crear:') && ok[2].etiqueta.startsWith('actualizar:'));
    const creado = await registrar([crearA], [{ statusCode: 201, body: { id: 'otro-id-de-google' } }]);
    afirmar('201: se guarda el id que devuelve Google', creado[0].cuerpo.calendar_event_id === 'otro-id-de-google');

    const dup = await registrar([crearA], [{ statusCode: 409, body: { error: { message: 'identifier already exists' } } }]);
    afirmar('409 al crear: se anota el id y el item sigue pendiente', dup.length === 1 && dup[0].cuerpo.calendar_event_id === ID_A && !('calendar_pendiente' in dup[0].cuerpo) && Object.keys(dup[0].cuerpo).length === 1);
    const perdido = await registrar([actC], [{ statusCode: 404, body: { error: { message: 'Not Found' } } }]);
    afirmar('404 al actualizar: se olvida el id y el item sigue pendiente (se recreará)', perdido.length === 1 && perdido[0].cuerpo.calendar_event_id === null && !('calendar_pendiente' in perdido[0].cuerpo));
    const cuatro = await registrar([actC], [{ statusCode: 409, body: {} }, ].slice(0, 1)).catch((e) => e);
    afirmar('un 409 al actualizar es un fallo, no se interpreta como duplicado', cuatro instanceof Error && cuatro.message.includes('ningún evento sincronizado'));

    await lanza('todos fallan: la ejecución sale en rojo con el motivo', registrar([crearA, actC], [{ statusCode: 401, body: { error: { message: 'Invalid Credentials' } } }, { statusCode: 500, body: 'boom' }]), 'Invalid Credentials');
    await lanza('un error de red sin código de estado también cuenta', registrar([crearA], [{ error: { message: 'ECONNRESET' } }]), 'ECONNRESET');
    const mixto = await registrar([crearA, crearB], [{ statusCode: 500, body: {} }, { statusCode: 200, body: { id: 'idb' } }]);
    afirmar('un fallo aislado no impide guardar los éxitos y se reintenta al minuto siguiente', mixto.length === 1 && mixto[0].url === guardia(ITEM_B));
    const vacioReg = await registrar([], []);
    afirmar('sin respuestas no hace nada', vacioReg.length === 0);
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const texto = JSON.stringify(flujo);
    const trabajo = flujo.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
    const nombres = flujo.nodes.map((n) => n.name);
    const por = (n) => flujo.nodes.find((x) => x.name === n);

    afirmar('12 nodos de trabajo y 6 notas', trabajo.length === 12 && flujo.nodes.length === 18, `${trabajo.length}/${flujo.nodes.length}`);
    afirmar('nombres e ids únicos', new Set(nombres).size === nombres.length && new Set(flujo.nodes.map((n) => n.id)).size === flujo.nodes.length);
    afirmar('las conexiones solo nombran nodos existentes', Object.entries(flujo.connections).every(([origen, c]) => nombres.includes(origen) && c.main.every((salida) => salida.every((d) => nombres.includes(d.node)))));
    afirmar('sin claves dentro: las credenciales solo se referencian por nombre', credencialesSoloPorNombre(flujo) && !/sb_secret_|AIza|ya29\./.test(texto));
    afirmar('zona horaria de Madrid', flujo.settings.timezone === 'Europe/Madrid');
    afirmar('el JSON sobrevive a un ida y vuelta', JSON.stringify(JSON.parse(texto)) === texto);

    afirmar('Programación: cada minuto', JSON.stringify(por('Programación').parameters) === '{"rule":{"interval":[{"field":"minutes","minutesInterval":1}]}}' && por('Programación').type === 'n8n-nodes-base.scheduleTrigger');
    afirmar('hay un disparador manual para probar', por('Disparador manual').type === 'n8n-nodes-base.manualTrigger' && flujo.connections['Disparador manual'].main[0][0].node === 'Configuración' && flujo.connections['Programación'].main[0][0].node === 'Configuración');
    const pend = por('Leer pendientes');
    afirmar('Leer pendientes: solo los marcados, los más antiguos primero, con el lote de la configuración', pend.parameters.url.includes('calendar_pendiente=eq.true') && pend.parameters.url.includes('order=updated_at.asc') && pend.parameters.url.includes('limit={{ $(\'Configuración\').first().json.config.lote }}') && pend.alwaysOutputData === true);
    afirmar('Leer pendientes: pide updated_at y calendar_event_id', pend.parameters.url.includes('calendar_event_id') && pend.parameters.url.includes('updated_at'));
    afirmar('Leer pendientes sale a las tres ramas', flujo.connections['Leer pendientes'].main[0].map((d) => d.node).join() === 'Planificar sincronización,Planificar omitidos,Planificar borrados');
    const del = por('Borrar en Google Calendar');
    afirmar('Borrar en Google Calendar: DELETE a la URL de la acción, SIN cuerpo, con la credencial de Google Calendar, respuesta completa y sin fallar ante HTTP', del.parameters.method === 'DELETE' && del.parameters.url === '={{ $json.url }}' && del.parameters.sendBody === undefined && del.parameters.nodeCredentialType === 'googleCalendarOAuth2Api' && del.parameters.options.response.response.fullResponse === true && del.parameters.options.response.response.neverError === true && del.onError === 'continueRegularOutput');
    afirmar('la rama de borrados va Planificar borrados -> Borrar en Google Calendar -> Registrar borrados -> Escribir en Supabase', flujo.connections['Planificar borrados'].main[0][0].node === 'Borrar en Google Calendar' && flujo.connections['Borrar en Google Calendar'].main[0][0].node === 'Registrar borrados' && flujo.connections['Registrar borrados'].main[0][0].node === 'Escribir en Supabase');
    afirmar('el único DELETE del flujo es el de esa rama', flujo.nodes.filter((n) => n.parameters?.method === 'DELETE').map((n) => n.name).join() === 'Borrar en Google Calendar');
    afirmar('las notas ya no dicen que no se borran eventos y explican la excepción', flujo.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote' && n.parameters.content.includes('archivado') && n.parameters.content.includes('única excepción')) && !flujo.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote' && n.parameters.content.includes('no borra eventos de Calendar.**')));

    const g = por('Google Calendar');
    afirmar('Google Calendar: método y URL por expresión, con cuerpo', g.parameters.method === '={{ $json.metodo }}' && g.parameters.url === '={{ $json.url }}' && g.parameters.sendBody === true && g.parameters.jsonBody === '={{ JSON.stringify($json.cuerpo) }}');
    afirmar('Google Calendar: credencial predefinida de Google Calendar', g.parameters.authentication === 'predefinedCredentialType' && g.parameters.nodeCredentialType === 'googleCalendarOAuth2Api');
    afirmar('Google Calendar: respuesta completa y sin fallar ante errores HTTP', g.parameters.options.response.response.fullResponse === true && g.parameters.options.response.response.neverError === true && g.onError === 'continueRegularOutput');
    const esc = por('Escribir en Supabase');
    afirmar('Escribir en Supabase: método, URL y Prefer por expresión', esc.parameters.method === '={{ $json.metodo }}' && esc.parameters.headerParameters.parameters[0].value === '={{ $json.prefer }}' && esc.parameters.nodeCredentialType === 'supabaseApi' && esc.onError === 'continueRegularOutput');
    afirmar('las dos ramas terminan en Escribir en Supabase', flujo.connections.Registrar.main[0][0].node === 'Escribir en Supabase' && flujo.connections['Planificar omitidos'].main[0][0].node === 'Escribir en Supabase');
    afirmar('la rama de Google va por encima de la de omitidos (se ejecuta antes)', por('Planificar sincronización').position[1] < por('Planificar omitidos').position[1]);

    const conComun = ['Planificar sincronización', 'Registrar', 'Planificar omitidos'].map((n) => por(n).parameters.jsCode);
    afirmar('las funciones comunes están dentro de cada nodo que las usa, sin marcador', conComun.every((c) => c.includes('function clasificar') && c.includes('function calcularAviso') && !c.includes('/*__COMUN__*/')));
    afirmar('Configuración conserva los marcadores que hay que editar', por('Configuración').parameters.jsCode.includes('TU-PROYECTO') && por('Configuración').parameters.jsCode.includes('TU-CALENDARIO'));
    afirmar('las notas explican qué hacer antes de ejecutar', flujo.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote' && n.parameters.content.includes('Antes de ejecutar') && n.parameters.content.includes('CALENDAR_ID')));
  }

  console.log('Configuración');
  {
    const codigo = nodo('configuracion.js');
    await lanza('rechaza la URL de ejemplo', correr(codigo), 'SUPABASE_URL');
    const conUrl = codigo.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co/');
    await lanza('rechaza el calendario de ejemplo', correr(conUrl), 'CALENDAR_ID');
    const buena = conUrl.replace('TU-CALENDARIO@group.calendar.google.com', 'cal123@group.calendar.google.com');
    const [c] = await correr(buena);
    afirmar('acepta valores válidos y quita la barra final', c.config.supabase_url === 'https://abc.supabase.co' && c.config.calendar_id === 'cal123@group.calendar.google.com');
    afirmar('valores por defecto: 30 minutos, 60 de duración, lote de 20, zona de Madrid', c.config.aviso_min === 30 && c.config.duracion_min === 60 && c.config.lote === 20 && c.config.zona === 'Europe/Madrid');
    await lanza('rechaza un aviso de más de 4 semanas', correr(buena.replace('const AVISO_MIN = 30;', 'const AVISO_MIN = 50000;')), 'AVISO_MIN');
    await lanza('rechaza un lote no positivo', correr(buena.replace('const LOTE = 20;', 'const LOTE = 0;')), 'LOTE');
    await lanza('rechaza el calendario "primary"', correr(buena.replace('cal123@group.calendar.google.com', 'primary')), 'CALENDAR_ID');
  }

  console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} con fallo.`);
  if (fallan.length) {
    console.log('Fallan:\n- ' + fallan.join('\n- '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
