// Pruebas sin red ni coste del flujo "Vigilar Drive" (flujos/vigilar-drive.json).
// Ejecuta el código real de herramientas/flujo-vigilar/*.js con entradas simuladas.
// Uso: node herramientas/probar-vigilar.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-vigilar.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const nodo = (f) => leer('flujo-vigilar', f);

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

const R = 'RAIZ0000000001';
const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012', graph_version: 'v26.0', carpeta_raiz_id: R, ventana_horas: 23, lote_confirmar: 40, max_lineas: 15 };
const CARPETA = 'application/vnd.google-apps.folder';

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }), all: () => [{ json: { config: nodos.config ?? CONFIG } }] };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { input = [], nodos = {}, env = { WHATSAPP_NUMERO_PERMITIDO: '34600111222' } } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', '$env', codigo);
  const salida = await fn({ all: () => items, first: () => items[0] }, simular(nodos), env);
  return salida.map((x) => x.json);
}

// --- Datos de prueba ---
// d(id, nombre, padre, tipo): un nodo de Drive; se reparte en los cuatro niveles según su profundidad
const d = (id, name, parent, esCarpeta = false, extra = {}) => ({ id, name, parents: [parent], mimeType: esCarpeta ? CARPETA : 'application/pdf', ...extra });
function listados(nodos) {
  const mapa = new Map(nodos.map((n) => [n.id, n]));
  const prof = (n) => (n.parents[0] === R ? 1 : 1 + prof(mapa.get(n.parents[0])));
  const niveles = { 1: [], 2: [], 3: [], 4: [] };
  for (const n of nodos) niveles[prof(n)].push(n);
  return Object.fromEntries([1, 2, 3, 4].map((i) => [`Listar nivel ${i}`, [{ files: niveles[i] }]]));
}
// Árbol base: Entrada, Trabajo/Informes/informe.pdf, Notas, y Entrada/foto.jpg
const BASE = [d('e1', 'Entrada', R, true), d('u1', 'Trabajo', R, true), d('n1', 'Notas', R, true), d('c1', 'Informes', 'u1', true), d('f1', 'informe.pdf', 'c1'), d('f2', 'foto.jpg', 'e1')];
const filaFoto = (id, tipo, nombre, padre, ruta, extra = {}) => ({ drive_id: id, tipo, nombre, padre_id: padre, ruta, origen: 'base', visto_at: '2026-10-14T10:00:00Z', eliminado_at: null, updated_at: '2026-10-14T10:00:00Z', ...extra });
const FOTO = [
  filaFoto('e1', 'carpeta', 'Entrada', R, 'Entrada'),
  filaFoto('u1', 'carpeta', 'Trabajo', R, 'Trabajo'),
  filaFoto('n1', 'carpeta', 'Notas', R, 'Notas'),
  filaFoto('c1', 'carpeta', 'Informes', 'u1', 'Trabajo/Informes'),
  filaFoto('f1', 'archivo', 'informe.pdf', 'c1', 'Trabajo/Informes/informe.pdf'),
  filaFoto('f2', 'archivo', 'foto.jpg', 'e1', 'Entrada/foto.jpg'),
];
const REG = [
  { drive_file_id: 'f1', nombre: 'informe.pdf', carpeta_id: 'c1', drive_pendiente: false, eliminado_at: null },
  { drive_file_id: 'f2', nombre: 'foto.jpg', carpeta_id: 'e1', drive_pendiente: false, eliminado_at: null },
];
const comparar = (tree, { foto = FOTO, reg = REG, config } = {}) =>
  correr(nodo('comparar.js'), { nodos: { 'Leer foto del árbol': foto, 'Leer archivos registrados': reg, ...listados(tree), ...(config ? { config } : {}) } });
const planDe = (salida) => salida[0].plan;
const sinC = (tree, obj = {}) => tree.filter((n) => !(obj.sin ?? []).includes(n.id));

