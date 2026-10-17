// Nodo "Comparar": compara lo que hay AHORA en Drive (cuatro niveles bajo la carpeta raíz) con la foto guardada en la base de datos
// (drive_arbol) y con los archivos que la secretaria tiene registrados (archivos). No escribe nada: arma el plan.
//
// Qué detecta:
//   - carpeta CREADA a mano (la que crea la secretaria lleva appProperties.secretaria = '1' y no cuenta);
//   - carpeta o archivo MOVIDO o RENOMBRADO a mano (un archivo solo si la secretaria lo tiene registrado y el cambio no es suyo:
//     lo que hace «Sincronizar Drive» deja archivos.carpeta_id y archivos.nombre igual que Drive, o el archivo con drive_pendiente);
//   - RESTAURADO de la papelera (estaba eliminado en la foto y vuelve a estar);
//   - lo que HA DESAPARECIDO: se confirma después con Drive (nodo «Confirmar en Drive») si está en la papelera, borrado del todo o
//     solo fuera de lo vigilado. Solo se confirma el elemento de más arriba de cada carpeta borrada (no uno por archivo).
// Las listas de archivos creados a mano NO se avisan (solo quedan en la foto): el aviso es de carpetas y de los archivos de la secretaria.
//
// Seguridad: si Drive devuelve más de una página en algún nivel, o Supabase llega al tope de filas, se PARA con un error sin tocar nada
// (con la lectura incompleta parecería que faltan cosas que sí existen).
//
// Salida: un item por elemento a confirmar (con su URL), o uno inocuo si no hay ninguno. El primero lleva el plan completo.

const config = $('Configuración').first().json.config;
const RAIZ = config.carpeta_raiz_id;
const CARPETA = 'application/vnd.google-apps.folder';
const TOPE_FILAS = 1000; // límite por defecto de Supabase (PostgREST): llegar a él indica lectura truncada
const ahora = new Date().toISOString();

const lee = (nombre) =>
  $(nombre)
    .all()
    .map((i) => i.json);

const foto = lee('Leer foto del árbol').filter((r) => r && typeof r.drive_id === 'string');
const registrados = lee('Leer archivos registrados').filter((r) => r && typeof r.drive_file_id === 'string');
if (foto.length >= TOPE_FILAS || registrados.length >= TOPE_FILAS) {
  throw new Error(`Comparar: Supabase devolvió ${TOPE_FILAS} filas (su límite): la lectura puede estar truncada y no se toca nada. Hay que paginar la lectura.`);
}

// --- Lo que hay ahora en Drive ---
const vivos = new Map();
['Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Listar nivel 4'].forEach((nodo, i) => {
  const nivel = $(nodo).first().json ?? {};
  if (nivel.nextPageToken) throw new Error(`Comparar: Drive devolvió más de una página en el nivel ${i + 1}: se para sin tocar nada para no dar por borrado lo que sí existe`);
  for (const f of Array.isArray(nivel.files) ? nivel.files : []) {
    if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') continue;
    vivos.set(f.id, {
      id: f.id,
      nombre: f.name,
      tipo: f.mimeType === CARPETA ? 'carpeta' : 'archivo',
      padre_id: Array.isArray(f.parents) && f.parents.length > 0 ? f.parents[0] : null,
      sistema: f.appProperties?.secretaria === '1',
    });
  }
});

const memoRuta = new Map();
function rutaDe(id, profundidad = 0) {
  if (id === RAIZ) return '';
  if (profundidad > 8) return null;
  if (memoRuta.has(id)) return memoRuta.get(id);
  const v = vivos.get(id);
  if (!v) return null;
  const padre = v.padre_id === RAIZ || v.padre_id === null ? '' : rutaDe(v.padre_id, profundidad + 1);
  const ruta = padre === null ? null : padre ? `${padre}/${v.nombre}` : v.nombre;
  memoRuta.set(id, ruta);
  return ruta;
}
for (const v of vivos.values()) v.ruta = rutaDe(v.id);
for (const [id, v] of [...vivos]) if (v.ruta === null) vivos.delete(id); // sin ruta calculable (huérfano): no se vigila

const fila = (v, origen, extra = {}) => ({
  drive_id: v.id,
  tipo: v.tipo,
  nombre: v.nombre,
  padre_id: v.padre_id,
  ruta: v.ruta,
  origen,
  visto_at: ahora,
  eliminado_at: null,
  updated_at: ahora,
  ...extra,
});

