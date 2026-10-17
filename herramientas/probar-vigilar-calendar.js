// Pruebas sin red ni coste del flujo "Vigilar Calendar" (flujos/vigilar-calendar.json).
// Ejecuta el código real de herramientas/flujo-vigilar-calendar/*.js con entradas simuladas.
// Uso: node herramientas/probar-vigilar-calendar.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-vigilar-calendar.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const nodo = (f) => leer('flujo-vigilar-calendar', f);

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

const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012', graph_version: 'v26.0', calendar_id: 'abc@group.calendar.google.com', ventana_horas: 23, duracion_min: 60, margen_min: 5, max_lineas: 15 };

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }), all: () => [{ json: { config: nodos.config ?? CONFIG } }] };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { nodos = {}, env = { WHATSAPP_NUMERO_PERMITIDO: '34600111222' } } = {}) {
  const fn = new AsyncFunction('$input', '$', '$env', codigo);
  const salida = await fn({ all: () => [], first: () => undefined }, simular(nodos), env);
  return salida.map((x) => x.json);
}

// --- Datos de prueba (fechas relativas a ahora, para que no caduquen) ---
const H = 3600000;
const T0 = Math.ceil((Date.now() + 3 * 86400000) / H) * H; // dentro de 3 días, en punto
const iso = (ms) => new Date(ms).toISOString();
const HACE_UN_RATO = iso(Date.now() - 2 * H); // cuándo se guardaron los items de prueba
const ITEMS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', titulo: 'Dentista', contenido: null, estado: 'pendiente', fecha_inicio: iso(T0), fecha_fin: iso(T0 + H), calendar_event_id: 'ev1', calendar_pendiente: false, updated_at: HACE_UN_RATO },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', titulo: 'Reunión', contenido: null, estado: 'pendiente', fecha_inicio: iso(T0 + 5 * H), fecha_fin: iso(T0 + 6 * H), calendar_event_id: 'ev2', calendar_pendiente: false, updated_at: HACE_UN_RATO },
  { id: 'aaaaaaaa-0000-4000-8000-000000000003', titulo: 'Cena', contenido: null, estado: 'hecho', fecha_inicio: iso(T0 + 8 * H), fecha_fin: iso(T0 + 9 * H), calendar_event_id: 'ev3', calendar_pendiente: false, updated_at: HACE_UN_RATO },
];
const AHORA_G = iso(Date.now() - 60000); // un cambio hecho hace un minuto en Google (posterior a los items)
const ev = (id, extra = {}) => ({ id, status: 'confirmed', summary: 'Evento', start: { dateTime: iso(T0) }, end: { dateTime: iso(T0 + H) }, updated: AHORA_G, ...extra });
const comparar = (eventos, { items = ITEMS, estado = [{ valor: { ultima: iso(Date.now() - 15 * 60000) } }], lista = {}, config } = {}) =>
  correr(nodo('comparar.js'), { nodos: { 'Leer estado': estado, 'Leer eventos de la base': items, 'Leer eventos de Calendar': [{ items: eventos, ...lista }], ...(config ? { config } : {}) } });
const registro = (w) => w.find((x) => x.etiqueta.startsWith('registrar'));

