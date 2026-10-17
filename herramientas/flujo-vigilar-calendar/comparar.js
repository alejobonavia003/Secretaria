// Nodo "Comparar": compara lo que Google dice que ha CAMBIADO en el calendario desde la última pasada con los eventos de la base de datos
// y arma las escrituras. No escribe nada: solo las prepara.
//
// Qué detecta (solo lo hecho A MANO en Google Calendar):
//   - evento BORRADO     -> el item se archiva (como si lo hubieras cancelado por WhatsApp; el flujo «Sincronizar Calendar» ya sabe que el evento no existe);
//   - evento MOVIDO      -> el item toma la hora nueva (inicio y fin); «Sincronizar Calendar» recalcula el aviso;
//   - evento RENOMBRADO  -> el item toma el título nuevo;
//   - evento CREADO      -> se crea un item (tipo evento, pendiente) con ese evento, para que cuente en las consultas y en los solapes.
// Todo lo que hace la propia secretaria se ignora: sus eventos llevan extendedProperties.private.item_id, y un cambio que ya está en el item no es un cambio.
//
// Reglas de seguridad:
//   - nunca se pisa un cambio hecho por WhatsApp: se ignora el evento si el item está pendiente de sincronizar o si el item cambió DESPUÉS que el evento;
//   - la escritura de un cambio lleva la condición updated_at = <el valor que se leyó>: si el item cambió mientras tanto, no se toca;
//   - no se importan los eventos periódicos (recurrentes) ni los de todo el día (no tienen hora: no podrían entrar en el control de solapes);
//   - la primera vez (sin estado guardado) solo se guarda la hora de la pasada: los eventos creados a mano ANTES de activar el vigilante no se importan
//     (editar uno en Calendar lo hace «cambiar» y entonces sí se importa);
//   - la hora de la última pasada se guarda LA ÚLTIMA: si algo falla por el camino, la pasada siguiente lo vuelve a ver (las claves únicas evitan duplicar el registro).
//
// La descripción: «Sincronizar Calendar» reescribe la descripción del evento desde el item cada vez que lo actualiza. Por eso, si la descripción de un
// evento se cambió a mano, se importa al item (sin avisar) para que esa actualización no la borre.
//
// Salida: una escritura por item; la última siempre guarda el estado.

const config = $('Configuración').first().json.config;
const base = `${config.supabase_url}/rest/v1`;
const inicioPasada = new Date().toISOString();
const TOPE_FILAS = 1000;
const DURACION_MS = config.duracion_min * 60000;
// Los eventos de la base de datos se leen desde hace 30 días (nodo «Leer eventos de la base»): los más antiguos no se vigilan
const DIAS_VIGILADOS = 30;

const estado = $('Leer estado')
  .all()
  .map((i) => i.json)
  .find((r) => r && r.valor && typeof r.valor.ultima === 'string');
const filasDb = $('Leer eventos de la base')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string');
if (filasDb.length >= TOPE_FILAS) {
  throw new Error(`Comparar: Supabase devolvió ${TOPE_FILAS} eventos (su límite): la lectura puede estar truncada y no se toca nada. Hay que paginar la lectura.`);
}

const escrituras = [];
const escribir = (etiqueta, metodo, ruta, cuerpo, prefer) => escrituras.push({ etiqueta, metodo, url: `${base}${ruta}`, cuerpo, prefer });
const guardarEstado = () => escribir('estado del vigilante', 'POST', '/vigilantes_estado?on_conflict=clave', { clave: 'calendar', valor: { ultima: inicioPasada }, updated_at: inicioPasada }, 'resolution=merge-duplicates,return=minimal');

// Primera vez: solo se guarda la hora de la pasada
if (!estado) {
  guardarEstado();
  return escrituras.map((e) => ({ json: e }));
}