// --- Primera vez: se guarda la foto sin avisar de nada ---
if (foto.length === 0) {
  const plan = { modo: 'base', ahora, upserts: [...vivos.values()].map((v) => fila(v, 'base')), eventos: [], archivos_manual: [], restaurados_archivos: [], restaurados_carpetas: [], silenciosos: [], candidatos: [], pospuestos: 0 };
  return [{ json: { inerte: true, url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(RAIZ)}?fields=id&supportsAllDrives=true`, plan } }];
}

const S = new Map(foto.filter((r) => r.eliminado_at == null).map((r) => [r.drive_id, r]));
const E = new Map(foto.filter((r) => r.eliminado_at != null).map((r) => [r.drive_id, r]));
const reg = new Map(registrados.filter((r) => r.eliminado_at == null).map((r) => [r.drive_file_id, r]));

const upserts = [];
const eventos = [];
const archivosManual = [];
const restauradosArchivos = [];
const restauradosCarpetas = [];
const evento = (tipo, v, antes, despues, detalle, previa) => ({ tipo, drive_id: v.id, nombre: v.nombre, ruta_antes: antes, ruta_despues: despues, detalle, previa });

// --- Lo nuevo, lo cambiado y lo recuperado ---
const nuevosManuales = new Set();
const restaurados = new Set();
for (const v of vivos.values()) {
  const s = S.get(v.id);
  const e = E.get(v.id);
  if (!s && e) restaurados.add(v.id);
  else if (!s) {
    const esSistema = v.tipo === 'carpeta' ? v.sistema : reg.has(v.id);
    upserts.push(fila(v, esSistema ? 'sistema' : 'manual'));
    if (!esSistema && v.tipo === 'carpeta') nuevosManuales.add(v.id);
  }
}

// Creadas a mano: se avisa de la de más arriba de cada rama, con lo que cuelga de ella
const hijosNuevos = new Map();
for (const id of nuevosManuales) {
  const v = vivos.get(id);
  if (!hijosNuevos.has(v.padre_id)) hijosNuevos.set(v.padre_id, []);
  hijosNuevos.get(v.padre_id).push(id);
}
const archivosNuevosPorPadre = new Map();
for (const v of vivos.values()) {
  if (v.tipo === 'archivo' && !S.has(v.id) && !E.has(v.id)) archivosNuevosPorPadre.set(v.padre_id, (archivosNuevosPorPadre.get(v.padre_id) ?? 0) + 1);
}
function contarNuevo(id) {
  let carpetas = 0;
  let archivos = archivosNuevosPorPadre.get(id) ?? 0;
  for (const h of hijosNuevos.get(id) ?? []) {
    const c = contarNuevo(h);
    carpetas += 1 + c.carpetas;
    archivos += c.archivos;
  }
  return { carpetas, archivos };
}
for (const id of nuevosManuales) {
  const v = vivos.get(id);
  if (nuevosManuales.has(v.padre_id)) continue;
  const c = contarNuevo(id);
  eventos.push(evento('carpeta_creada', v, null, v.ruta, { subcarpetas: c.carpetas, archivos: c.archivos }, 'nueva'));
}

// Recuperadas de la papelera: se avisa de la de más arriba; se reactivan los archivos y carpetas pedidas que dependían de ellas
for (const id of restaurados) {
  const v = vivos.get(id);
  const e = E.get(id);
  upserts.push(fila(v, e.origen ?? 'base'));
  if (v.tipo === 'archivo' && registrados.some((r) => r.drive_file_id === id)) restauradosArchivos.push(id);
  if (v.tipo === 'carpeta') restauradosCarpetas.push(id);
  if (restaurados.has(v.padre_id)) continue;
  if (v.tipo === 'carpeta') eventos.push(evento('carpeta_restaurada', v, null, v.ruta, {}, e.eliminado_at));
  else if (registrados.some((r) => r.drive_file_id === id)) eventos.push(evento('archivo_restaurado', v, null, v.ruta, {}, e.eliminado_at));
}
// Archivos registrados que estaban eliminados en la base y siguen vivos (p. ej. la foto se restauró sin pasar por la foto del árbol)
for (const r of registrados) if (r.eliminado_at != null && vivos.has(r.drive_file_id) && !restaurados.has(r.drive_file_id)) restauradosArchivos.push(r.drive_file_id);

// --- Movidos y renombrados ---
for (const v of vivos.values()) {
  const s = S.get(v.id);
  if (!s) continue;
  const movido = s.padre_id !== v.padre_id;
  const renombrado = s.nombre !== v.nombre;
  const rutaCambia = s.ruta !== v.ruta;
  if (!movido && !renombrado && !rutaCambia) continue;
  upserts.push(fila(v, s.origen ?? 'base'));
  if (!movido && !renombrado) continue; // solo cambia la ruta porque se movió o renombró una carpeta de más arriba

  if (v.tipo === 'carpeta') {
    eventos.push(evento(movido ? 'carpeta_movida' : 'carpeta_renombrada', v, s.ruta, v.ruta, { renombrada: movido && renombrado, nombre_antes: s.nombre }, s.updated_at));
    continue;
  }
  const a = reg.get(v.id);
  if (!a) continue; // un archivo que la secretaria no tiene registrado: solo cambia la foto
  const loHizoElSistema = a.drive_pendiente === true || (a.nombre === v.nombre && a.carpeta_id === v.padre_id);
  if (loHizoElSistema) continue;
  archivosManual.push({ drive_file_id: v.id, ...(movido ? { carpeta_id: v.padre_id } : {}), ...(renombrado ? { nombre: v.nombre } : {}) });
  eventos.push(evento(movido ? 'archivo_movido' : 'archivo_renombrado', v, s.ruta, v.ruta, { renombrada: movido && renombrado, nombre_antes: s.nombre }, s.updated_at));
}

// --- Lo que ha desaparecido ---
const desaparecidos = new Set([...S.keys()].filter((id) => !vivos.has(id)));
const hijosFoto = new Map();
for (const r of S.values()) {
  if (!hijosFoto.has(r.padre_id)) hijosFoto.set(r.padre_id, []);
  hijosFoto.get(r.padre_id).push(r);
}
function bajoDesaparecido(raiz) {
  const filas = [];
  const pila = [...(hijosFoto.get(raiz.drive_id) ?? [])];
  while (pila.length) {
    const r = pila.pop();
    if (!desaparecidos.has(r.drive_id)) continue;
    filas.push(r);
    pila.push(...(hijosFoto.get(r.drive_id) ?? []));
  }
  return filas;
}
const cima = [...desaparecidos].map((id) => S.get(id)).filter((r) => !desaparecidos.has(r.padre_id));
const candidatos = [];
const silenciosos = []; // archivos sin registrar que faltan: solo se marcan en la foto
for (const r of cima.sort((a, b) => String(a.ruta).localeCompare(String(b.ruta), 'es'))) {
  const debajo = bajoDesaparecido(r);
  const todos = [r, ...debajo];
  const registrada = r.tipo === 'archivo' && reg.has(r.drive_id);
  if (r.tipo === 'archivo' && !registrada) {
    silenciosos.push(fila({ id: r.drive_id, nombre: r.nombre, tipo: r.tipo, padre_id: r.padre_id, ruta: r.ruta }, r.origen ?? 'base', { eliminado_at: ahora, visto_at: r.visto_at }));
    continue;
  }
  candidatos.push({
    drive_id: r.drive_id,
    tipo: r.tipo,
    nombre: r.nombre,
    ruta: r.ruta,
    previa: r.updated_at,
    filas: todos.map((x) => ({ drive_id: x.drive_id, tipo: x.tipo, nombre: x.nombre, padre_id: x.padre_id, ruta: x.ruta, origen: x.origen ?? 'base', visto_at: x.visto_at ?? ahora })),
    archivos_registrados: todos.filter((x) => x.tipo === 'archivo' && reg.has(x.drive_id)).map((x) => x.drive_id),
    carpetas: todos.filter((x) => x.tipo === 'carpeta').map((x) => x.drive_id),
    n_archivos: todos.filter((x) => x.tipo === 'archivo').length,
    n_subcarpetas: todos.filter((x) => x.tipo === 'carpeta' && x.drive_id !== r.drive_id).length,
  });
}
const aConfirmar = candidatos.slice(0, config.lote_confirmar);
const plan = {
  modo: 'normal',
  ahora,
  upserts,
  eventos,
  archivos_manual: archivosManual,
  restaurados_archivos: restauradosArchivos,
  restaurados_carpetas: restauradosCarpetas,
  silenciosos,
  candidatos: aConfirmar,
  pospuestos: candidatos.length - aConfirmar.length,
};

const urlComprobar = (id) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${encodeURIComponent('id,name,trashed,parents')}&supportsAllDrives=true`;
if (aConfirmar.length === 0) {
  return [{ json: { inerte: true, url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(RAIZ)}?fields=id&supportsAllDrives=true`, plan } }];
}
return aConfirmar.map((c, i) => ({ json: { inerte: false, drive_id: c.drive_id, url: urlComprobar(c.drive_id), ...(i === 0 ? { plan } : {}) } }));