async function main() {
  console.log('Configuración');
  {
    const base = nodo('configuracion.js');
    await lanza('sin poner Supabase, lanza', correr(base), 'SUPABASE_URL');
    const s = base.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co');
    await lanza('sin el Phone number ID, lanza', correr(s), 'PHONE_NUMBER_ID');
    const p = s.replace('TU-PHONE-NUMBER-ID', '123456789012');
    await lanza('sin la carpeta raíz, lanza', correr(p), 'CARPETA_RAIZ_ID');
    const [c] = await correr(p.replace('TU-CARPETA-RAIZ', R));
    afirmar('con todo puesto devuelve la configuración con los valores por defecto', c.config.carpeta_raiz_id === R && c.config.ventana_horas === 23 && c.config.lote_confirmar === 40 && c.config.max_lineas === 15 && c.config.supabase_url === 'https://abc.supabase.co');
    await lanza('un ID de carpeta con caracteres raros se rechaza', correr(p.replace('TU-CARPETA-RAIZ', 'x or name contains a')), 'CARPETA_RAIZ_ID');
  }

  console.log('Comparar: seguridad y primera vez');
  {
    const base = await comparar(BASE, { foto: [], reg: REG });
    const p = planDe(base);
    afirmar('la primera vez guarda toda la foto como «base» y NO avisa de nada', p.modo === 'base' && p.upserts.length === 6 && p.upserts.every((u) => u.origen === 'base' && u.eliminado_at === null) && p.eventos.length === 0 && p.candidatos.length === 0);
    afirmar('las rutas de la foto salen bien (bajo Secretaria, con barras)', p.upserts.find((u) => u.drive_id === 'f1').ruta === 'Trabajo/Informes/informe.pdf' && p.upserts.find((u) => u.drive_id === 'e1').ruta === 'Entrada');
    afirmar('la primera vez devuelve un elemento inocuo que sigue el flujo', base.length === 1 && base[0].inerte === true && base[0].url.includes(R));
    await lanza('si Supabase llega a su tope de filas, se para', comparar(BASE, { foto: Array.from({ length: 1000 }, (_, i) => filaFoto(`x${i}`, 'archivo', 'a', R, 'a')) }), 'Supabase devolvió 1000 filas');
    await lanza('si los archivos registrados llegan al tope, se para', comparar(BASE, { reg: Array.from({ length: 1000 }, (_, i) => ({ drive_file_id: `r${i}`, nombre: 'a' })) }), 'Supabase devolvió 1000 filas');
    const pag = listados(BASE);
    pag['Listar nivel 2'] = [{ files: [], nextPageToken: 'mas' }];
    await lanza('si Drive devuelve más de una página, se para (no se da por borrado lo que sí existe)', correr(nodo('comparar.js'), { nodos: { 'Leer foto del árbol': FOTO, 'Leer archivos registrados': REG, ...pag } }), 'más de una página en el nivel 2');
    const sinCambios = planDe(await comparar(BASE));
    afirmar('sin cambios no hay nada que hacer', sinCambios.eventos.length === 0 && sinCambios.upserts.length === 0 && sinCambios.candidatos.length === 0 && sinCambios.archivos_manual.length === 0);
    const vacia = await correr(nodo('comparar.js'), { nodos: { 'Leer foto del árbol': [{}], 'Leer archivos registrados': [{}], ...listados(BASE) } });
    afirmar('una tabla vacía (Supabase devuelve un item vacío) cuenta como primera vez', planDe(vacia).modo === 'base');
  }

  console.log('Comparar: carpetas creadas a mano');
  {
    const nueva = planDe(await comparar([...BASE, d('p1', 'Proyectos', R, true)]));
    afirmar('una carpeta nueva sin marca de la secretaria es «creada a mano»: evento y origen manual', nueva.eventos.length === 1 && nueva.eventos[0].tipo === 'carpeta_creada' && nueva.eventos[0].ruta_despues === 'Proyectos' && nueva.upserts.length === 1 && nueva.upserts[0].origen === 'manual');
    const delSistema = planDe(await comparar([...BASE, d('p1', 'Proyectos', R, true, { appProperties: { secretaria: '1' } })]));
    afirmar('una carpeta con la marca de la secretaria se guarda como «sistema» y no avisa', delSistema.eventos.length === 0 && delSistema.upserts[0].origen === 'sistema');
    const rama = planDe(await comparar([...BASE, d('p1', 'Trabajo', R, true), d('p2', 'Facturas', 'p1', true), d('p3', 'enero.pdf', 'p2'), d('p4', 'marzo.pdf', 'p2')]));
    afirmar('una rama entera creada a mano avisa una sola vez, de la carpeta de arriba, con lo que cuelga', rama.eventos.length === 1 && rama.eventos[0].nombre === 'Trabajo' && rama.eventos[0].detalle.subcarpetas === 1 && rama.eventos[0].detalle.archivos === 2, JSON.stringify(rama.eventos));
    afirmar('todas las piezas de la rama quedan en la foto', rama.upserts.length === 4);
    const archivoSuelto = planDe(await comparar([...BASE, d('f9', 'dejado.pdf', 'e1')]));
    afirmar('un archivo creado a mano no avisa (solo queda en la foto)', archivoSuelto.eventos.length === 0 && archivoSuelto.upserts.length === 1 && archivoSuelto.upserts[0].origen === 'manual');
    const archivoDelSistema = planDe(await comparar([...BASE, d('f9', 'subido.jpg', 'e1')], { reg: [...REG, { drive_file_id: 'f9', nombre: 'subido.jpg', carpeta_id: 'e1', drive_pendiente: false, eliminado_at: null }] }));
    afirmar('un archivo que la secretaria tiene registrado se guarda como «sistema»', archivoDelSistema.upserts[0].origen === 'sistema' && archivoDelSistema.eventos.length === 0);
  }

  console.log('Comparar: movidos y renombrados');
  {
    const ren = planDe(await comparar(BASE.map((n) => (n.id === 'c1' ? { ...n, name: 'Informes anuales' } : n))));
    afirmar('renombrar una carpeta: evento «renombrada» con la ruta antes y después', ren.eventos.length === 1 && ren.eventos[0].tipo === 'carpeta_renombrada' && ren.eventos[0].ruta_antes === 'Trabajo/Informes' && ren.eventos[0].ruta_despues === 'Trabajo/Informes anuales' && ren.eventos[0].detalle.nombre_antes === 'Informes');
    afirmar('lo que cuelga de ella actualiza su ruta en la foto pero NO avisa', ren.upserts.find((u) => u.drive_id === 'f1').ruta === 'Trabajo/Informes anuales/informe.pdf' && !ren.eventos.some((e) => e.drive_id === 'f1') && ren.archivos_manual.length === 0);
    const mov = planDe(await comparar(BASE.map((n) => (n.id === 'c1' ? { ...n, parents: [R] } : n))));
    afirmar('mover una carpeta: evento «movida» con de dónde a dónde', mov.eventos.length === 1 && mov.eventos[0].tipo === 'carpeta_movida' && mov.eventos[0].ruta_antes === 'Trabajo/Informes' && mov.eventos[0].ruta_despues === 'Informes' && mov.eventos[0].detalle.renombrada === false);
    const movYRen = planDe(await comparar(BASE.map((n) => (n.id === 'c1' ? { ...n, parents: [R], name: 'Tesis' } : n))));
    afirmar('mover y renombrar a la vez es un solo evento «movida» marcado como renombrada', movYRen.eventos.length === 1 && movYRen.eventos[0].tipo === 'carpeta_movida' && movYRen.eventos[0].detalle.renombrada === true && movYRen.eventos[0].ruta_despues === 'Tesis');
    // Archivos registrados
    const movA = planDe(await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, parents: ['n1'] } : n))));
    afirmar('mover a mano un archivo registrado: evento y se actualiza archivos.carpeta_id', movA.eventos.length === 1 && movA.eventos[0].tipo === 'archivo_movido' && movA.eventos[0].ruta_antes === 'Entrada/foto.jpg' && movA.eventos[0].ruta_despues === 'Notas/foto.jpg' && movA.archivos_manual[0].carpeta_id === 'n1' && !('nombre' in movA.archivos_manual[0]));
    const renA = planDe(await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, name: 'playa.jpg' } : n))));
    afirmar('renombrar a mano un archivo registrado: evento y se actualiza archivos.nombre', renA.eventos[0].tipo === 'archivo_renombrado' && renA.archivos_manual[0].nombre === 'playa.jpg' && !('carpeta_id' in renA.archivos_manual[0]));
    const delSistemaMovido = planDe(await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, parents: ['c1'] } : n)), { reg: REG.map((r) => (r.drive_file_id === 'f2' ? { ...r, carpeta_id: 'c1' } : r)) }));
    afirmar('si la base de datos ya sabe que está ahí (lo movió «Sincronizar Drive»), no es un cambio manual', delSistemaMovido.eventos.length === 0 && delSistemaMovido.archivos_manual.length === 0 && delSistemaMovido.upserts.length === 1);
    const enCurso = planDe(await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, parents: ['c1'] } : n)), { reg: REG.map((r) => (r.drive_file_id === 'f2' ? { ...r, drive_pendiente: true } : r)) }));
    afirmar('si la secretaria lo tiene pendiente de mover, tampoco se toma por manual', enCurso.eventos.length === 0 && enCurso.archivos_manual.length === 0);
    const renSistema = planDe(await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, name: 'nuevo nombre.jpg' } : n)), { reg: REG.map((r) => (r.drive_file_id === 'f2' ? { ...r, nombre: 'nuevo nombre.jpg' } : r)) }));
    afirmar('un renombrado que ya figura en la base de datos (lo hizo la secretaria) no avisa', renSistema.eventos.length === 0);
    const sinRegistro = planDe(await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, parents: ['n1'] } : n)), { reg: [REG[0]] }));
    afirmar('un archivo que la secretaria no tiene registrado se mueve en la foto pero no avisa', sinRegistro.eventos.length === 0 && sinRegistro.archivos_manual.length === 0 && sinRegistro.upserts.length === 1);
  }

  console.log('Comparar: lo que desaparece y lo que vuelve');
  {
    const borrada = await comparar(sinC(BASE, { sin: ['c1', 'f1'] }));
    const p = planDe(borrada);
    afirmar('una carpeta borrada con su contenido es UN candidato (el de arriba), no uno por archivo', p.candidatos.length === 1 && p.candidatos[0].drive_id === 'c1' && borrada.length === 1 && borrada[0].inerte === false);
    afirmar('el candidato sabe cuántos archivos y subcarpetas llevaba y qué archivos registrados dependen de él', p.candidatos[0].n_archivos === 1 && p.candidatos[0].n_subcarpetas === 0 && JSON.stringify(p.candidatos[0].archivos_registrados) === '["f1"]' && JSON.stringify(p.candidatos[0].carpetas) === '["c1"]');
    afirmar('la comprobación con Drive pide el nombre, si está en la papelera y sus padres, y solo lectura', borrada[0].url.startsWith('https://www.googleapis.com/drive/v3/files/c1?fields=') && decodeURIComponent(borrada[0].url).includes('trashed') && borrada[0].url.includes('supportsAllDrives=true'));
    const dos = planDe(await comparar(sinC(BASE, { sin: ['c1', 'f1', 'f2'] })));
    afirmar('un archivo registrado que falta se confirma por separado', dos.candidatos.map((c) => c.drive_id).sort().join() === 'c1,f2');
    const noReg = planDe(await comparar(sinC(BASE, { sin: ['f2'] }), { reg: [REG[0]] }));
    afirmar('un archivo sin registrar que falta no se confirma ni avisa: solo se marca en la foto', noReg.candidatos.length === 0 && noReg.silenciosos.length === 1 && noReg.silenciosos[0].drive_id === 'f2' && noReg.silenciosos[0].eliminado_at !== null);
    const muchos = [...BASE, ...['a', 'b', 'c'].map((x) => d(`z${x}`, `Carpeta ${x}`, R, true))];
    const fotoMuchos = [...FOTO, ...['a', 'b', 'c'].map((x) => filaFoto(`z${x}`, 'carpeta', `Carpeta ${x}`, R, `Carpeta ${x}`))];
    const lote = planDe(await comparar(BASE, { foto: fotoMuchos, config: { ...CONFIG, lote_confirmar: 2 } }));
    afirmar('con más candidatos que el lote, se confirman los primeros y el resto espera', lote.candidatos.length === 2 && lote.pospuestos === 1);
    void muchos;
    const niveles = await comparar(BASE.filter((n) => n.id !== 'c1' && n.id !== 'f1').concat([d('c9', 'Otra', 'u1', true), d('f9', 'x.pdf', 'c9')]), { foto: [...FOTO, filaFoto('c9', 'carpeta', 'Otra', 'u1', 'Trabajo/Otra'), filaFoto('f9', 'archivo', 'x.pdf', 'c9', 'Trabajo/Otra/x.pdf')] });
    afirmar('una carpeta que no se tocó no se confirma', !planDe(niveles).candidatos.some((c) => c.drive_id === 'c9'));
    // Restauradas
    const fotoElim = FOTO.map((r) => (['c1', 'f1'].includes(r.drive_id) ? { ...r, eliminado_at: '2026-10-14T11:00:00Z' } : r));
    const rest = planDe(await comparar(BASE, { foto: fotoElim, reg: REG.map((r) => (r.drive_file_id === 'f1' ? { ...r, eliminado_at: '2026-10-14T11:00:00Z' } : r)) }));
    afirmar('lo que vuelve de la papelera: UN evento (la carpeta de arriba) y se reactivan sus archivos y carpetas', rest.eventos.length === 1 && rest.eventos[0].tipo === 'carpeta_restaurada' && rest.eventos[0].ruta_despues === 'Trabajo/Informes' && JSON.stringify(rest.restaurados_archivos) === '["f1"]' && JSON.stringify(rest.restaurados_carpetas) === '["c1"]', JSON.stringify(rest));
    afirmar('y vuelven a la foto sin fecha de eliminación', rest.upserts.length === 2 && rest.upserts.every((u) => u.eliminado_at === null));
    afirmar('la clave del evento depende de cuándo se eliminó (cada recuperación es un cambio distinto)', rest.eventos[0].previa === '2026-10-14T11:00:00Z');
    const soloArchivo = planDe(await comparar(BASE, { foto: FOTO.map((r) => (r.drive_id === 'f1' ? { ...r, eliminado_at: '2026-10-14T11:00:00Z' } : r)), reg: REG.map((r) => (r.drive_file_id === 'f1' ? { ...r, eliminado_at: '2026-10-14T11:00:00Z' } : r)) }));
    afirmar('un archivo registrado recuperado avisa como archivo', soloArchivo.eventos.length === 1 && soloArchivo.eventos[0].tipo === 'archivo_restaurado' && soloArchivo.restaurados_archivos[0] === 'f1');
  }

  console.log('Decidir');
  {
    const tree = sinC(BASE, { sin: ['c1', 'f1'] });
    const salida = await comparar(tree);
    const nodos = (resp) => ({ Comparar: salida, ...{} });
    void nodos;
    const decidir = (respuestas, extra = {}) => correr(nodo('decidir.js'), { input: respuestas, nodos: { Comparar: salida, ...extra } });

    const papelera = await decidir([{ statusCode: 200, body: { id: 'c1', name: 'Informes', trashed: true, parents: ['u1'] } }]);
    const etiquetas = papelera.map((x) => x.etiqueta);
    afirmar('en la papelera: registra, marca archivos, marca carpetas y deja la foto la última', etiquetas[0].startsWith('registrar 1') && etiquetas.includes('archivos eliminados') && etiquetas.includes('carpetas pedidas eliminadas') && etiquetas.at(-1).startsWith('foto del árbol'), etiquetas.join(' | '));
    const registro = papelera[0].cuerpo[0];
    afirmar('el registro lleva tipo, rutas, detalle y una clave única', registro.tipo === 'carpeta_eliminada' && registro.ruta_antes === 'Trabajo/Informes' && registro.ruta_despues === null && registro.detalle.archivos === 1 && registro.detalle.definitivo === false && registro.clave === 'carpeta_eliminada|c1|2026-10-14T10:00:00Z', JSON.stringify(registro));
    afirmar('inserta ignorando duplicados (repetir el flujo no duplica el registro)', papelera[0].url.endsWith('/registro_drive?on_conflict=clave') && papelera[0].prefer === 'resolution=ignore-duplicates,return=minimal' && papelera[0].metodo === 'POST');
    const marcaArch = papelera.find((x) => x.etiqueta === 'archivos eliminados');
    afirmar('marca los archivos registrados como eliminados y sin nada pendiente en Drive, solo los que no lo estaban', marcaArch.url.endsWith('/archivos?drive_file_id=in.(f1)&eliminado_at=is.null') && marcaArch.cuerpo.drive_pendiente === false && typeof marcaArch.cuerpo.eliminado_at === 'string' && marcaArch.metodo === 'PATCH');
    const marcaCarp = papelera.find((x) => x.etiqueta === 'carpetas pedidas eliminadas');
    afirmar('marca las carpetas pedidas como eliminadas (no se vuelven a crear solas)', marcaCarp.url.endsWith('/carpetas_pedidas?carpeta_id=in.(c1)&eliminada_at=is.null') && marcaCarp.cuerpo.drive_pendiente === false && typeof marcaCarp.cuerpo.eliminada_at === 'string');
    const foto = papelera.at(-1);
    afirmar('la foto marca como eliminado el candidato y lo que colgaba de él, con todas sus columnas', foto.cuerpo.map((f) => f.drive_id).sort().join() === 'c1,f1' && foto.cuerpo.every((f) => f.eliminado_at !== null && f.tipo && f.nombre && f.ruta && f.updated_at) && foto.url.endsWith('/drive_arbol?on_conflict=drive_id') && foto.prefer === 'resolution=merge-duplicates,return=minimal');

    const definitivo = await decidir([{ statusCode: 404, body: { error: { code: 404 } } }]);
    afirmar('404 = borrado del todo (definitivo)', definitivo[0].cuerpo[0].tipo === 'carpeta_eliminada' && definitivo[0].cuerpo[0].detalle.definitivo === true);

    const fuera = await decidir([{ statusCode: 200, body: { id: 'c1', name: 'Informes', trashed: false, parents: ['otro'] } }]);
    afirmar('existe y no está en la papelera = sacada de lo vigilado: evento «movida fuera», sin marcar archivos ni carpetas pedidas', fuera[0].cuerpo[0].tipo === 'carpeta_movida' && fuera[0].cuerpo[0].detalle.fuera === true && !fuera.some((x) => x.etiqueta === 'archivos eliminados' || x.etiqueta === 'carpetas pedidas eliminadas'));
    afirmar('pero sí se quita de la foto para no avisar otra vez', fuera.at(-1).cuerpo.every((f) => f.eliminado_at !== null));

    for (const [nombre, resp] of [['403', { statusCode: 403, body: {} }], ['500', { statusCode: 500, body: {} }], ['sin respuesta', {}]]) {
      const duda = await decidir([resp]);
      afirmar(`sin certeza (${nombre}): no se anota nada y se reintenta`, duda.length === 1 && duda[0].etiqueta === 'sin cambios' && duda[0].cuerpo.constructor === Object && Object.keys(duda[0].cuerpo).length === 0 && duda[0].url.endsWith('/registro_drive?id=eq.00000000-0000-0000-0000-000000000000'));
    }

    // Cambios manuales de archivos y restauraciones
    const movA = planDe(await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, parents: ['n1'], name: 'playa.jpg' } : n)))) && (await comparar(BASE.map((n) => (n.id === 'f2' ? { ...n, parents: ['n1'], name: 'playa.jpg' } : n))));
    const dm = await correr(nodo('decidir.js'), { input: [{}], nodos: { Comparar: movA } });
    const manual = dm.find((x) => x.etiqueta.startsWith('archivo cambiado a mano'));
    afirmar('un archivo cambiado a mano se actualiza con vigilado_at (para que no lo devuelvan a su sitio)', manual.url.endsWith('/archivos?drive_file_id=eq.f2') && manual.cuerpo.carpeta_id === 'n1' && manual.cuerpo.nombre === 'playa.jpg' && typeof manual.cuerpo.vigilado_at === 'string');
    const fotoElim = FOTO.map((r) => (['c1', 'f1'].includes(r.drive_id) ? { ...r, eliminado_at: '2026-10-14T11:00:00Z' } : r));
    const restComp = await comparar(BASE, { foto: fotoElim, reg: REG.map((r) => (r.drive_file_id === 'f1' ? { ...r, eliminado_at: '2026-10-14T11:00:00Z' } : r)) });
    const dr = await correr(nodo('decidir.js'), { input: [{}], nodos: { Comparar: restComp } });
    afirmar('recuperar: reactiva archivos y carpetas pedidas', dr.some((x) => x.etiqueta === 'archivos recuperados' && x.cuerpo.eliminado_at === null && x.url.includes('in.(f1)')) && dr.some((x) => x.etiqueta === 'carpetas pedidas recuperadas' && x.cuerpo.eliminada_at === null && x.url.includes('in.(c1)')));

    // Primera vez: solo la foto, en lotes
    const grande = Array.from({ length: 650 }, (_, i) => d(`g${i}`, `n${i}`, R));
    const baseGrande = await comparar(grande, { foto: [] });
    const dg = await correr(nodo('decidir.js'), { input: [{}], nodos: { Comparar: baseGrande } });
    afirmar('la primera vez solo escribe la foto (sin registro), en lotes de 300', dg.length === 3 && dg.every((x) => x.etiqueta.startsWith('foto del árbol')) && dg[0].cuerpo.length === 300 && dg[2].cuerpo.length === 50);

    // Nada que escribir
    const nada = await correr(nodo('decidir.js'), { input: [{}], nodos: { Comparar: await comparar(BASE) } });
    afirmar('sin cambios devuelve una escritura inocua para que el flujo siga hacia los avisos pendientes', nada.length === 1 && nada[0].etiqueta === 'sin cambios');

    // Ids repetidos y claves repetidas
    const dobles = await correr(nodo('decidir.js'), {
      input: [{}],
      nodos: { Comparar: [{ plan: { modo: 'normal', ahora: '2026-10-14T12:00:00Z', upserts: [filaFoto('a', 'archivo', 'x', R, 'x'), filaFoto('a', 'archivo', 'y', R, 'y')], eventos: [{ tipo: 'carpeta_creada', drive_id: 'a', nombre: 'x', ruta_antes: null, ruta_despues: 'x', detalle: {}, previa: 'nueva' }, { tipo: 'carpeta_creada', drive_id: 'a', nombre: 'x', ruta_antes: null, ruta_despues: 'x', detalle: {}, previa: 'nueva' }], archivos_manual: [], restaurados_archivos: [], restaurados_carpetas: [], silenciosos: [], candidatos: [], pospuestos: 0 } }] },
    });
    afirmar('dos filas con el mismo id en una petición se reducen a una; dos cambios con la misma clave, a uno', dobles.find((x) => x.etiqueta.startsWith('foto')).cuerpo.length === 1 && dobles[0].cuerpo.length === 1);
  }

  console.log('Redactar aviso');
  {
    const ahora = Date.now();
    const hace = (h) => new Date(ahora - h * 3600 * 1000).toISOString();
    const r = (tipo, nombre, antes, despues, detalle = {}, i = 1) => ({ id: `id-${i}`, created_at: `2026-10-14T1${i}:00:00Z`, tipo, nombre, ruta_antes: antes, ruta_despues: despues, detalle });
    const redactar = (filas, ultimoHace = 2, extra = {}) => correr(nodo('redactar.js'), { nodos: { 'Leer sin avisar': filas, 'Leer último mensaje': ultimoHace === null ? [{}] : [{ created_at: hace(ultimoHace) }] }, ...extra });

    afirmar('sin cambios pendientes no envía nada', (await redactar([{}])).length === 0);
    afirmar('con la ventana de 24 h cerrada no envía (sin plantillas); los cambios siguen sin avisar', (await redactar([r('carpeta_creada', 'X', null, 'X')], 30)).length === 0);
    afirmar('sin ningún mensaje tuyo tampoco', (await redactar([r('carpeta_creada', 'X', null, 'X')], null)).length === 0);
    await lanza('sin el número de destino en el entorno, lanza', redactar([r('carpeta_creada', 'X', null, 'X')], 2, { env: {} }), 'WHATSAPP_NUMERO_PERMITIDO');

    const una = (await redactar([r('carpeta_eliminada', 'Informes', 'Trabajo/Informes', null, { archivos: 3, subcarpetas: 1, definitivo: false })]))[0];
    afirmar('un cambio: una línea con el detalle y «Lo he anotado»', una.texto === '🗑️ Borraste la carpeta «Trabajo/Informes» (3 archivos y 1 subcarpeta), está en la papelera. Lo he anotado.', una.texto);
    afirmar('el cuerpo va a su número como texto libre y lleva los ids y la marca', una.cuerpo.to === '34600111222' && una.cuerpo.type === 'text' && una.cuerpo.text.body === una.texto && JSON.stringify(una.ids) === '["id-1"]' && typeof una.marca.notificado_at === 'string');

    const texto = async (fila) => (await redactar([fila]))[0].texto;
    afirmar('creada', (await texto(r('carpeta_creada', 'Proyectos', null, 'Trabajo/Proyectos', { subcarpetas: 0, archivos: 0 }))) === '📁 Creaste la carpeta «Trabajo/Proyectos». Lo he anotado.');
    afirmar('creada con contenido', (await texto(r('carpeta_creada', 'Trabajo', null, 'Trabajo', { subcarpetas: 2, archivos: 1 }))).includes('(1 archivo y 2 subcarpetas)'));
    afirmar('borrada definitivamente', (await texto(r('carpeta_eliminada', 'X', 'Fotos/X', null, { definitivo: true }))).includes('definitivamente'));
    afirmar('movida', (await texto(r('carpeta_movida', 'Informes', 'Trabajo/Informes', 'Informes', { renombrada: false }))) === '↪️ Moviste la carpeta «Trabajo/Informes» a «Informes». Lo he anotado.');
    afirmar('movida y renombrada', (await texto(r('carpeta_movida', 'Tesis', 'Trabajo/Informes', 'Tesis', { renombrada: true }))).includes('y la renombraste a «Tesis»'));
    afirmar('renombrada', (await texto(r('carpeta_renombrada', 'Informes', 'Trabajo/Informes anuales', 'Trabajo/Informes'))) === '✏️ Renombraste la carpeta «Trabajo/Informes anuales» a «Informes». Lo he anotado.');
    afirmar('recuperada', (await texto(r('carpeta_restaurada', 'Informes', null, 'Trabajo/Informes'))) === '♻️ Recuperaste la carpeta «Trabajo/Informes» de la papelera. Lo he anotado.');
    afirmar('sacada de lo vigilado', (await texto(r('carpeta_movida', 'X', 'X', null, { fuera: true, archivos: 2 }))).startsWith('📤 Sacaste la carpeta «X» de la zona que vigilo (2 archivos)'));
    afirmar('archivo borrado, movido, renombrado y recuperado', (await texto(r('archivo_eliminado', 'a.pdf', 'Trabajo/a.pdf', null))).startsWith('🗑️ Borraste el archivo «Trabajo/a.pdf»') && (await texto(r('archivo_movido', 'a.pdf', 'Entrada/a.pdf', 'Notas/a.pdf'))).startsWith('↪️ Moviste el archivo «Entrada/a.pdf» a «Notas/a.pdf»') && (await texto(r('archivo_renombrado', 'b.pdf', 'Trabajo/a.pdf', 'Trabajo/b.pdf'))).startsWith('✏️ Renombraste el archivo «Trabajo/a.pdf» a «b.pdf»') && (await texto(r('archivo_restaurado', 'a.pdf', null, 'Trabajo/a.pdf'))).startsWith('♻️ Recuperaste el archivo'));
    afirmar('una carpeta en la raíz sin ruta se escribe «(raíz)» y los caracteres de formato de WhatsApp no se cuelan', (await texto(r('carpeta_creada', '*a*_b_', null, '*a*_b_'))).includes('«ab»'));

    const varias = (await redactar([r('carpeta_creada', 'A', null, 'A', {}, 1), r('carpeta_eliminada', 'B', 'B', null, {}, 2)]))[0];
    afirmar('varios cambios: un solo mensaje con título y lista, en orden', varias.texto.startsWith('*Cambios en Drive*\n• 📁 Creaste la carpeta «A».\n• 🗑️ Borraste la carpeta «B»') && varias.texto.endsWith('Los he anotado todos.') && varias.ids.length === 2);

    const muchos = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, created_at: `2026-10-14T10:${String(i).padStart(2, '0')}:00Z`, tipo: 'carpeta_creada', nombre: `C${i}`, ruta_antes: null, ruta_despues: `C${i}`, detalle: {} }));
    const lim = (await redactar(muchos))[0];
    afirmar('más cambios que el máximo: se avisan los primeros y se dice cuántos quedan para el próximo aviso', lim.ids.length === 15 && lim.texto.includes('… y 5 más (te los digo en el próximo aviso).') && lim.ids[0] === 'id-0' && lim.ids[14] === 'id-14');
    const largos = Array.from({ length: 15 }, (_, i) => ({ id: `id-${i}`, created_at: `2026-10-14T10:${String(i).padStart(2, '0')}:00Z`, tipo: 'carpeta_creada', nombre: 'x'.repeat(300), ruta_antes: null, ruta_despues: 'y'.repeat(300), detalle: {} }));
    const corto = (await redactar(largos))[0];
    afirmar('el mensaje nunca pasa de 3800 caracteres', corto.texto.length <= 3800);
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const nodos = flujo.nodes.filter((n) => !n.type.includes('stickyNote'));
    const por = (nombre) => nodos.find((n) => n.name === nombre);
    afirmar('hay 18 nodos de trabajo y dos disparadores (cada 5 minutos y a mano)', nodos.length === 18 && por('Cada 5 minutos').parameters.rule.interval[0].minutesInterval === 5 && por('Disparador manual'));
    const drive = nodos.filter((n) => n.parameters.nodeCredentialType === 'googleDriveOAuth2Api');
    afirmar('Drive solo se LEE: ningún nodo de Drive escribe, mueve ni borra', drive.length === 5 && drive.every((n) => n.parameters.method === 'GET'));
    afirmar('toda llamada a Drive pide appProperties y la papelera excluida en los listados', ['Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Listar nivel 4'].every((n) => decodeURIComponent(por(n).parameters.url).includes('appProperties') && decodeURIComponent(por(n).parameters.url).includes('trashed = false')));
    afirmar('los niveles 2 a 4 usan una consulta válida aunque no haya carpetas (Drive da 404 con un id inventado)', ['Listar nivel 2', 'Listar nivel 3', 'Listar nivel 4'].every((n) => por(n).parameters.url.includes("name = 'a' and name != 'a'")));
    afirmar('las lecturas con varias filas y los listados se ejecutan una sola vez', ['Leer foto del árbol', 'Leer archivos registrados', 'Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Listar nivel 4', 'Leer sin avisar', 'Leer último mensaje'].every((n) => por(n).executeOnce === true));
    afirmar('un listado o una lectura que falla detiene el flujo (nada de continueRegularOutput)', ['Leer foto del árbol', 'Leer archivos registrados', 'Listar nivel 1', 'Listar nivel 4', 'Escribir en Supabase', 'Enviar WhatsApp'].every((n) => !por(n).onError));
    afirmar('confirmar con Drive devuelve la respuesta completa aunque sea un 404 y va de 5 en 5', por('Confirmar en Drive').parameters.options.response.response.neverError === true && por('Confirmar en Drive').parameters.options.response.response.fullResponse === true && por('Confirmar en Drive').parameters.options.batching.batch.batchSize === 5);
    afirmar('las escrituras van de una en una (la foto, la última)', por('Escribir en Supabase').parameters.options.batching.batch.batchSize === 1);
    const cadena = ['Configuración', 'Leer foto del árbol', 'Leer archivos registrados', 'Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Listar nivel 4', 'Comparar', 'Confirmar en Drive', 'Decidir', 'Escribir en Supabase', 'Leer sin avisar', 'Leer último mensaje', 'Redactar aviso', 'Enviar WhatsApp', 'Marcar avisados'];
    afirmar('la cadena de nodos está completa y en orden', cadena.slice(0, -1).every((n, i) => flujo.connections[n].main[0][0].node === cadena[i + 1]) && flujo.connections['Cada 5 minutos'].main[0][0].node === 'Configuración');
    afirmar('solo se marca como avisado lo que Meta aceptó (Marcar avisados va después de Enviar, y este no tiene onError)', flujo.connections['Enviar WhatsApp'].main[0][0].node === 'Marcar avisados' && !por('Enviar WhatsApp').onError && por('Marcar avisados').parameters.url.includes('notificado_at=is.null'));
    afirmar('Enviar WhatsApp usa la credencial Header Auth y la versión de la API de la configuración', por('Enviar WhatsApp').parameters.genericAuthType === 'httpHeaderAuth' && por('Enviar WhatsApp').parameters.url.includes('graph_version'));
    const ids = flujo.nodes.map((n) => n.id);
    afirmar('ids únicos', new Set(ids).size === ids.length);
    const json = JSON.stringify(flujo);
    afirmar('el JSON no lleva ningún ID real ni clave', !/AIza|eyJ|EAA[A-Za-z0-9]{20}/.test(json));
  }

  console.log('Los demás flujos ignoran lo eliminado a mano');
  {
    const url = (flujo, nombre) => flujo.nodes.find((n) => n.name === nombre).parameters.url;
    const principal = require('./generar-flujo.js').construirFlujo();
    const drive = require('./generar-drive.js').construirFlujo();
    const resumen = require('./generar-resumen.js').construirFlujo();
    const archivos = require('./generar-archivos.js').construirFlujo();
    afirmar('Principal: los archivos recientes y el recuento de «carpetas» no cuentan lo eliminado', url(principal, 'Leer archivos').includes('eliminado_at=is.null') && url(principal, 'Contar archivos').includes('eliminado_at=is.null'));
    afirmar('Sincronizar Drive: no mueve archivos eliminados ni recrea carpetas eliminadas', url(drive, 'Leer pendientes').includes('eliminado_at=is.null') && url(drive, 'Leer carpetas pendientes').includes('eliminada_at=is.null'));
    afirmar('Resumen diario: no lista archivos eliminados como pendientes', url(resumen, 'Leer archivos').includes('eliminado_at=is.null'));
    const nodoArch = archivos.nodes.find((n) => n.parameters?.url?.includes('/archivos?'));
    afirmar('Recordatorio de archivos: no recuerda archivos eliminados', nodoArch.parameters.url.includes('eliminado_at=is.null'));
    const planificar = fs.readFileSync(path.join(__dirname, 'flujo', 'planificar.js'), 'utf8');
    afirmar('«dame los archivos» (ver_archivos) no incluye lo eliminado', planificar.includes('items(tipo)&eliminado_at=is.null'));
    afirmar('pedir otra vez una carpeta que se borró a mano la reactiva (eliminada_at a nulo)', planificar.includes('{ ruta, drive_pendiente: true, eliminada_at: null }'));
    const comun = fs.readFileSync(path.join(__dirname, 'flujo-drive', 'comun.js'), 'utf8');
    afirmar('las carpetas que crea la secretaria llevan su marca para que «Vigilar Drive» no las tome por manuales', comun.includes("appProperties: { secretaria: '1' }"));
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