const lista = $('Leer eventos de Calendar').first().json ?? {};
if (lista.nextPageToken) {
  throw new Error('Comparar: Google devolvió más de una página de cambios: se para sin tocar nada (la hora de la última pasada no avanza)');
}
const eventos = Array.isArray(lista.items) ? lista.items : [];

// --- Lo que ya conoce la base de datos ---
const porEvento = new Map();
const porItem = new Map();
for (const it of filasDb) {
  if (typeof it.calendar_event_id === 'string' && it.calendar_event_id !== '') porEvento.set(it.calendar_event_id, it);
  porItem.set(it.id, it);
}
const ms = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);
const intervalo = (it) => {
  const ini = ms(it.fecha_inicio);
  let fin = ms(it.fecha_fin);
  if (!(fin > ini)) fin = ini + DURACION_MS;
  return { ini, fin };
};
// Con qué otros eventos pendientes choca un evento (para avisar; no impide nada)
function choques(id, ini, fin) {
  return filasDb
    .filter((x) => x.id !== id && x.estado === 'pendiente' && Number.isFinite(ms(x.fecha_inicio)))
    .map((x) => ({ x, i: intervalo(x) }))
    .filter(({ i }) => ini < i.fin && i.ini < fin)
    .slice(0, 3)
    .map(({ x, i }) => ({ titulo: x.titulo, inicio: new Date(i.ini).toISOString(), fin: new Date(i.fin).toISOString() }));
}

// Lo que «Sincronizar Calendar» escribe como descripción de un item: su contenido.
// Devuelve undefined si la descripción del evento es esa (no hay cambio); si no, el contenido nuevo (null si queda vacío).
function descripcionCambiada(item, descripcionEvento) {
  const hay = typeof descripcionEvento === 'string' ? descripcionEvento.trim() : '';
  const contenido = typeof item.contenido === 'string' && item.contenido.trim() !== '' ? item.contenido.trim() : null;
  const esperada = contenido ?? '';
  if (hay === esperada) return undefined;
  return hay === '' ? null : hay;
}

const registros = [];
const cambiosItems = [];
const nuevosItems = [];
const registrar = (tipo, ev, itemId, titulo, detalle) => registros.push({ tipo, event_id: ev.id, item_id: itemId, titulo, detalle, clave: `${tipo}|${ev.id}|${ev.updated ?? 'sin-fecha'}` });