async function main() {
  console.log('Configuración');
  {
    const base = nodo('configuracion.js');
    await lanza('sin poner Supabase, lanza', correr(base), 'SUPABASE_URL');
    const s = base.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co');
    await lanza('sin el Phone number ID, lanza', correr(s), 'PHONE_NUMBER_ID');
    const p = s.replace('TU-PHONE-NUMBER-ID', '123456789012');
    await lanza('sin el calendario, lanza', correr(p), 'CALENDAR_ID');
    const [c] = await correr(p.replace('TU-CALENDARIO@group.calendar.google.com', 'abc@group.calendar.google.com'));
    afirmar('con todo puesto devuelve la configuración con los valores por defecto', c.config.calendar_id === 'abc@group.calendar.google.com' && c.config.ventana_horas === 23 && c.config.duracion_min === 60 && c.config.margen_min === 5 && c.config.max_lineas === 15);
  }

  console.log('Comparar: seguridad y primera vez');
  {
    const primera = await comparar([ev('x1', { summary: 'Creado antes de activar' })], { estado: [{}] });
    afirmar('la primera vez solo guarda la hora de la pasada: no importa ni avisa de nada', primera.length === 1 && primera[0].etiqueta === 'estado del vigilante' && primera[0].cuerpo.clave === 'calendar' && typeof primera[0].cuerpo.valor.ultima === 'string');
    afirmar('el estado se guarda con upsert por clave', primera[0].url.endsWith('/vigilantes_estado?on_conflict=clave') && primera[0].prefer === 'resolution=merge-duplicates,return=minimal' && primera[0].metodo === 'POST');
    await lanza('si Supabase llega a su tope de filas, se para', comparar([], { items: Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, titulo: 'x', estado: 'pendiente' })) }), 'Supabase devolvió 1000 eventos');
    await lanza('si Google devuelve más de una página, se para (la hora no avanza)', comparar([], { lista: { nextPageToken: 'mas' } }), 'más de una página');
    const nada = await comparar([]);
    afirmar('sin cambios en Calendar solo se guarda el estado', nada.length === 1 && nada[0].etiqueta === 'estado del vigilante');
    afirmar('la tabla vacía (Supabase devuelve un item vacío) no rompe', (await comparar([], { items: [{}] })).length === 1);
  }

  console.log('Comparar: lo que hace la propia secretaria no es un cambio');
  {
    const propio = await comparar([ev('ev1', { summary: 'Dentista', start: { dateTime: iso(T0) }, end: { dateTime: iso(T0 + H) } })]);
    afirmar('un evento igual al item (lo acaba de escribir «Sincronizar Calendar») se ignora', propio.length === 1);
    const pendiente = await comparar([ev('ev1', { summary: 'Dentista', start: { dateTime: iso(T0 + 2 * H) }, end: { dateTime: iso(T0 + 3 * H) } })], { items: ITEMS.map((i) => (i.id.endsWith('1') ? { ...i, calendar_pendiente: true } : i)) });
    afirmar('si la secretaria está a punto de escribir en Calendar (calendar_pendiente), su valor manda', pendiente.length === 1);
    const antiguo = await comparar([ev('ev1', { summary: 'Dentista', start: { dateTime: iso(T0 + 2 * H) }, end: { dateTime: iso(T0 + 3 * H) }, updated: iso(Date.now() - 3 * H) })]);
    afirmar('si el item cambió después que el evento (p. ej. lo moviste por WhatsApp), su valor manda', antiguo.length === 1);
    const suyo = await comparar([ev('cualquiera', { extendedProperties: { private: { item_id: 'bbbbbbbb-0000-4000-8000-000000000009' } } })]);
    afirmar('un evento con la marca de la secretaria cuyo item no se vigila no se toma por creado a mano', suyo.length === 1);
    const hecho = await comparar([ev('ev3', { summary: 'Cena', start: { dateTime: iso(T0 + 10 * H) }, end: { dateTime: iso(T0 + 11 * H) } })]);
    afirmar('un evento ya completado (hecho) no se toca aunque se mueva', hecho.length === 1);
    const periodico = await comparar([ev('rec1', { recurrence: ['RRULE:FREQ=WEEKLY'] }), ev('rec1_20261020', { recurringEventId: 'rec1' })]);
    afirmar('los eventos periódicos no se vigilan', periodico.length === 1);
    const todoElDia = await comparar([ev('dia1', { start: { date: '2026-10-20' }, end: { date: '2026-10-21' } })]);
    afirmar('los eventos de todo el día no se importan (no tienen hora)', todoElDia.length === 1);
    const viejo = await comparar([ev('viejo', { start: { dateTime: iso(Date.now() - 40 * 86400000) }, end: { dateTime: iso(Date.now() - 40 * 86400000 + H) } })]);
    afirmar('un evento de hace más de 30 días no se importa', viejo.length === 1);
  }

  console.log('Comparar: borrar, mover, renombrar y crear a mano');
  {
    const borrado = await comparar([{ id: 'ev1', status: 'cancelled' }]);
    afirmar('borrar un evento a mano: registro «eliminado» y el item se archiva', borrado.length === 3 && registro(borrado).cuerpo[0].tipo === 'evento_eliminado' && registro(borrado).cuerpo[0].titulo === 'Dentista' && registro(borrado).cuerpo[0].item_id === ITEMS[0].id, JSON.stringify(borrado.map((x) => x.etiqueta)));
    const arch = borrado.find((x) => x.etiqueta.startsWith('archivar'));
    afirmar('archiva solo si seguía pendiente o hecho, sin borrar la fila', arch.metodo === 'PATCH' && arch.url.endsWith(`/items?id=eq.${ITEMS[0].id}&estado=in.(pendiente,hecho)`) && JSON.stringify(arch.cuerpo) === '{"estado":"archivado"}');
    afirmar('el detalle guarda cuándo era el evento para poder avisar', registro(borrado).cuerpo[0].detalle.inicio === ITEMS[0].fecha_inicio);
    afirmar('un evento borrado que la secretaria no conocía se ignora', (await comparar([{ id: 'desconocido', status: 'cancelled' }])).length === 1);
    const hechoBorrado = await comparar([{ id: 'ev3', status: 'cancelled' }]);
    afirmar('un evento ya completado que se borra a mano también se archiva', hechoBorrado.length === 3);

    const mov = await comparar([ev('ev1', { summary: 'Dentista', start: { dateTime: iso(T0 + 24 * H) }, end: { dateTime: iso(T0 + 25 * H) } })]);
    const m = registro(mov).cuerpo[0];
    afirmar('mover un evento: registro «movido» con el antes y el después', m.tipo === 'evento_movido' && m.detalle.inicio_antes === iso(T0) && m.detalle.inicio_despues === iso(T0 + 24 * H) && m.detalle.fin_despues === iso(T0 + 25 * H) && m.detalle.renombrado === false);
    const pat = mov.find((x) => x.etiqueta.startsWith('cambiar'));
    afirmar('el item toma la hora nueva, y solo si no cambió mientras tanto (condición sobre updated_at)', JSON.stringify(pat.cuerpo) === JSON.stringify({ fecha_inicio: iso(T0 + 24 * H), fecha_fin: iso(T0 + 25 * H) }) && pat.url.endsWith(`/items?id=eq.${ITEMS[0].id}&updated_at=eq.${encodeURIComponent(HACE_UN_RATO)}`));
    const alargado = await comparar([ev('ev1', { summary: 'Dentista', start: { dateTime: iso(T0) }, end: { dateTime: iso(T0 + 2 * H) } })]);
    afirmar('cambiar solo la duración también cuenta como mover', registro(alargado).cuerpo[0].tipo === 'evento_movido');
    const choque = await comparar([ev('ev1', { summary: 'Dentista', start: { dateTime: iso(T0 + 5 * H + 1800000) }, end: { dateTime: iso(T0 + 6 * H + 1800000) } })]);
    afirmar('si el nuevo horario choca con otro evento, el detalle lo dice (solo se avisa)', registro(choque).cuerpo[0].detalle.choca.length === 1 && registro(choque).cuerpo[0].detalle.choca[0].titulo === 'Reunión');
    afirmar('moverlo no se bloquea por chocar: el item se actualiza igual', choque.some((x) => x.etiqueta.startsWith('cambiar')));

    const ren = await comparar([ev('ev1', { summary: 'Dentista (revisión)' })]);
    afirmar('renombrar: registro «renombrado» y el item toma el título', registro(ren).cuerpo[0].tipo === 'evento_renombrado' && registro(ren).cuerpo[0].detalle.titulo_despues === 'Dentista (revisión)' && JSON.stringify(ren.find((x) => x.etiqueta.startsWith('cambiar')).cuerpo) === '{"titulo":"Dentista (revisión)"}');
    const ambos = await comparar([ev('ev1', { summary: 'Médico', start: { dateTime: iso(T0 + 24 * H) }, end: { dateTime: iso(T0 + 25 * H) } })]);
    afirmar('mover y renombrar a la vez es un solo cambio «movido» marcado como renombrado', registro(ambos).cuerpo.length === 1 && registro(ambos).cuerpo[0].tipo === 'evento_movido' && registro(ambos).cuerpo[0].detalle.renombrado === true && ambos.find((x) => x.etiqueta.startsWith('cambiar')).cuerpo.titulo === 'Médico');
    const sinTitulo = await comparar([ev('ev1', { summary: '   ' })]);
    afirmar('un título vacío en Calendar no borra el título del item', sinTitulo.length === 1);

    // La descripción escrita a mano no debe borrarla la siguiente actualización de «Sincronizar Calendar»
    const soloDesc = await comparar([ev('ev1', { summary: 'Dentista', description: 'Llevar la tarjeta sanitaria' })]);
    afirmar('si solo cambia la descripción a mano, se importa al item SIN avisar', soloDesc.length === 2 && !soloDesc.some((x) => x.etiqueta.startsWith('registrar')) && JSON.stringify(soloDesc[0].cuerpo) === '{"contenido":"Llevar la tarjeta sanitaria"}' && soloDesc[0].url.includes('updated_at=eq.'));
    const conContenido = ITEMS.map((i) => (i.id.endsWith('1') ? { ...i, contenido: 'Sala 3' } : i));
    const propia = await comparar([ev('ev1', { summary: 'Dentista', description: 'Sala 3' })], { items: conContenido });
    afirmar('la descripción que escribió la propia secretaria (el contenido) no es un cambio', propia.length === 1);
    const editada = await comparar([ev('ev1', { summary: 'Dentista', description: 'Sala 4' })], { items: conContenido });
    afirmar('una descripción cambiada a mano pasa al contenido', editada[0].cuerpo.contenido === 'Sala 4');
    const vaciada = await comparar([ev('ev1', { summary: 'Dentista', description: '' })], { items: conContenido });
    afirmar('una descripción vaciada a mano deja el contenido en nulo', vaciada[0].cuerpo.contenido === null && vaciada.length === 2);
    const movDesc = await comparar([ev('ev1', { summary: 'Dentista', description: 'Llevar DNI', start: { dateTime: iso(T0 + 24 * H) }, end: { dateTime: iso(T0 + 25 * H) } })]);
    afirmar('mover y cambiar la descripción: un solo cambio, que lleva también el contenido nuevo', movDesc.find((x) => x.etiqueta.startsWith('cambiar')).cuerpo.contenido === 'Llevar DNI' && registro(movDesc).cuerpo.length === 1);

    const nuevo = await comparar([ev('nuevo1', { summary: 'Cumple de Ana', description: 'Llevar tarta', start: { dateTime: iso(T0 + 5 * H + 1800000) }, end: { dateTime: iso(T0 + 6 * H + 1800000) } })]);
    const c = registro(nuevo).cuerpo[0];
    afirmar('crear a mano: registro «creado» con horario y con qué choca', c.tipo === 'evento_creado' && c.item_id === null && c.event_id === 'nuevo1' && c.detalle.inicio === iso(T0 + 5 * H + 1800000) && c.detalle.choca[0].titulo === 'Reunión');
    const imp = nuevo.find((x) => x.etiqueta.startsWith('importar'));
    afirmar('se importa como item evento pendiente enlazado al evento de Google, con su descripción', imp.metodo === 'POST' && imp.url.endsWith('/items') && imp.cuerpo.tipo === 'evento' && imp.cuerpo.estado === 'pendiente' && imp.cuerpo.titulo === 'Cumple de Ana' && imp.cuerpo.contenido === 'Llevar tarta' && imp.cuerpo.calendar_event_id === 'nuevo1' && imp.cuerpo.fecha_inicio === iso(T0 + 5 * H + 1800000));
    const sinNada = await comparar([{ id: 'n2', status: 'confirmed', start: { dateTime: iso(T0 + 12 * H) } }]);
    const imp2 = sinNada.find((x) => x.etiqueta.startsWith('importar')).cuerpo;
    afirmar('sin título ni fin: «(sin título)» y la duración por defecto (una hora)', imp2.titulo === '(sin título)' && imp2.fecha_fin === iso(T0 + 13 * H) && imp2.contenido === null);
    afirmar('un evento creado a mano ya no se vuelve a tomar por nuevo (queda enlazado por calendar_event_id)', (await comparar([ev('nuevo1')], { items: [...ITEMS, { id: 'cccccccc-0000-4000-8000-000000000001', titulo: 'Cumple de Ana', estado: 'pendiente', fecha_inicio: iso(T0), fecha_fin: iso(T0 + H), calendar_event_id: 'nuevo1', calendar_pendiente: true, updated_at: HACE_UN_RATO }] })).length === 1);
  }

  console.log('Comparar: orden de las escrituras');
  {
    const todo = await comparar([
      { id: 'ev1', status: 'cancelled', updated: AHORA_G },
      ev('ev2', { summary: 'Reunión', start: { dateTime: iso(T0 + 30 * H) }, end: { dateTime: iso(T0 + 31 * H) } }),
      ev('nuevo1', { summary: 'Comida', start: { dateTime: iso(T0 + 40 * H) }, end: { dateTime: iso(T0 + 41 * H) } }),
    ]);
    const e = todo.map((x) => x.etiqueta);
    afirmar('primero el registro, después los items (archivar, cambiar, importar) y el estado el último', e[0].startsWith('registrar 3') && e.at(-1) === 'estado del vigilante' && e.findIndex((x) => x.startsWith('importar')) > e.findIndex((x) => x.startsWith('cambiar')) && e.length === 5, e.join(' | '));
    afirmar('el registro inserta ignorando duplicados (repetir el flujo no duplica)', todo[0].url.endsWith('/registro_calendar?on_conflict=clave') && todo[0].prefer === 'resolution=ignore-duplicates,return=minimal');
    afirmar('la clave de cada cambio depende del evento y de su última modificación en Google', todo[0].cuerpo.every((r) => r.clave === `${r.tipo}|${r.event_id}|${AHORA_G}`));
    const doble = await comparar([ev('ev1', { summary: 'Otro' }), ev('ev1', { summary: 'Otro' })]);
    afirmar('el mismo cambio dos veces en la misma lista se registra una sola vez', registro(doble).cuerpo.length === 1);
    afirmar('cada escritura lleva método, URL, cuerpo y Prefer', todo.every((x) => x.metodo && x.url.startsWith('https://abc.supabase.co/rest/v1/') && x.cuerpo && x.prefer));
  }

  console.log('Redactar aviso');
  {
    const hace = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    const r = (tipo, titulo, detalle, i = 1) => ({ id: `id-${i}`, created_at: `2026-10-14T1${i}:00:00Z`, tipo, titulo, detalle });
    const redactar = (filas, ultimoHace = 2, extra = {}) => correr(nodo('redactar.js'), { nodos: { 'Leer sin avisar': filas, 'Leer último mensaje': ultimoHace === null ? [{}] : [{ created_at: hace(ultimoHace) }] }, ...extra });
    const I = '2026-10-20T08:00:00Z'; // martes 20 oct, 10:00 en Madrid
    const F = '2026-10-20T09:00:00Z';
    afirmar('sin cambios pendientes no envía nada', (await redactar([{}])).length === 0);
    afirmar('con la ventana de 24 h cerrada no envía (sin plantillas); los cambios siguen sin avisar', (await redactar([r('evento_eliminado', 'X', { inicio: I })], 30)).length === 0);
    afirmar('sin ningún mensaje tuyo tampoco', (await redactar([r('evento_eliminado', 'X', { inicio: I })], null)).length === 0);
    await lanza('sin el número de destino en el entorno, lanza', redactar([r('evento_eliminado', 'X', { inicio: I })], 2, { env: {} }), 'WHATSAPP_NUMERO_PERMITIDO');

    const texto = async (fila) => (await redactar([fila]))[0].texto;
    afirmar('borrado', (await texto(r('evento_eliminado', 'Dentista', { inicio: I }))) === '🗑️ Borraste de tu calendario «Dentista» (mar 20 oct, 10:00). Lo he cancelado también aquí. Lo he anotado.');
    afirmar('creado, con su horario', (await texto(r('evento_creado', 'Comida', { inicio: I, fin: F }))) === '📅 Veo un evento nuevo en tu calendario: «Comida», mar 20 oct, de 10:00 a 11:00. Lo he añadido a tus citas. Lo he anotado.');
    afirmar('creado que choca: lo dice', (await texto(r('evento_creado', 'Comida', { inicio: I, fin: F, choca: [{ titulo: 'Reunión', inicio: I, fin: F }] }))).includes('⚠️ Choca con «Reunión» (10:00-11:00).'));
    afirmar('movido', (await texto(r('evento_movido', 'Dentista', { titulo_antes: 'Dentista', titulo_despues: 'Dentista', inicio_antes: I, inicio_despues: '2026-10-21T15:00:00Z', renombrado: false }))) === '🕒 Moviste «Dentista» de mar 20 oct, 10:00 a mié 21 oct, 17:00. Lo he anotado.');
    afirmar('movido y renombrado', (await texto(r('evento_movido', 'Dentista', { titulo_antes: 'Dentista', titulo_despues: 'Médico', inicio_antes: I, inicio_despues: F, renombrado: true }))).includes('y lo renombraste a «Médico»'));
    afirmar('renombrado', (await texto(r('evento_renombrado', 'Dentista', { titulo_antes: 'Dentista', titulo_despues: 'Médico', inicio_antes: I }))) === '✏️ Renombraste el evento «Dentista» a «Médico» (mar 20 oct, 10:00). Lo he anotado.');
    afirmar('los caracteres de formato de WhatsApp en un título no se cuelan', (await texto(r('evento_eliminado', '*Cena* _con_ Ana', { inicio: I }))).includes('«Cena con Ana»'));

    const una = (await redactar([r('evento_eliminado', 'Dentista', { inicio: I })]))[0];
    afirmar('el cuerpo va a su número como texto libre y lleva los ids y la marca', una.cuerpo.to === '34600111222' && una.cuerpo.type === 'text' && una.cuerpo.text.body === una.texto && JSON.stringify(una.ids) === '["id-1"]' && typeof una.marca.notificado_at === 'string');
    const varias = (await redactar([r('evento_creado', 'A', { inicio: I, fin: F }, 1), r('evento_eliminado', 'B', { inicio: I }, 2)]))[0];
    afirmar('varios cambios: un solo mensaje con título y lista, en orden', varias.texto.startsWith('*Cambios en tu calendario*\n• 📅 Veo un evento nuevo') && varias.texto.endsWith('Los he anotado todos.') && varias.ids.length === 2);
    const muchos = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, created_at: `2026-10-14T10:${String(i).padStart(2, '0')}:00Z`, tipo: 'evento_eliminado', titulo: `E${i}`, detalle: { inicio: I } }));
    const lim = (await redactar(muchos))[0];
    afirmar('más cambios que el máximo: se avisan los primeros y se dice cuántos quedan', lim.ids.length === 15 && lim.texto.includes('… y 5 más (te los digo en el próximo aviso).') && lim.ids[14] === 'id-14');
    const largos = Array.from({ length: 15 }, (_, i) => ({ id: `id-${i}`, created_at: `2026-10-14T10:${String(i).padStart(2, '0')}:00Z`, tipo: 'evento_eliminado', titulo: 'x'.repeat(300), detalle: { inicio: I } }));
    afirmar('el mensaje nunca pasa de 3800 caracteres', (await redactar(largos))[0].texto.length <= 3800);
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const nodos = flujo.nodes.filter((n) => !n.type.includes('stickyNote'));
    const por = (nombre) => nodos.find((n) => n.name === nombre);
    afirmar('hay 13 nodos de trabajo y dos disparadores (cada 5 minutos y a mano)', nodos.length === 13 && por('Cada 5 minutos').parameters.rule.interval[0].minutesInterval === 5 && por('Disparador manual'));
    const cal = nodos.filter((n) => n.parameters.nodeCredentialType === 'googleCalendarOAuth2Api');
    afirmar('Calendar solo se LEE: un único nodo, con GET', cal.length === 1 && cal[0].name === 'Leer eventos de Calendar' && cal[0].parameters.method === 'GET');
    const url = por('Leer eventos de Calendar').parameters.url;
    afirmar('pregunta solo por lo modificado desde la última pasada, incluidos los borrados, y nada más que lo necesario', url.includes('updatedMin=') && url.includes('showDeleted=true') && url.includes('maxResults=2500') && decodeURIComponent(url).includes('extendedProperties/private') && url.includes('margen_min'));
    afirmar('la primera vez (sin estado) no pide el pasado: usa «ahora»', url.includes('|| Date.now()'));
    afirmar('las lecturas se ejecutan una sola vez y un fallo detiene el flujo', ['Leer estado', 'Leer eventos de la base', 'Leer eventos de Calendar', 'Leer sin avisar', 'Leer último mensaje'].every((n) => por(n).executeOnce === true) && ['Leer estado', 'Leer eventos de la base', 'Leer eventos de Calendar', 'Escribir en Supabase', 'Enviar WhatsApp'].every((n) => !por(n).onError));
    afirmar('la lectura de la base trae solo eventos pendientes o hechos de los últimos 30 días', por('Leer eventos de la base').parameters.url.includes('tipo=eq.evento') && por('Leer eventos de la base').parameters.url.includes('estado=in.(pendiente,hecho)') && por('Leer eventos de la base').parameters.url.includes('86400000'));
    afirmar('las escrituras van de una en una (el estado, el último)', por('Escribir en Supabase').parameters.options.batching.batch.batchSize === 1);
    const cadena = ['Configuración', 'Leer estado', 'Leer eventos de la base', 'Leer eventos de Calendar', 'Comparar', 'Escribir en Supabase', 'Leer sin avisar', 'Leer último mensaje', 'Redactar aviso', 'Enviar WhatsApp', 'Marcar avisados'];
    afirmar('la cadena de nodos está completa y en orden', cadena.slice(0, -1).every((n, i) => flujo.connections[n].main[0][0].node === cadena[i + 1]) && flujo.connections['Cada 5 minutos'].main[0][0].node === 'Configuración');
    afirmar('solo se marca como avisado lo que Meta aceptó (Marcar avisados va después de Enviar, y este no tiene onError)', flujo.connections['Enviar WhatsApp'].main[0][0].node === 'Marcar avisados' && !por('Enviar WhatsApp').onError && por('Marcar avisados').parameters.url.includes('notificado_at=is.null'));
    const ids = flujo.nodes.map((n) => n.id);
    afirmar('ids únicos y distintos de los de los otros flujos «Vigilar»', new Set(ids).size === ids.length && ids.every((i) => i.startsWith('7e5e7e20-')));
    afirmar('el JSON no lleva ningún ID real ni clave', !/AIza|eyJ|EAA[A-Za-z0-9]{20}/.test(JSON.stringify(flujo)));
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
