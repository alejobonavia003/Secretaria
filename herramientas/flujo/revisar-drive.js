// Nodo "Revisar Drive": borrar carpetas y archivos de Drive con confirmación.
// Corre en la rama de carpetas, después de leer el árbol de Secretaria/ (Listar nivel 1, 2 y 3) y los archivos registrados (Contar archivos).
//
//   - Al PEDIR el borrado (meta.borrar_drive): busca la carpeta o los archivos y devuelve UN item { propuesta } con lo que se mandaría a la
//     papelera (y lo que cuelga de cada carpeta). No toca nada: «Resultado» lo enseña y deja la pregunta abierta.
//   - Al CONFIRMAR (meta.papelera, los ids que se enseñaron): vuelve a comprobar cada id con el árbol y los archivos de AHORA. Solo pasa
//     una carpeta que cuelgue de Secretaria (hasta 3 niveles) y no sea Entrada ni Notas, y un archivo que esté registrado. Devuelve
//     un item { papelera } por cada cosa que sí se puede mandar (el nodo siguiente las manda una a una) o, si no queda ninguna, un item
//     { nada: true }. Los rechazados viajan en cada item para que «Resultado» los cuente.
//   - Con cualquier otra intención (la lista de carpetas): un item vacío.
// Si el árbol no se puede leer entero, no se manda nada (con el árbol incompleto no se sabe qué cuelga de qué).

const NIVELES = 3;
const PROTEGIDAS = ['entrada', 'notas']; // las usa la secretaria para ordenar: se puede borrar lo de dentro, no la carpeta
const MAX_PAPELERA = 50;
const clave = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Las carpetas bajo la raíz, con su ruta y su nivel. Cada nivel cuelga del anterior: lo que no cuelga de algo ya visto se ignora.
function leerArbol(niveles, raizId) {
  const porId = new Map([[raizId, { id: raizId, ruta: '', nivel: 0 }]]);
  const carpetas = [];
  for (let i = 0; i < NIVELES; i++) {
    const r = niveles[i];
    if (!r || !(r.statusCode >= 200 && r.statusCode < 300) || !Array.isArray(r.body?.files)) return { error: `No se pudo leer el nivel ${i + 1} de carpetas de Drive` };
    if (r.body.nextPageToken) return { error: `Drive devolvió más de una página de carpetas en el nivel ${i + 1}` };
    for (const f of r.body.files) {
      if (!f || typeof f.id !== 'string' || porId.has(f.id)) continue;
      const padre = (Array.isArray(f.parents) ? f.parents : []).map((p) => porId.get(p)).find((p) => p && p.nivel === i);
      if (!padre) continue;
      const nombre = String(f.name ?? '');
      const c = { id: f.id, nombre, padre: padre.id, nivel: i + 1, ruta: padre.ruta ? `${padre.ruta}/${nombre}` : nombre };
      porId.set(f.id, c);
      carpetas.push(c);
    }
  }
  return { carpetas, porId };
}

const esProtegida = (c) => c.nivel === 1 && PROTEGIDAS.includes(clave(c.nombre));
// Las carpetas que cuelgan de c (sus hijas, las hijas de esas…), por el padre y no por la ruta (un nombre puede llevar «/»)
function descendientes(c, carpetas) {
  const dentro = new Set([c.id]);
  const lista = [];
  for (const d of carpetas) {
    if (dentro.has(d.padre)) {
      dentro.add(d.id);
      lista.push(d);
    }
  }
  return lista;
}

// Dónde está cada archivo registrado: su carpeta (si está en el árbol) o, si nunca se movió, Entrada
function conRuta(filas, arbol) {
  const entrada = arbol.carpetas.find((c) => c.nivel === 1 && clave(c.nombre) === 'entrada');
  return filas
    .filter((f) => f && typeof f.id === 'string' && typeof f.drive_file_id === 'string' && f.drive_file_id !== '')
    .map((f) => {
      const carpeta = typeof f.carpeta_id === 'string' && f.carpeta_id ? arbol.porId.get(f.carpeta_id) : f.estado === 'pendiente' ? entrada : null;
      const nombre = String(f.nombre ?? '');
      return { ...f, carpeta_arbol: carpeta?.id ?? null, ruta: carpeta?.ruta ? `${carpeta.ruta}/${nombre}` : nombre };
    });
}
const dentroDe = (archivos, ids) => archivos.filter((f) => f.carpeta_arbol && ids.has(f.carpeta_arbol));