for (const ev of eventos) {
  if (!ev || typeof ev.id !== 'string' || ev.id === '') continue;
  if (ev.recurrence || ev.recurringEventId) continue; // eventos periódicos: no se vigilan

  const propio = ev.extendedProperties?.private?.item_id; // lo pone la secretaria al crear o actualizar el evento
  const item = porEvento.get(ev.id) ?? (typeof propio === 'string' ? porItem.get(propio) : undefined);

  // --- Borrado a mano ---
  if (ev.status === 'cancelled') {
    if (!item || (item.estado !== 'pendiente' && item.estado !== 'hecho')) continue; // no era de la secretaria, o ya estaba cancelado
    registrar('evento_eliminado', ev, item.id, item.titulo, { titulo: item.titulo, inicio: item.fecha_inicio, fin: item.fecha_fin });
    cambiosItems.push({ id: item.id, condicion: `estado=in.(pendiente,hecho)`, cuerpo: { estado: 'archivado' }, etiqueta: `archivar «${item.titulo}»` });
    continue;
  }

  // Sin hora (todo el día) no se mira: no puede entrar en la agenda
  const inicio = ms(ev.start?.dateTime);
  if (!Number.isFinite(inicio)) continue;
  if (inicio < Date.now() - DIAS_VIGILADOS * 86400000) continue; // más antiguo que lo que se lee de la base de datos: no se importa ni se compara
  let fin = ms(ev.end?.dateTime);
  if (!(fin > inicio)) fin = inicio + DURACION_MS;
  const titulo = typeof ev.summary === 'string' && ev.summary.trim() !== '' ? ev.summary.trim() : '(sin título)';

  // --- Creado a mano ---
  if (!item) {
    if (typeof propio === 'string') continue; // lo creó la secretaria (su item ya no está entre los vigilados)
    const choca = choques(null, inicio, fin);
    registrar('evento_creado', ev, null, titulo, { titulo, inicio: new Date(inicio).toISOString(), fin: new Date(fin).toISOString(), choca });
    nuevosItems.push({
      tipo: 'evento',
      titulo,
      contenido: typeof ev.description === 'string' && ev.description.trim() !== '' ? ev.description.trim() : null,
      estado: 'pendiente',
      fecha_inicio: new Date(inicio).toISOString(),
      fecha_fin: new Date(fin).toISOString(),
      calendar_event_id: ev.id,
    });
    continue;
  }

  // --- Movido o renombrado a mano ---
  if (item.estado !== 'pendiente') continue; // los completados no se tocan
  if (item.calendar_pendiente === true) continue; // la secretaria está a punto de escribir en Calendar: su valor manda
  if (!(ms(ev.updated) > ms(item.updated_at))) continue; // el item cambió después que el evento (p. ej. por WhatsApp): su valor manda
  const antes = intervalo(item);
  const movido = antes.ini !== inicio || antes.fin !== fin;
  const renombrado = titulo !== item.titulo && titulo !== '(sin título)';
  const contenidoNuevo = descripcionCambiada(item, ev.description);
  if (!movido && !renombrado && contenidoNuevo === undefined) continue; // coincide con lo que ya hay: es un cambio de la propia secretaria
  if (!movido && !renombrado) {
    // Solo cambió la descripción: se importa al item sin avisar
    cambiosItems.push({ id: item.id, condicion: `updated_at=eq.${encodeURIComponent(item.updated_at)}`, cuerpo: { contenido: contenidoNuevo }, etiqueta: `descripción de «${item.titulo}»` });
    continue;
  }
  const detalle = {
    titulo_antes: item.titulo,
    titulo_despues: renombrado ? titulo : item.titulo,
    inicio_antes: new Date(antes.ini).toISOString(),
    fin_antes: new Date(antes.fin).toISOString(),
    inicio_despues: new Date(inicio).toISOString(),
    fin_despues: new Date(fin).toISOString(),
    renombrado: movido && renombrado,
  };
  if (movido) detalle.choca = choques(item.id, inicio, fin);
  registrar(movido ? 'evento_movido' : 'evento_renombrado', ev, item.id, item.titulo, detalle);
  cambiosItems.push({
    id: item.id,
    condicion: `updated_at=eq.${encodeURIComponent(item.updated_at)}`,
    cuerpo: { ...(movido ? { fecha_inicio: detalle.inicio_despues, fecha_fin: detalle.fin_despues } : {}), ...(renombrado ? { titulo } : {}), ...(contenidoNuevo !== undefined ? { contenido: contenidoNuevo } : {}) },
    etiqueta: `cambiar «${item.titulo}»`,
  });
}

// --- Escrituras: el registro primero, los items después y el estado el último ---
const vistas = new Set();
const filasRegistro = registros.filter((r) => (vistas.has(r.clave) ? false : vistas.add(r.clave)));
if (filasRegistro.length > 0) {
  escribir(`registrar ${filasRegistro.length} cambio(s) del calendario`, 'POST', '/registro_calendar?on_conflict=clave', filasRegistro, 'resolution=ignore-duplicates,return=minimal');
}
for (const c of cambiosItems) escribir(c.etiqueta, 'PATCH', `/items?id=eq.${encodeURIComponent(c.id)}&${c.condicion}`, c.cuerpo, 'return=minimal');
for (const n of nuevosItems) escribir(`importar «${n.titulo}»`, 'POST', '/items', n, 'return=minimal');
guardarEstado();

return escrituras.map((e) => ({ json: e }));
