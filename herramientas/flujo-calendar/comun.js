// Funciones puras compartidas por los nodos del flujo "Sincronizar Calendar".
// n8n no permite importar código entre nodos: el generador inserta este archivo en cada nodo que
// lo necesita, en la línea que contiene solo el marcador COMUN (entre guiones bajos dobles y en un
// comentario de bloque). No usa nada de n8n, así que se prueba sin red.

const HORAS_AVISO_URGENTE = 2;

// Una fecha ISO con hora (la que devuelve PostgREST para un timestamptz)
const esFechaIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

// Id de un evento de Google tal como lo guarda este sistema: solo caracteres seguros para ir en una URL
const esIdEvento = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{5,1024}$/.test(v);

// Qué hacer con un item pendiente de sincronizar.
// "sincronizar": crear o actualizar el evento en Calendar.
// "borrar": el usuario canceló el item (estado archivado) y tiene un evento en Calendar: se borra ese evento. Es la ÚNICA
//   excepción a que este sistema no borra eventos; un evento completado ("hecho") permanece como registro.
//   También se borra el evento de un item PENDIENTE que ya no es una cita (el usuario la convirtió en alarma o en tarea: «ponla como alarma»,
//   si no, la cita seguiría en su calendario aunque ya no lo sea.
// "omitir": limpiar la marca sin tocar Calendar (si un evento se completa, el evento antiguo permanece allí como registro).
function clasificar(item) {
  if (item.estado === 'archivado' && esIdEvento(item.calendar_event_id)) return { accion: 'borrar', motivo: 'cancelado por el usuario' };
  if (item.tipo !== 'evento' && item.estado === 'pendiente' && esIdEvento(item.calendar_event_id)) return { accion: 'borrar', motivo: 'ya no es una cita' };
  if (item.tipo !== 'evento') return { accion: 'omitir', motivo: 'ya no es un evento' };
  if (item.estado !== 'pendiente') return { accion: 'omitir', motivo: 'ya no está pendiente' };
  if (!esFechaIso(item.fecha_inicio)) return { accion: 'omitir', motivo: 'no tiene una fecha de inicio válida' };
  return { accion: 'sincronizar' };
}

// Identificador del evento en Google: los 32 caracteres hexadecimales del id del item.
// Google acepta ids propios con las letras a-v y los dígitos 0-9 (de 5 a 1024 caracteres), únicos por calendario.
// Así, repetir la creación de un mismo item no puede producir dos eventos distintos.
function idEventoDe(itemId) {
  const h = String(itemId).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error(`El id del item no es un UUID: ${itemId}`);
  return h;
}

// Día natural en Madrid (AAAA-MM-DD) de un instante
const diaMadrid = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(ms));

// Aviso urgente por WhatsApp: además del aviso del calendario, se avisa si el
// evento es del mismo día en que se crea o se mueve, o si su aviso cae a menos de 2 horas de ese momento.
// "referencia" es la hora del cambio (updated_at). Devuelve cuándo avisar, o null si no hace falta.
// Si la hora del aviso ya ha pasado, se avisa en el acto (el aviso del iPhone llegaría tarde).
function calcularAviso({ fecha_inicio, referencia, aviso_min }) {
  const inicio = Date.parse(fecha_inicio);
  const ref = Date.parse(referencia);
  if (Number.isNaN(inicio) || Number.isNaN(ref)) return null;
  if (inicio <= ref) return null; // ya ha empezado: no hay nada que avisar
  const alarma = inicio - aviso_min * 60000;
  const mismoDia = diaMadrid(inicio) === diaMadrid(ref);
  const pocoMargen = alarma - ref < HORAS_AVISO_URGENTE * 3600000;
  if (!mismoDia && !pocoMargen) return null;
  return new Date(Math.max(alarma, ref)).toISOString();
}

// Cuerpo del evento para Google Calendar (sirve para crear y para actualizar)
function cuerpoEvento(item, config) {
  const inicioMs = Date.parse(item.fecha_inicio);
  let finMs = esFechaIso(item.fecha_fin) ? Date.parse(item.fecha_fin) : NaN;
  if (!(finMs > inicioMs)) finMs = inicioMs + config.duracion_min * 60000; // Google exige que el fin sea posterior
  const descripcion = textoOnull(item.contenido) ?? '';
  return {
    summary: item.titulo,
    // Siempre se envía (aunque esté vacía): en un PATCH es la única forma de borrar una descripción anterior
    description: descripcion,
    start: { dateTime: new Date(inicioMs).toISOString(), timeZone: config.zona },
    end: { dateTime: new Date(finMs).toISOString(), timeZone: config.zona },
    // Los avisos son un array: en un PATCH se sustituyen enteros, que es lo que se quiere
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: config.aviso_min }] },
    extendedProperties: { private: { item_id: item.id } },
  };
}

function textoOnull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