// --- Proponer: qué se mandaría a la papelera ---
function proponer(pedido, arbol, archivos) {
  const objetivos = [];
  const propuesta = { objetivos, no_encontrada: null, ambiguas: null, protegida: null, vacia: null, sin_encontrar: 0, demasiados: 0 };
  let cubiertas = new Set();
  if (pedido.carpeta) {
    let candidatas = arbol.carpetas.filter((c) => clave(c.ruta) === clave(pedido.carpeta));
    // «borra la carpeta Viajes» cuando está en Fotos/Viajes: por el nombre, si solo dijo un nivel
    if (candidatas.length === 0 && !pedido.carpeta.includes('/')) candidatas = arbol.carpetas.filter((c) => clave(c.nombre) === clave(pedido.carpeta));
    if (candidatas.length === 0) propuesta.no_encontrada = pedido.carpeta;
    else if (candidatas.length > 1) propuesta.ambiguas = candidatas.map((c) => c.ruta).sort();
    else {
      const c = candidatas[0];
      const desc = descendientes(c, arbol.carpetas);
      const ids = new Set([c.id, ...desc.map((d) => d.id)]);
      const suyos = dentroDe(archivos, ids);
      if (pedido.solo_archivos) {
        if (suyos.length === 0) propuesta.vacia = c.ruta;
        for (const f of suyos) objetivos.push({ tipo: 'archivo', id: f.drive_file_id, nombre: f.ruta });
      } else if (esProtegida(c)) {
        propuesta.protegida = c.ruta;
      } else {
        objetivos.push({ tipo: 'carpeta', id: c.id, nombre: c.ruta, subcarpetas: desc.map((d) => d.ruta), archivos: suyos.map((f) => f.ruta) });
        cubiertas = ids;
      }
    }
  }
  const porId = new Map(archivos.map((f) => [f.id, f]));
  for (const idArchivo of pedido.archivo_ids ?? []) {
    const f = porId.get(idArchivo);
    if (!f) propuesta.sin_encontrar += 1;
    else if (!(f.carpeta_arbol && cubiertas.has(f.carpeta_arbol)) && !objetivos.some((o) => o.id === f.drive_file_id)) objetivos.push({ tipo: 'archivo', id: f.drive_file_id, nombre: f.ruta });
  }
  if (objetivos.length > MAX_PAPELERA) {
    propuesta.demasiados = objetivos.length;
    objetivos.length = 0;
  }
  return propuesta;
}

// --- Comprobar lo confirmado, id a id, con lo que hay ahora ---
function comprobar(papelera, arbol, archivos) {
  const validos = [];
  const rechazados = [];
  const porDrive = new Map(archivos.map((f) => [f.drive_file_id, f]));
  for (const e of Array.isArray(papelera) ? papelera.slice(0, MAX_PAPELERA) : []) {
    const nombre = String(e?.nombre ?? '');
    if (e?.tipo === 'carpeta') {
      const c = arbol.porId.get(e.id);
      if (!c || c.nivel < 1) rechazados.push({ nombre, motivo: 'ya no está en Secretaria (o está a más de 3 niveles)' });
      else if (esProtegida(c)) rechazados.push({ nombre, motivo: 'es una carpeta que uso para ordenar' });
      else validos.push({ tipo: 'carpeta', id: c.id, nombre: c.ruta, descendientes: descendientes(c, arbol.carpetas).map((d) => d.id) });
    } else if (e?.tipo === 'archivo') {
      const f = porDrive.get(e.id);
      if (!f) rechazados.push({ nombre, motivo: 'ya no lo tengo registrado (puede que ya estuviera borrado)' });
      else validos.push({ tipo: 'archivo', id: f.drive_file_id, nombre: f.ruta, descendientes: [], carpeta: f.carpeta_arbol });
    }
  }
  // Un archivo que está dentro de una carpeta que también se borra ya va con ella
  const carpetasQueVan = new Set(validos.filter((v) => v.tipo === 'carpeta').flatMap((v) => [v.id, ...v.descendientes]));
  const finales = validos.filter((v) => v.tipo === 'carpeta' || !(v.carpeta && carpetasQueVan.has(v.carpeta))).map(({ carpeta, ...v }) => v);
  return { validos: finales, rechazados };
}

function revisar({ meta, niveles, raizId, filas }) {
  const pide = meta && meta.borrar_drive && typeof meta.borrar_drive === 'object';
  const confirma = meta && Array.isArray(meta.papelera);
  if (!pide && !confirma) return [{}];
  const arbol = leerArbol(niveles, raizId);
  if (arbol.error) return [{ nada: true, error: arbol.error, rechazados: [] }];
  const archivos = conRuta(filas, arbol);
  if (pide) return [{ propuesta: proponer(meta.borrar_drive, arbol, archivos) }];
  const { validos, rechazados } = comprobar(meta.papelera, arbol, archivos);
  if (validos.length === 0) return [{ nada: true, rechazados }];
  return validos.map((papelera) => ({ papelera, rechazados }));
}

// --- Pegamento con n8n ---
const meta = $('Planificar').first().json.meta;
const leerNodo = (nombre) => {
  try {
    return $(nombre).first().json;
  } catch (e) {
    return null;
  }
};
let filas = [];
try {
  filas = $('Contar archivos').all().map((i) => i.json).filter((r) => r && !r.error);
} catch (e) {
  filas = [];
}
const salida = revisar({
  meta,
  niveles: ['Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3'].map(leerNodo),
  raizId: $('Configuración').first().json.config.carpeta_raiz_id,
  filas,
});
return salida.map((json) => ({ json }));
