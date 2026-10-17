// Nodo "Decidir": junta el plan de "Comparar" con lo que Drive ha respondido sobre lo que desapareció y arma las escrituras en Supabase.
//
// Para cada elemento desaparecido ("Confirmar en Drive" pregunta por él):
//   404                      borrado del todo (de la papelera también)  -> eliminado
//   200 y trashed = true     en la papelera                             -> eliminado
//   200 y trashed = false    sigue existiendo pero fuera de lo vigilado -> movido fuera (los archivos y carpetas NO se marcan eliminados)
//   otra cosa (403, 5xx…)    sin certeza -> no se hace nada y se reintenta en la pasada siguiente
// Lo eliminado se marca en la foto (drive_arbol), en los archivos registrados (archivos.eliminado_at) y en las carpetas pedidas
// (carpetas_pedidas.eliminada_at). Las filas NO se borran. Todo queda en registro_drive, con una clave única por cambio
// (tipo + id de Drive + estado anterior de la foto): repetir el flujo no duplica nada.
//
// Orden de las escrituras: primero el registro y las marcas, y LA FOTO LA ÚLTIMA. Si algo falla por el camino, la foto sigue siendo la
// de antes y en la pasada siguiente se detecta lo mismo (la clave única evita duplicar el registro).

const config = $('Configuración').first().json.config;
const base = `${config.supabase_url}/rest/v1`;
const plan = $('Comparar').first().json.plan;
const respuestas = $input.all().map((i) => i.json);
const ahora = plan.ahora;

const eventos = [...plan.eventos];
const upserts = [...plan.upserts, ...plan.silenciosos];
const archivosEliminar = [];
const carpetasEliminar = [];

(plan.candidatos ?? []).forEach((c, i) => {
  const r = respuestas[i];
  const estado = r?.statusCode;
  const trashed = r?.body?.trashed === true;
  let veredicto = null;
  if (estado === 404) veredicto = 'borrado';
  else if (estado >= 200 && estado < 300 && trashed) veredicto = 'papelera';
  else if (estado >= 200 && estado < 300) veredicto = 'fuera';
  if (veredicto === null) return;

  for (const f of c.filas) upserts.push({ ...f, updated_at: ahora, eliminado_at: ahora });
  const v = { id: c.drive_id, nombre: c.nombre };
  if (veredicto === 'fuera') {
    eventos.push({ tipo: c.tipo === 'carpeta' ? 'carpeta_movida' : 'archivo_movido', drive_id: v.id, nombre: v.nombre, ruta_antes: c.ruta, ruta_despues: null, detalle: { fuera: true, archivos: c.n_archivos, subcarpetas: c.n_subcarpetas }, previa: c.previa });
    return;
  }
  archivosEliminar.push(...c.archivos_registrados);
  carpetasEliminar.push(...c.carpetas);
  eventos.push({
    tipo: c.tipo === 'carpeta' ? 'carpeta_eliminada' : 'archivo_eliminado',
    drive_id: v.id,
    nombre: v.nombre,
    ruta_antes: c.ruta,
    ruta_despues: null,
    detalle: { archivos: c.n_archivos, subcarpetas: c.n_subcarpetas, definitivo: veredicto === 'borrado' },
    previa: c.previa,
  });
});

// --- Escrituras ---
const escrituras = [];
const escribir = (etiqueta, metodo, ruta, cuerpo, prefer) => escrituras.push({ etiqueta, metodo, url: `${base}${ruta}`, cuerpo, prefer });
const enLotes = (lista, n) => {
  const lotes = [];
  for (let i = 0; i < lista.length; i += n) lotes.push(lista.slice(i, i + n));
  return lotes;
};
const unicos = (lista) => [...new Set(lista)];
const lista = (ids) => `in.(${ids.map(encodeURIComponent).join(',')})`;

if (eventos.length > 0) {
  const vistas = new Set();
  const filas = [];
  for (const e of eventos) {
    const clave = `${e.tipo}|${e.drive_id}|${e.previa ?? 'nuevo'}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    filas.push({ tipo: e.tipo, drive_id: e.drive_id, nombre: e.nombre, ruta_antes: e.ruta_antes, ruta_despues: e.ruta_despues, detalle: e.detalle ?? {}, clave });
  }
  escribir(`registrar ${filas.length} cambio(s)`, 'POST', '/registro_drive?on_conflict=clave', filas, 'resolution=ignore-duplicates,return=minimal');
}
for (const lote of enLotes(unicos(archivosEliminar), 80)) {
  escribir('archivos eliminados', 'PATCH', `/archivos?drive_file_id=${lista(lote)}&eliminado_at=is.null`, { eliminado_at: ahora, drive_pendiente: false }, 'return=minimal');
}
for (const lote of enLotes(unicos(plan.restaurados_archivos), 80)) {
  escribir('archivos recuperados', 'PATCH', `/archivos?drive_file_id=${lista(lote)}`, { eliminado_at: null }, 'return=minimal');
}
for (const a of plan.archivos_manual) {
  const { drive_file_id: id, ...cambios } = a;
  escribir(`archivo cambiado a mano ${id}`, 'PATCH', `/archivos?drive_file_id=eq.${encodeURIComponent(id)}`, { ...cambios, vigilado_at: ahora }, 'return=minimal');
}
for (const lote of enLotes(unicos(carpetasEliminar), 80)) {
  escribir('carpetas pedidas eliminadas', 'PATCH', `/carpetas_pedidas?carpeta_id=${lista(lote)}&eliminada_at=is.null`, { eliminada_at: ahora, drive_pendiente: false }, 'return=minimal');
}
for (const lote of enLotes(unicos(plan.restaurados_carpetas), 80)) {
  escribir('carpetas pedidas recuperadas', 'PATCH', `/carpetas_pedidas?carpeta_id=${lista(lote)}`, { eliminada_at: null }, 'return=minimal');
}
// La foto, la última. Sin dos filas con el mismo id en una petición (Postgres lo rechaza); gana la última.
const porId = new Map();
for (const f of upserts) porId.set(f.drive_id, f);
for (const lote of enLotes([...porId.values()], 300)) {
  escribir(`foto del árbol (${lote.length})`, 'POST', '/drive_arbol?on_conflict=drive_id', lote, 'resolution=merge-duplicates,return=minimal');
}

if (escrituras.length === 0) {
  // Nada que escribir: una escritura inocua para que el flujo siga hacia los avisos pendientes
  // (un PATCH sobre un id que no existe: no toca ninguna fila)
  return [{ json: { etiqueta: 'sin cambios', metodo: 'PATCH', url: `${base}/registro_drive?id=eq.00000000-0000-0000-0000-000000000000`, cuerpo: {}, prefer: 'return=minimal' } }];
}
return escrituras.map((e) => ({ json: e }));
