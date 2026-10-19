// Nodo "Planificar": convierte la respuesta del modelo en las peticiones REST que hay que
// ejecutar contra Supabase. No escribe nada por sí mismo: devuelve un item por petición y el
// nodo "Escribir en Supabase" las ejecuta en orden.
//
// Validación tolerante:
//   - una clave ausente cuenta como null;
//   - intención, tipo y fechas ISO inválidos siguen siendo error.
// Cualquier error deja el mensaje con procesado = false y el motivo en la columna "error".
//
// Seguridad: el modelo solo aporta parámetros, nunca SQL ni URLs. Los ids que cita (corregir,
// completar, cancelar) son referencias cortas (i1, i2…) a los items pendientes que se le dieron, y los archivos que cita (a1, a2…) son
// referencias a los archivos recibidos; la ruta de una carpeta pedida la valida este código; las columnas
// que puede cambiar y los filtros de una consulta son listas cerradas.
//
// Las consultas (GET) no pasan por "Escribir en Supabase": n8n no permite una expresión en
// "Send Body", así que el GET lo ejecuta el nodo "Leer consulta" con meta.consulta_url.

const INTENCIONES = ['guardar', 'consultar', 'corregir', 'completar', 'recordar', 'aclarar', 'descartar', 'charla', 'archivar', 'carpetas', 'cancelar', 'ver_archivos', 'crear_carpeta', 'borrar_drive', 'horario', 'ayuda', 'proyectos', 'proyecto'];
// Intenciones que no crean items (si el modelo devuelve alguno, se ignora)
const SIN_ITEMS = ['charla', 'horario', 'archivar', 'carpetas', 'cancelar', 'completar', 'ver_archivos', 'crear_carpeta', 'borrar_drive', 'ayuda', 'proyectos', 'proyecto'];
const NIVELES_CARPETA_MAX = 3; // niveles de una carpeta pedida (Fotos/Viajes/2026)
const MAX_CARPETAS_PEDIDAS = 10; // carpetas que se pueden pedir en un solo mensaje
const TIPOS = ['evento', 'tarea', 'lista', 'nota'];
const ESTADOS = ['pendiente', 'hecho', 'archivado'];
const CAMPOS_FECHA = ['fecha_inicio', 'fecha_fin', 'fecha_limite', 'recordar_en'];
// "etiquetas" se sigue aceptando por compatibilidad, pero ya no se pide ni se enseña
const CAMPOS_CORREGIBLES = ['tipo', 'titulo', 'contenido', 'anadir_contenido', ...CAMPOS_FECHA, 'lista', 'proyecto', 'etiquetas'];
// Los listados llevan solo el título; el contenido (el contexto) solo hace falta para marcar «…» y para el detalle completo. No se pide
// el mensaje original del usuario: saldría idéntico en todo lo que nació de un mismo mensaje.
const CAMPOS_CONSULTA = 'tipo,titulo,contenido,lista,estado,fecha_inicio,fecha_fin,fecha_limite,recordar_en,proyecto';
// Tipos que admite el filtro de cancelar y completar: los de los items más "alarma" (tarea con hora de aviso y sin fecha límite, como en los listados)
const TIPOS_FILTRO = [...TIPOS, 'alarma'];
// Cancelar o completar más de estos elementos de una vez se pregunta antes (se enseña la lista)
const MAX_SIN_CONFIRMAR = 3;
const MAX_TEXTO_BUSCAR = 40;
const MAX_PENDIENTES_VISTOS = 200; // los que lee "Leer items pendientes" (si hay más, un filtro no los ve todos)
const MAX_FILAS_CONSULTA = 500;
const MAX_TEXTO_ERROR = 500;

class ErrorValidacion extends Error {}
const fallo = (msg) => {
  throw new ErrorValidacion(msg);
};

const sinAcentos = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

const textoONull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

const fechaValida = (s) => typeof s === 'string' && DateTime.fromISO(s, { setZone: true }).isValid;

// --- Hora de Madrid (con el cambio de hora de marzo y octubre) ---

function offsetMadridMin(ms) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'longOffset' }).formatToParts(new Date(ms));
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(partes.find((p) => p.type === 'timeZoneName')?.value ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// Instante UTC de una hora local de Madrid. El offset se evalúa dos veces por si el cambio de hora cae en medio.
function madridAUtc(anio, mes, dia, h = 0, mi = 0) {
  const base = Date.UTC(anio, mes - 1, dia, h, mi);
  const candidato = base - offsetMadridMin(base) * 60000;
  return new Date(base - offsetMadridMin(candidato) * 60000);
}

// --- Normalizaciones de campos (las comparten guardar, corregir y consultar) ---

function normalizarFecha(valor, ref) {
  const f = valor ?? null;
  if (f !== null && !fechaValida(f)) fallo(`${ref} no es una fecha ISO válida: ${f}`);
  return f;
}

const normalizarLista = (valor) => {
  const l = textoONull(valor);
  return l ? l.toLowerCase() : null;
};

const normalizarEtiquetas = (valor) =>
  Array.isArray(valor) ? valor.filter((e) => typeof e === 'string' && e.trim() !== '').map((e) => e.trim()) : [];

// Nombre de proyecto: sin barras ni caracteres de control (como la restricción de la tabla), de hasta 60 caracteres, y escrito como figura en
// la lista de proyectos si ya existe (sin distinguir mayúsculas ni tildes). Uno que no existe se devuelve tal cual: la base de datos lo
// crea al guardar el item, salvo que se parezca a uno que ya existe, en cuyo caso se pregunta (comprobarProyectos).
function normalizarProyecto(valor, proyectos = [], avisos, ref) {
  let texto = textoONull(valor);
  if (!texto) return null;
  texto = texto.replace(/[\\/\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  if (!texto) return null;
  if (/^proyecto\s+/i.test(texto) && texto.length > 9) texto = texto.replace(/^proyecto\s+/i, '');
  const canonico = (proyectos ?? []).find((p) => sinAcentos(p) === sinAcentos(texto));
  if (canonico) return canonico;
  avisos.push(`${ref}: proyecto nuevo: ${texto}`);
  return texto;
}

function normalizarItem(it, i, config, avisos) {
  const ref = `items[${i}]`;
  if (typeof it !== 'object' || it === null || Array.isArray(it)) fallo(`${ref} no es un objeto`);
  if (!TIPOS.includes(it.tipo)) fallo(`${ref}.tipo no permitido: ${it.tipo}`);
  const titulo = textoONull(it.titulo);
  if (!titulo) fallo(`${ref}.titulo vacío`);

  const fechas = {};
  for (const c of CAMPOS_FECHA) fechas[c] = normalizarFecha(it[c], `${ref}.${c}`);
  // Solo las tareas llevan recordatorio (la base de datos también lo borra de lo que no sea una tarea)
  if (it.tipo !== 'tarea' && fechas.recordar_en !== null) {
    avisos.push(`${ref}: recordar_en solo se usa en tareas, se ignora`);
    fechas.recordar_en = null;
  }

  let esperaArchivo = false;
  if (it.espera_archivo !== undefined && it.espera_archivo !== null) {
    if (typeof it.espera_archivo === 'boolean') esperaArchivo = it.espera_archivo;
    else avisos.push(`${ref}: espera_archivo no es booleano (${it.espera_archivo}), se usa false`);
  }

  let confianza = null;
  if (typeof it.confianza === 'number' && it.confianza >= 0 && it.confianza <= 1) {
    confianza = Math.round(it.confianza * 100) / 100;
  } else if (it.confianza !== undefined && it.confianza !== null) {
    avisos.push(`${ref}: confianza fuera de rango (${it.confianza}), se ignora`);
  }

  return {
    tipo: it.tipo,
    titulo,
    contenido: textoONull(it.contenido),
    ...fechas,
    lista: normalizarLista(it.lista),
    proyecto: normalizarProyecto(it.proyecto, config.proyectos, avisos, ref),
    etiquetas: normalizarEtiquetas(it.etiquetas),
    confianza,
    espera_archivo: esperaArchivo,
  };
}

// --- Corregir y completar ---

// "refs" traduce las referencias cortas que vio el modelo (i1, i2…) a los ids reales de la base de datos
function validarIds(ids, refs, ref) {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === 'string' && i !== '')) {
    fallo(`${ref} necesita una lista de ids`);
  }
  if (Object.keys(refs).length === 0) fallo(`${ref}: no hay items pendientes sobre los que actuar`);
  const fuera = ids.filter((i) => !Object.prototype.hasOwnProperty.call(refs, i));
  if (fuera.length) fallo(`${ref}: ids que no están entre los items pendientes: ${fuera.join(', ')}`);
  return [...new Set(ids.map((i) => refs[i]))];
}

function normalizarCambios(cambios, config, avisos) {
  if (typeof cambios !== 'object' || cambios === null || Array.isArray(cambios)) fallo('corregir: cambios no es un objeto');
  if ('asociar_a' in cambios) fallo('corregir: asociar archivos (asociar_a) aún no implementado');

  const out = {};
  for (const [k, v] of Object.entries(cambios)) {
    if (!CAMPOS_CORREGIBLES.includes(k)) {
      avisos.push(`corregir: el campo "${k}" no es editable, se ignora`);
      continue;
    }
    const ref = `cambios.${k}`;
    if (k === 'tipo') {
      if (!TIPOS.includes(v)) fallo(`${ref} no permitido: ${v}`);
      out.tipo = v;
    } else if (k === 'titulo') {
      const t = textoONull(v);
      if (!t) fallo(`${ref} vacío`);
      out.titulo = t;
    } else if (k === 'contenido') out.contenido = textoONull(v);
    else if (k === 'anadir_contenido') {
      const t = textoONull(v);
      if (t) out.anadir_contenido = t;
      else avisos.push('cambios.anadir_contenido vacío, se ignora');
    } else if (CAMPOS_FECHA.includes(k)) out[k] = normalizarFecha(v, ref);
    else if (k === 'lista') out.lista = normalizarLista(v);
    else if (k === 'proyecto') out.proyecto = normalizarProyecto(v, config.proyectos, avisos, ref);
    else if (k === 'etiquetas') out.etiquetas = normalizarEtiquetas(v);
  }

  // Añadir y sustituir el contenido a la vez es contradictorio: manda añadir (no se pierde lo que había)
  if ('anadir_contenido' in out && 'contenido' in out) {
    avisos.push('corregir: contenido y anadir_contenido a la vez; se añade y no se sustituye');
    delete out.contenido;
  }
  if (Object.keys(out).length === 0) fallo('corregir sin cambios válidos');
  return out;
}

// --- Cancelar y completar: ids concretos o un filtro ---
// El modelo cita elementos concretos (item_ids, referencias i1…) o, para "todos los pensamientos", "todas las tareas", "toda la lista de
// la compra", un filtro {tipo, lista, proyecto}. El filtro lo resuelve este código sobre los elementos pendientes que vio el
// modelo (enumerar decenas de ids era donde fallaba). Sin proyecto, el filtro abarca solo lo que no es de ningún proyecto (como en los
// listados, donde lo de los proyectos va aparte).
function normalizarSeleccion(valor, refs, ref, config, avisos) {
  if (Array.isArray(valor)) valor = { item_ids: valor };
  if (typeof valor === 'string') valor = { item_ids: [valor] };
  const v = valor && typeof valor === 'object' ? valor : {};
  let ids = v.item_ids;
  if (ids === undefined && typeof v.item_id === 'string') ids = [v.item_id];
  const hayIds = Array.isArray(ids) && ids.length > 0;
  const f = v.filtro && typeof v.filtro === 'object' && !Array.isArray(v.filtro) ? v.filtro : null;
  if (hayIds && f) avisos.push(`${ref}: trae ids y filtro a la vez; se usan los ids`);
  if (hayIds) return { ids: validarIds(ids, refs, `${ref}.item_ids`) };
  if (f) {
    let tipo = null;
    if (f.tipo !== undefined && f.tipo !== null && f.tipo !== '') {
      if (!TIPOS_FILTRO.includes(f.tipo)) fallo(`${ref}.filtro.tipo no permitido: ${f.tipo}`);
      tipo = f.tipo;
    }
    return {
      filtro: {
        tipo,
        lista: normalizarLista(f.lista),
        proyecto: textoONull(f.proyecto) ? normalizarProyecto(f.proyecto, config.proyectos, [], `${ref}.filtro.proyecto`) : null,
      },
    };
  }
  // Nada que hacer (lista vacía o ausente): no es un fallo, se contesta con honestidad
  return { ids: [] };
}

// Memoria de hechos del usuario: el nombre con el que quiere que se le llame vive con un término fijo, como el de la secretaria
const NOMBRE_USUARIO = 'nombre del usuario';
const MAX_TERMINO = 60;
const MAX_SIGNIFICADO = 300;
// Solo un término que diga «usuario»: «mi nombre» o «cómo llamarme» son ambiguos (justo tras «¿cómo quieres llamarme?» hablan de la secretaria)
const esNombreDelUsuario = (termino) => /\busuario\b/.test(sinAcentos(termino ?? ''));
const NOMBRE_VALIDO_USUARIO = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,59}$/u;
// La charla la redacta el modelo, pero nunca puede decir que ha hecho algo: no escribe nada
const PROMETE_ALGO = /\b(?:he (?:apuntado|guardado|anadido|anotado|borrado|quitado|cambiado|puesto|creado|movido)|(?:te )?(?:lo )?(?:he )?apuntad[oa]s?|guardad[oa]s?|te avis(?:o|are)|(?:lo )?recordare)\b/;
const TEXTO_CHARLA_SEGURO = 'No he apuntado nada. Si quieres que apunte o consulte algo, dímelo.';
// (si la charla trae un dato que sí se guarda en la memoria, Resultado ya lo dice: el texto seguro sería contradictorio)
function textoCharla(texto, guardaDato = false) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!t || PROMETE_ALGO.test(sinAcentos(t))) return guardaDato ? 'De acuerdo.' : TEXTO_CHARLA_SEGURO;
  return t;
}

// --- Memoria permanente: verla, olvidar un dato y el tope ---
const MAX_MEMORIA = 50;
const VACIAS_MEMORIA = new Set(['que', 'del', 'los', 'las', 'una', 'uno', 'con', 'por', 'para', 'sobre', 'mis', 'tus', 'esto', 'eso', 'dato']);
const filasDeMemoria = (lista) =>
  (Array.isArray(lista) ? lista : []).filter((m) => m && typeof m.id === 'string' && typeof m.termino === 'string' && typeof m.significado === 'string');
const esNombreSecretaria = (m) => sinAcentos(m.termino) === NOMBRE_TERMINO;
function lineaMemoria(m) {
  const t = sinAcentos(m.termino);
  const etiqueta = t === NOMBRE_TERMINO ? 'Mi nombre' : t === NOMBRE_USUARIO ? 'Cómo te llamo' : limpiarTxt(m.termino);
  return `${etiqueta}: ${limpiarTxt(m.significado)}`;
}
// La lista numerada: el número es el que usa /forget (mismo orden que «Leer memoria»: por término)
function textoMemoria(filas, pista = false) {
  if (filas.length === 0) return 'Todavía no recuerdo nada de ti. Si me cuentas algo que deba saber («para que lo sepas: Emma es mi hermana»), lo guardo.';
  const lineas = filas.map((m, i) => `${i + 1}. ${lineaMemoria(m)}`);
  return [
    `*Lo que recuerdo* (${filas.length} de ${MAX_MEMORIA})`,
    ...lineas,
    pista ? 'Dime cuál olvido: /forget y su número (por ejemplo /forget 2).' : 'Para olvidar uno: /forget y su número (por ejemplo /forget 2), o «borra de tu memoria lo de…».',
  ].join('\n');
}
// Los datos que encajan con lo que dice el usuario: todas sus palabras (de 3 letras o más) en el término o el significado
function buscarEnMemoria(filas, texto) {
  const palabras = sinAcentos(texto).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !VACIAS_MEMORIA.has(w));
  if (palabras.length === 0) return [];
  return filas.filter((m) => {
    const en = sinAcentos(`${m.termino} ${m.significado}`);
    return palabras.every((w) => en.includes(w.length > 4 ? w.replace(/s$/, '') : w));
  });
}
const TEXTO_NOMBRE_NO_SE_OLVIDA = 'Mi nombre no lo olvido (sin él te lo volvería a preguntar). Si quieres otro, dímelo: «te llamas Marta».';
const textoMemoriaLlena = (termino) => `Mi memoria está llena (${MAX_MEMORIA} datos) y no he guardado «${limpiarTxt(termino)}». Mira /memory y olvida alguno con /forget.`;

// --- Horario fijo semanal ---
const DIAS_SEMANA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const MAX_HORARIO = 40; // bloques guardados como mucho (uno por día y franja)
const HORA_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const aMinutos = (h) => {
  const m = HORA_HHMM.exec(String(h ?? '').trim().slice(0, 5).padStart(5, '0'));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (h) => String(h ?? '').trim().slice(0, 5).padStart(5, '0');
const filasDeHorario = (lista) =>
  (Array.isArray(lista) ? lista : []).filter(
    (b) => b && typeof b.id === 'string' && typeof b.titulo === 'string' && Number.isInteger(b.dia_semana) && b.dia_semana >= 1 && b.dia_semana <= 7 && aMinutos(b.hora_inicio) !== null && aMinutos(b.hora_fin) !== null,
  );
const lineaHorario = (b) => `${DIAS_SEMANA[b.dia_semana]} de ${hhmm(b.hora_inicio)} a ${hhmm(b.hora_fin)}: ${limpiarTxt(b.titulo)}`;
// La lista numerada (por día y hora, como la lee «Leer horario»): el número es el de /horario quitar N
function textoMiHorario(filas, pista = false) {
  if (filas.length === 0) return 'No tienes horario fijo. Dímelo con días y horas («trabajo los viernes de 16 a 20», «voy a natación lunes y miércoles de 19 a 20») y te avisaré si apuntas una cita que choque.';
  return [
    '*Tu horario fijo*',
    ...filas.map((b, i) => `${i + 1}. ${lineaHorario(b)}`),
    pista ? 'Dime cuál quito: /horario quitar y su número (por ejemplo /horario quitar 2).' : 'Para quitar uno: /horario quitar y su número (por ejemplo /horario quitar 2).',
  ].join('\n');
}
// Día de la semana (1 = lunes) y minuto del día en Madrid de un instante
const fmtPartesMadrid = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ISO_DIA = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function partesMadrid(ms) {
  const p = Object.fromEntries(fmtPartesMadrid.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { dia: ISO_DIA[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}

const esAlarmaItem = (r) => r.tipo === 'tarea' && Boolean(r.recordar_en) && !r.fecha_limite;

// Los elementos pendientes (con ids reales) que cumplen el filtro
function resolverFiltro(filtro, pendientes) {
  return pendientes.filter((r) => {
    if (filtro.tipo === 'alarma' && !esAlarmaItem(r)) return false;
    if (filtro.tipo === 'tarea' && (r.tipo !== 'tarea' || esAlarmaItem(r))) return false;
    if (filtro.tipo && !['alarma', 'tarea'].includes(filtro.tipo) && r.tipo !== filtro.tipo) return false;
    if (filtro.lista && sinAcentos(r.lista) !== sinAcentos(filtro.lista)) return false;
    if (filtro.proyecto ? sinAcentos(r.proyecto) !== sinAcentos(filtro.proyecto) : Boolean(r.proyecto)) return false;
    return true;
  });
}

// Texto de búsqueda de una consulta: solo letras, números y espacios (va dentro de un filtro ilike de PostgREST, entre comillas)
function normalizarBuscar(valor) {
  const t = textoONull(valor);
  if (!t) return null;
  const limpio = t.normalize('NFC').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTO_BUSCAR).trim();
  return limpio || null;
}

// --- Consultar ---

// Una fecha de la consulta: "2026-10-11" (día completo, hora de Madrid) o un ISO con hora.
// "hasta" con solo el día es exclusivo: llega hasta el final de ese día.
function aInstante(valor, ref, esHasta) {
  const v = textoONull(valor);
  if (v === null) return null;
  if (!fechaValida(v)) fallo(`${ref} no es una fecha ISO válida: ${v}`);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = m.slice(1).map(Number);
    return esHasta ? { fecha: madridAUtc(y, mo, d + 1), exclusivo: true } : { fecha: madridAUtc(y, mo, d), exclusivo: false };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v);
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    return { fecha: madridAUtc(y, mo, d, h, mi), exclusivo: false }; // sin zona: hora de Madrid
  }
  return { fecha: new Date(v), exclusivo: false };
}

function normalizarConsulta(c, config, avisos) {
  const hayObjeto = typeof c === 'object' && c !== null && !Array.isArray(c);
  if (c !== null && c !== undefined && !hayObjeto) avisos.push('consulta no es un objeto: se muestra todo lo pendiente');
  const q = hayObjeto ? c : {};

  // «alarma» no es un tipo de la base de datos: es una tarea con hora de aviso y sin fecha límite (vista «alarmas»). «Qué tareas tengo» es la
  // vista «tareas» (sin las alarmas). Las vistas las usan también los atajos por código.
  let tipo = null;
  let vista = ['alarmas', 'tareas'].includes(q.vista) ? q.vista : null;
  if (q.tipo !== undefined && q.tipo !== null && q.tipo !== '') {
    if (q.tipo === 'alarma') {
      tipo = 'tarea';
      vista = 'alarmas';
    } else if (TIPOS.includes(q.tipo)) tipo = q.tipo;
    else avisos.push(`consulta.tipo "${q.tipo}" no es un tipo: se muestra todo`);
  }
  if (vista && tipo !== 'tarea') vista = null;

  let estado = 'pendiente'; // por defecto, lo hecho y lo archivado no se muestra
  if (q.estado !== undefined && q.estado !== null && q.estado !== '') {
    if (ESTADOS.includes(q.estado)) estado = q.estado;
    else avisos.push(`consulta.estado "${q.estado}" no es un estado: se usa "pendiente"`);
  }

  return {
    tipo,
    vista,
    lista: normalizarLista(q.lista),
    proyecto: textoONull(q.proyecto) ? normalizarProyecto(q.proyecto, config.proyectos, [], 'consulta.proyecto') : null,
    buscar: normalizarBuscar(q.buscar),
    completo: q.completo === true,
    estado,
    desde: aInstante(q.desde, 'consulta.desde', false),
    hasta: aInstante(q.hasta, 'consulta.hasta', true),
  };
}

function urlConsulta(base, q) {
  const partes = [`select=${CAMPOS_CONSULTA}`, `estado=eq.${q.estado}`, 'order=created_at.desc', `limit=${MAX_FILAS_CONSULTA}`];
  if (q.tipo) partes.push(`tipo=eq.${q.tipo}`);
  if (q.vista === 'alarmas') partes.push('recordar_en=not.is.null', 'fecha_limite=is.null');
  if (q.lista) partes.push(`lista=eq.${encodeURIComponent(q.lista)}`);
  if (q.proyecto) partes.push(`proyecto=eq.${encodeURIComponent(q.proyecto)}`);
  // Búsqueda por tema en el título o en el contenido (el texto ya viene limpio: letras, números y espacios). Si también hay un rango de
  // fechas, las dos condiciones se combinan con and() porque PostgREST solo admite un parámetro "or".
  // Los espacios pasan a "*" (comodín): "casero nuevo" encuentra "casero … nuevo" y no hacen falta comillas
  const patron = q.buscar ? `*${q.buscar.replace(/ /g, '*')}*` : null;
  const busqueda = patron ? `or(titulo.ilike.${patron},contenido.ilike.${patron})` : null;
  if (busqueda && !(q.desde || q.hasta)) partes.push(`or=${encodeURIComponent(busqueda.slice(2))}`);
  if (q.desde || q.hasta) {
    // Con rango, solo cuentan los items con fecha: la de inicio (citas), la límite (tareas) o la del aviso (alarmas: «qué tengo hoy» las incluye)
    const rango = (campo) => {
      const c = [];
      if (q.desde) c.push(`${campo}.gte."${q.desde.fecha.toISOString()}"`);
      if (q.hasta) c.push(`${campo}.${q.hasta.exclusivo ? 'lt' : 'lte'}."${q.hasta.fecha.toISOString()}"`);
      return c.length > 1 ? `and(${c.join(',')})` : c[0];
    };
    const fechas = `or(${rango('fecha_inicio')},${rango('fecha_limite')},${rango('recordar_en')})`;
    if (busqueda) partes.push(`and=${encodeURIComponent(`(${fechas},${busqueda})`)}`);
    else partes.push(`or=${encodeURIComponent(fechas.slice(2))}`);
  }
  return `${base}/items?${partes.join('&')}`;
}

// Devuelve { datos, avisos } o lanza ErrorValidacion
// Término de la memoria donde se guarda el nombre que el usuario le pone a la secretaria (sin acentos ni mayúsculas, como termino_norm)
const NOMBRE_TERMINO = 'nombre de la secretaria';
// Por debajo de esta confianza no se guarda nada: se pregunta (regla 5 del prompt)
const UMBRAL_CONFIANZA = 0.7;
const NOMBRE_TIPO = { evento: 'cita', tarea: 'tarea', lista: 'lista', nota: 'pensamiento' };
const TEXTO_QUE_BORRAR_DRIVE = 'Dime qué carpeta o qué archivo de Drive quieres borrar (por ejemplo «borra la carpeta Fotos/Viajes»). Te enseñaré lo que se borraría antes de hacerlo.';
const TEXTO_PEDIR_NOMBRE =
  'Antes de empezar: ¿cómo quieres llamarme? Elige el nombre que quieras; lo recordaré siempre y puedes cambiármelo cuando quieras. ' +
  '(Lo que acabas de escribirme queda guardado pero sin procesar: mándamelo otra vez cuando me hayas puesto nombre.)';

function validarRespuesta(texto, config, refs, refsArchivos = {}, opciones = {}) {
  const limpio = String(texto)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let datos;
  try {
    datos = JSON.parse(limpio);
  } catch (e) {
    fallo(`JSON no válido (${e.message})`);
  }
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) fallo('la raíz no es un objeto');
  if (!INTENCIONES.includes(datos.intencion)) fallo(`intencion no permitida: ${datos.intencion}`);

  const avisos = [];
  const itemsBrutos = datos.items ?? [];
  if (!Array.isArray(itemsBrutos)) fallo('items no es una lista');
  const items = itemsBrutos.map((it, i) => normalizarItem(it, i, config, avisos));

  const respuestaUsuario = typeof datos.respuesta_usuario === 'string' ? datos.respuesta_usuario : '';
  let pregunta = textoONull(datos.pregunta);

  if (datos.intencion === 'guardar' && items.length === 0) fallo('guardar sin items');

  let archivos = null;
  if (datos.archivos !== undefined && datos.archivos !== null) {
    if (datos.intencion === 'guardar' || datos.intencion === 'archivar') archivos = normalizarArchivos(datos.archivos, datos.intencion, refsArchivos, avisos);
    else if (Array.isArray(datos.archivos?.refs) && datos.archivos.refs.length > 0) avisos.push(`archivos solo se usa en guardar y archivar, se ignora (${datos.intencion})`);
  }
  if (datos.intencion === 'archivar' && !archivos) fallo('archivar necesita archivos con refs y carpeta');
  if (datos.intencion === 'guardar' && archivos && items.length !== 1) fallo('guardar con archivos necesita exactamente un item');
  if (SIN_ITEMS.includes(datos.intencion) && items.length > 0) {
    avisos.push(`${datos.intencion} no crea items: se ignoran los que ha devuelto el modelo`);
    items.length = 0;
  }

  if (datos.intencion === 'aclarar') {
    if (!pregunta && respuestaUsuario.trim()) {
      avisos.push('aclarar sin pregunta: se usa respuesta_usuario');
      pregunta = respuestaUsuario.trim();
    }
    if (!pregunta) fallo('aclarar sin pregunta');
  }

  let memoriaNueva = null;
  let nombreNuevo = null;
  let nombreUsuario = null;
  // Un dato duradero del usuario («Emma es mi hermana», «llámame Ana») puede venir también con guardar,
  // charla o aclarar (memoria_nueva junto a lo demás). Ahí nunca puede cambiar el nombre de la secretaria: eso solo con recordar.
  if (datos.intencion !== 'recordar' && datos.memoria_nueva && typeof datos.memoria_nueva === 'object' && ['guardar', 'charla', 'aclarar'].includes(datos.intencion)) {
    let termino = textoONull(datos.memoria_nueva.termino);
    const significado = textoONull(datos.memoria_nueva.significado);
    if (termino && significado && sinAcentos(termino) !== NOMBRE_TERMINO && termino.length <= MAX_TERMINO && significado.length <= MAX_SIGNIFICADO) {
      if (!esNombreDelUsuario(termino)) memoriaNueva = { termino, significado };
      else if (NOMBRE_VALIDO_USUARIO.test(significado)) {
        memoriaNueva = { termino: NOMBRE_USUARIO, significado };
        nombreUsuario = significado;
      } else avisos.push('nombre del usuario no válido: se ignora');
    } else if (termino || significado) avisos.push(`memoria_nueva no válida junto a ${datos.intencion}: se ignora`);
  }
  if (datos.intencion === 'recordar') {
    let termino = textoONull(datos.memoria_nueva?.termino);
    const significado = textoONull(datos.memoria_nueva?.significado);
    if (!termino || !significado) fallo('recordar: memoria_nueva necesita termino y significado');
    // El nombre del USUARIO (cómo quiere que le llamen) no es el de la secretaria, aunque llegue justo tras preguntarle el suyo
    // («La reina de España» → «no tú no, yo»)
    if (esNombreDelUsuario(termino)) {
      if (!NOMBRE_VALIDO_USUARIO.test(significado)) fallo(`el nombre no es válido (hasta 60 letras, sin signos raros): ${significado.slice(0, 60)}`);
      memoriaNueva = { termino: NOMBRE_USUARIO, significado };
      nombreUsuario = significado;
    }
    // El nombre de la secretaria vive en la memoria con un término fijo. Si la última pregunta era «¿cómo quieres llamarme?», lo que
    // responda el usuario es ese nombre sea cual sea el término que haya puesto el modelo; también cuando pide cambiárselo.
    // (con la pregunta del nombre abierta solo cuenta como nombre si el término que eligió el modelo habla de un nombre; si no, es otro término)
    const hablaDeNombre = /nombre|secretari|llam|apodo|mote/.test(sinAcentos(termino));
    if (nombreUsuario) {
      // ya resuelto arriba
    } else if ((opciones.esperaNombre && hablaDeNombre) || sinAcentos(termino) === NOMBRE_TERMINO) {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,39}$/u.test(significado)) fallo(`el nombre no es válido (hasta 40 letras, sin signos raros): ${significado.slice(0, 60)}`);
      termino = NOMBRE_TERMINO;
      nombreNuevo = significado;
    }
    if (!nombreUsuario) memoriaNueva = { termino, significado };
  }

  let correccion = null;
  if (datos.intencion === 'corregir') {
    const c = datos.correccion;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) fallo('corregir: falta correccion (debe ser un objeto con item_ids y cambios)');
    let ids = c.item_ids;
    if (ids === undefined && typeof c.item_id === 'string') {
      avisos.push('corregir: item_id suelto, se usa como lista de un elemento');
      ids = [c.item_id];
    }
    // Cambiar de tipo: el modelo solo dice a cuál (alarma, cita o tarea) y, si el usuario la dio, la fecha nueva. Las fechas y el tipo los
    // mueve Planificar; los cambios que el modelo ponga además (título…) se respetan. Con convertir_a, "cambios" puede venir vacío.
    const convertir = ['alarma', 'cita', 'tarea'].includes(c.convertir_a) ? c.convertir_a : null;
    if (c.convertir_a != null && c.convertir_a !== '' && !convertir) avisos.push(`correccion.convertir_a "${c.convertir_a}" no es alarma, cita ni tarea: se ignora`);
    const cuando = convertir && textoONull(c.cuando) ? normalizarFecha(c.cuando, 'correccion.cuando') : null;
    const cambiosVacios = c.cambios == null || (typeof c.cambios === 'object' && !Array.isArray(c.cambios) && Object.keys(c.cambios).length === 0);
    correccion = {
      ids: validarIds(ids, refs, 'correccion.item_ids'),
      cambios: convertir && cambiosVacios ? {} : normalizarCambios(c.cambios, config, avisos),
      convertir,
      cuando,
    };
  }

  // Completar (marcar como hecho) y cancelar (anular: pasa a archivado): uno, varios o un filtro ("todas las tareas"). Mismas referencias
  // cortas que corregir. Nada que hacer (lista vacía o ausente) no es un fallo: se contesta con honestidad.
  const seleccion = ['completar', 'cancelar'].includes(datos.intencion) ? normalizarSeleccion(datos[datos.intencion], refs, datos.intencion, config, avisos) : null;

  // Crear o cerrar un proyecto ("crea el proyecto Mudanza", "cierra el proyecto Mudanza")
  let proyecto = null;
  if (datos.intencion === 'proyecto') {
    const p = datos.proyecto && typeof datos.proyecto === 'object' && !Array.isArray(datos.proyecto) ? datos.proyecto : {};
    if (!['crear', 'cerrar'].includes(p.accion)) fallo(`proyecto.accion debe ser crear o cerrar: ${p.accion}`);
    const nombre = normalizarProyecto(p.nombre, config.proyectos, [], 'proyecto.nombre');
    if (!nombre) fallo('proyecto: falta el nombre');
    proyecto = { accion: p.accion, nombre };
  }

  // Ver los archivos ("dime todos los archivos y fotos que tengo", "los pdf", "¿qué hay en Fotos?"). Todos los filtros
  // son opcionales; sin ninguno se enseña todo. La carpeta se valida como la de archivar.
  let filtroArchivos = null;
  if (datos.intencion === 'ver_archivos') {
    const f = typeof datos.ver_archivos === 'object' && datos.ver_archivos !== null && !Array.isArray(datos.ver_archivos) ? datos.ver_archivos : {};
    let carpeta = null;
    if (f.carpeta !== undefined && f.carpeta !== null && f.carpeta !== '') {
      const segs = segmentosCarpeta(f.carpeta);
      if (!segs) fallo(`ver_archivos.carpeta no es una ruta válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(f.carpeta)}`);
      carpeta = segs.join('/');
    }
    let tipo = null;
    if (f.tipo === 'imagen' || f.tipo === 'documento') tipo = f.tipo;
    else if (f.tipo !== undefined && f.tipo !== null && f.tipo !== '') avisos.push(`ver_archivos.tipo "${f.tipo}" no es imagen ni documento: se muestran todos`);
    filtroArchivos = { carpeta, tipo, solo_pendientes: f.solo_pendientes === true, enviar: f.enviar === true };
  }

  // Borrar en Drive: una carpeta (entera, o solo sus archivos) y/o archivos concretos por su referencia
  // (a1…). Aquí solo se valida lo que pide: qué hay dentro lo resuelve «Resultado» con el árbol de Drive y lo enseña antes de borrar nada.
  let borrarDrive = null;
  if (datos.intencion === 'borrar_drive') {
    const b = typeof datos.borrar_drive === 'object' && datos.borrar_drive !== null && !Array.isArray(datos.borrar_drive) ? datos.borrar_drive : {};
    let carpeta = null;
    if (textoONull(b.carpeta)) {
      const segs = segmentosCarpeta(String(b.carpeta).split('/').map((x) => x.trim()).join('/'));
      if (!segs) fallo(`borrar_drive.carpeta no es una ruta válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(b.carpeta)}`);
      carpeta = segs.join('/');
    }
    const refsPedidas = Array.isArray(b.archivos) ? b.archivos.filter((r) => typeof r === 'string') : [];
    const fuera = refsPedidas.filter((r) => !Object.prototype.hasOwnProperty.call(refsArchivos, r));
    if (fuera.length > 0) avisos.push(`borrar_drive.archivos: referencias que no existen (${fuera.join(', ')}): se ignoran`);
    const archivoIds = [...new Set(refsPedidas.filter((r) => !fuera.includes(r)).map((r) => refsArchivos[r]))];
    if (carpeta || archivoIds.length > 0) borrarDrive = { carpeta, archivo_ids: archivoIds, solo_archivos: Boolean(carpeta) && b.solo_archivos === true };
  }

  // Horario fijo semanal: bloques {titulo, dias (1-7), desde, hasta}; uno por día al guardarlo
  let horarioNuevo = null;
  if (datos.intencion === 'horario') {
    const lista = Array.isArray(datos.horario_nuevo) ? datos.horario_nuevo : [];
    if (lista.length === 0) fallo('horario: falta horario_nuevo (una lista de {titulo, dias, desde, hasta})');
    horarioNuevo = [];
    for (const b of lista.slice(0, 10)) {
      const titulo = textoONull(b?.titulo);
      const dias = Array.isArray(b?.dias) ? [...new Set(b.dias.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
      const ini = aMinutos(b?.desde);
      const fin = aMinutos(b?.hasta);
      if (!titulo || titulo.length > 60 || dias.length === 0 || ini === null || fin === null || fin <= ini) fallo(`horario_nuevo no válido (título, días 1-7 y horas HH:MM con el fin después del inicio): ${JSON.stringify(b).slice(0, 160)}`);
      for (const d of dias) horarioNuevo.push({ titulo, dia_semana: d, hora_inicio: hhmm(b.desde), hora_fin: hhmm(b.hasta) });
    }
  }

  // Crear carpetas vacías ("crea la carpeta Proyectos dentro de Trabajo"): una lista de rutas bajo Secretaria/, con las mismas reglas que
  // la carpeta de archivar. Los espacios alrededor de las barras ("Trabajo / Proyectos") se limpian; sin distinguir mayúsculas ni
  // tildes, una ruta repetida cuenta una sola vez.
  let rutasNuevas = null;
  if (datos.intencion === 'crear_carpeta') {
    const c = datos.crear_carpeta;
    const lista = Array.isArray(c) ? c : c?.rutas;
    if (!Array.isArray(lista) || lista.length === 0 || !lista.every((r) => typeof r === 'string')) fallo('crear_carpeta necesita crear_carpeta.rutas, una lista de rutas');
    if (lista.length > MAX_CARPETAS_PEDIDAS) fallo(`crear_carpeta: demasiadas carpetas en un mensaje (máximo ${MAX_CARPETAS_PEDIDAS})`);
    const vistas = new Set();
    rutasNuevas = [];
    for (const r of lista) {
      const segs = segmentosCarpeta(r.split('/').map((s) => s.trim()).join('/'));
      if (!segs) fallo(`crear_carpeta.rutas: ruta no válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(r)}`);
      const ruta = segs.join('/');
      if (!vistas.has(sinAcentos(ruta))) {
        vistas.add(sinAcentos(ruta));
        rutasNuevas.push(ruta);
      }
    }
  }

  const consulta = datos.intencion === 'consultar' ? normalizarConsulta(datos.consulta, config, avisos) : null;

  return { datos: { intencion: datos.intencion, items, pregunta, memoriaNueva, nombreNuevo, nombreUsuario, correccion, seleccion, proyecto, consulta, archivos, filtroArchivos, rutasNuevas, borrarDrive, horarioNuevo, respuestaUsuario }, avisos };
}

// --- Archivos: carpeta pedida, referencias y nombres ---

// Ruta pedida ("Fotos/Viajes") -> ['Fotos', 'Viajes'], o null si no es válida. Las mismas reglas que la restricción
// archivos_carpeta_destino_valida de la base de datos y que el flujo "Sincronizar Drive": de 1 a 3 niveles de 1 a 60 caracteres,
// sin "\" ni caracteres de control, ningún nivel es "." ni "..", y ninguno empieza ni acaba en espacio.
function segmentosCarpeta(texto) {
  if (typeof texto !== 'string') return null;
  const segs = texto.split('/');
  if (segs.length < 1 || segs.length > NIVELES_CARPETA_MAX) return null;
  for (const s of segs) {
    if (s.length < 1 || s.length > 60) return null;
    if (/[\\\u0000-\u001f\u007f]/.test(s)) return null;
    if (s === '.' || s === '..') return null;
    if (s !== s.trim()) return null;
  }
  return segs;
}

// Nombre de archivo apto para Drive: sin caracteres de control ni \ / : * ? " < > |, sin puntos iniciales y de hasta 120
// caracteres conservando la extensión
function nombreSeguro(nombre) {
  let n = String(nombre ?? '')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (n.length > 120) {
    const p = n.lastIndexOf('.');
    const ext = p > 0 && n.length - p <= 10 ? n.slice(p) : '';
    n = n.slice(0, 120 - ext.length).trimEnd() + ext;
  }
  return n;
}

const extensionDe = (n) => /\.([A-Za-z0-9]{1,5})$/.exec(String(n ?? ''))?.[1] ?? '';
// El nombre que pone el sistema al recibir una foto: "2026-10-12 1830 · WhatsApp.jpg"
const NOMBRE_AUTOMATICO = /^(\d{4}-\d{2}-\d{2} \d{4}) · WhatsApp\.[A-Za-z0-9]{1,5}$/;

// Nuevo nombre de cada archivo (o null si se queda como está):
//   - si el usuario da un nombre, ese (con (1), (2)… si son varios) y la extensión de siempre;
//   - si se asocian a un item y el archivo tiene el nombre automático de una foto, "fecha hora · título del item";
//   - en cualquier otro caso se respeta el nombre actual (un PDF con nombre propio no se renombra).
function nombresNuevos(refs, info, { titulo = null, nombre = null }) {
  const total = refs.length;
  return refs.map((r, i) => {
    const actual = String(info[r]?.nombre ?? '');
    const ext = extensionDe(actual);
    const sufijo = total > 1 ? ` (${i + 1})` : '';
    const final = (base) => {
      const limpio = nombreSeguro(base).replace(/\.[A-Za-z0-9]{1,5}$/, (e) => (ext && e.slice(1).toLowerCase() === ext.toLowerCase() ? '' : e));
      return limpio === '' ? null : `${limpio}${sufijo}${ext ? `.${ext}` : ''}`;
    };
    if (nombre) return final(nombre);
    const auto = NOMBRE_AUTOMATICO.exec(actual);
    if (titulo && auto) return final(`${auto[1]} · ${titulo}`);
    return null;
  });
}

// Valida lo que el modelo dice de los archivos. refsArchivos: referencias (a1…) que se le dieron. Devuelve
// { refs, carpeta, nombre } o null (sin archivos).
function normalizarArchivos(a, intencion, refsArchivos, avisos) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) fallo('archivos no es un objeto');
  if (!Array.isArray(a.refs) || !a.refs.every((r) => typeof r === 'string')) fallo('archivos.refs debe ser una lista de referencias');
  if (a.refs.length === 0) return null;
  if (Object.keys(refsArchivos).length === 0) fallo('archivos: no hay archivos recibidos sobre los que actuar');
  const fuera = a.refs.filter((r) => !Object.prototype.hasOwnProperty.call(refsArchivos, r));
  if (fuera.length) fallo(`archivos.refs: referencias que no están entre los archivos recibidos: ${fuera.join(', ')}`);
  let carpeta = null;
  if (intencion === 'archivar') {
    const segs = segmentosCarpeta(a.carpeta);
    if (!segs) fallo(`archivos.carpeta no es una ruta válida (de 1 a ${NIVELES_CARPETA_MAX} niveles, sin barras invertidas ni ".."): ${JSON.stringify(a.carpeta)}`);
    carpeta = segs.join('/');
  } else if (a.carpeta !== undefined && a.carpeta !== null) {
    avisos.push('archivos.carpeta solo se usa en archivar, se ignora');
  }
  return { refs: [...new Set(a.refs)], carpeta, nombre: textoONull(a.nombre) };
}

function aFila(item, mensajeId, ahora, config) {
  const { espera_archivo, ...resto } = item;
  return {
    mensaje_id: mensajeId,
    ...resto,
    espera_archivo_hasta: espera_archivo ? new Date(ahora.getTime() + config.espera_min * 60000).toISOString() : null,
  };
}

function textoDeRespuesta(resp) {
  if (resp?.error) {
    const e = resp.error;
    return { error: typeof e === 'string' ? e : (e.message ?? JSON.stringify(e)) };
  }
  const texto = (resp?.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!texto) return { error: `sin texto en la respuesta: ${JSON.stringify(resp).slice(0, 300)}` };
  return { texto };
}

// --- Agenda: solapes y días ocupados ---
// Regla 1 (bloqueo): un evento no puede coincidir en el tiempo con otro pendiente. Nunca se salta.
// Regla 2 (confirmación): si el día ya tiene eventos o tareas con fecha límite, se muestra y se pregunta si se continúa.
//   Al aceptar, la pregunta guardada lleva motivo "confirmar_agenda" y los días: ese día no se vuelve a preguntar.
// Solo ve lo que pasa por la secretaria (los 200 pendientes más recientes): un evento creado a mano en Google no cuenta.

const DURACION_POR_DEFECTO_MIN = 60;
const esFecha = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const diaMadrid = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(ms));
const fmtDiaCorto = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short' });
const fmtHoraCorta = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const diaCorto = (ms) => {
  const p = Object.fromEntries(fmtDiaCorto.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
};
const horaCorta = (ms) => fmtHoraCorta.format(new Date(ms));
const limpiarTxt = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

// Intervalo de un evento en milisegundos; sin fin válido dura DURACION_POR_DEFECTO_MIN (como en Calendar)
function intervalo(inicio, fin) {
  const ini = Date.parse(inicio);
  let f = esFecha(fin) ? Date.parse(fin) : NaN;
  if (!(f > ini)) f = ini + DURACION_POR_DEFECTO_MIN * 60000;
  return { ini, fin: f };
}
// Chocan si se pisan; que uno acabe justo cuando empieza el otro no es un choque
const solapa = (a, b) => a.ini < b.fin && b.ini < a.fin;

// Lo que el usuario ya aceptó en la pregunta anterior (el último turno del hilo es la pregunta guardada, que fabrica este código):
// los días ocupados que aceptó agendar y los proyectos nuevos que aceptó crear. Las listas viajan en cualquiera de las
// preguntas: si una confirmación lleva a otra ("¿Creo el proyecto?" -> "sí" -> "ese día ya tienes…"), lo aceptado antes no se
// vuelve a preguntar (si no, el "sí" reabriría la primera pregunta una y otra vez).
//
// Se leen TODOS los turnos del hilo y no solo el último: si el usuario interrumpe con una pregunta ("¿qué proyectos
// tengo?") el modelo la contesta con su propio turno, que no lleva estas listas, y con "solo el último" se perdía lo que el código
// había preguntado y volvía a preguntar lo mismo. Que el usuario haya aceptado lo
// decide el modelo (regla 11 del prompt: solo guarda si acepta); el código solo recuerda qué se le planteó en este hilo.
// Viajan también los LOTES: los elementos
// que se iba a cancelar o completar de golpe (más de MAX_SIN_CONFIRMAR) o a archivar al cerrar un proyecto, con sus ids reales.
const MOTIVOS_CODIGO = ['confirmar_agenda', 'solape', 'crear_proyecto', 'confirmar_lote', 'repetido', 'convertir_hora', 'elegir_seccion', 'confirmar_horario', 'aviso_compra'];
function confirmacionesDelHilo(hilo) {
  const dias = new Set();
  const proyectos = new Set();
  const repetidos = new Set();
  const horario = new Set();
  const lotes = [];
  const textos = (v) => (Array.isArray(v) ? v.filter((d) => typeof d === 'string') : []);
  for (const turno of Array.isArray(hilo) ? hilo : []) {
    if (turno?.rol !== 'model') continue;
    try {
      const j = JSON.parse(turno.texto);
      if (!MOTIVOS_CODIGO.includes(j?.motivo)) continue;
      textos(j.dias).forEach((d) => dias.add(d));
      textos(j.proyectos).forEach((p) => proyectos.add(sinAcentos(p)));
      textos(j.repetidos).forEach((t) => repetidos.add(sinAcentos(t)));
      textos(j.horario).forEach((h) => horario.add(h));
      for (const l of Array.isArray(j.lotes) ? j.lotes : []) {
        if (l && typeof l.accion === 'string' && Array.isArray(l.ids)) lotes.push({ accion: l.accion, ids: textos(l.ids) });
      }
    } catch {
      // un turno del modelo que no es JSON no confirma nada
    }
  }
  return { dias, proyectos, repetidos, horario, lotes };
}
const diasConfirmados = (hilo) => confirmacionesDelHilo(hilo).dias;

// --- La compra ---
// Todo lo que sea comprar cosas va a la lista de la compra, aunque diga un día («mañana compra pan»): si el modelo lo apunta como tarea
// «Comprar pan y huevos», el código lo pasa a la lista (un elemento por cosa). Si el mensaje dice un día, después de apuntarlo se pregunta
// si se le avisa ese día para ir a comprar («¿Te aviso mañana (mié 21) para ir a comprar? Dime a qué hora.»); la respuesta la resuelve el
// código (respuestaAvisoCompra). Si dice que quiere ir a comprar un día sin decir qué («quiero ir a comprar mañana»), en vez de «¿alarma,
// cita o tarea?» se pregunta directamente lo del aviso.
const ES_COMPRA = /\b(?:compr(?:a|ar|o|amos|ad|e|en|as|arme|arte)|la compra|supermercado|super|mercado)\b/;
const LISTA_COMPRA = 'compra';
const TITULO_COMPRAR = /^comprar\s+(.+)$/i;
const ES_IR_A_COMPRAR = /^(?:ir a )?(?:hacer la )?compra(?:r)?$/;
const capitalizar = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function aListaDeCompra(items, avisos) {
  const salida = [];
  for (const it of items) {
    const m = it.tipo === 'tarea' && !esFecha(it.recordar_en) ? TITULO_COMPRAR.exec(String(it.titulo).trim()) : null;
    if (!m || ES_IR_A_COMPRAR.test(sinSignos(it.titulo))) {
      salida.push(it);
      continue;
    }
    const cosas = m[1].split(/\s*,\s*|\s+(?:y|e)\s+/).map((c) => c.trim()).filter(Boolean);
    avisos.push(`«${it.titulo}» era una tarea de comprar: pasa a la lista de la compra (${cosas.length})`);
    for (const c of cosas) {
      salida.push({ ...it, tipo: 'lista', lista: LISTA_COMPRA, titulo: capitalizar(c), contenido: null, fecha_limite: null, recordar_en: null, fecha_inicio: null, fecha_fin: null });
    }
  }
  return salida;
}
// El día que dice el mensaje (hora de Madrid): hoy, mañana, pasado (mañana), un día de la semana (el próximo; si es hoy, el de la semana
// que viene) o «el (día) 25». Devuelve { dia: 'AAAA-MM-DD', etiqueta } o null.
const SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
function diaDeCompra(mensaje, ahora) {
  const m = ` ${sinSignos(mensaje ?? '')} `;
  const [y, mo, d] = diaMadrid(ahora.getTime()).split('-').map(Number);
  const masDias = (n) => diaMadrid(madridAUtc(y, mo, d + n, 12, 0).getTime());
  const etiquetaDe = (dia, nombre) => {
    const [a, b, c] = dia.split('-').map(Number);
    const corto = diaCorto(madridAUtc(a, b, c, 12, 0).getTime());
    return nombre ? `${nombre} (${corto})` : `el ${corto}`;
  };
  if (/ pasado(?: manana)? /.test(m) && !/ (?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|mes|ano) pasado /.test(m)) {
    const dia = masDias(2);
    return { dia, etiqueta: etiquetaDe(dia, 'pasado mañana') };
  }
  if (/ manana /.test(m.replace(/ (?:por|de) la manana | esta manana /g, ' '))) {
    const dia = masDias(1);
    return { dia, etiqueta: etiquetaDe(dia, 'mañana') };
  }
  if (/ hoy | esta tarde | esta noche /.test(m)) {
    const dia = masDias(0);
    return { dia, etiqueta: etiquetaDe(dia, 'hoy') };
  }
  const ds = / (lunes|martes|miercoles|jueves|viernes|sabado|domingo) /.exec(m);
  if (ds) {
    const hoy = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const n = ((SEMANA.indexOf(ds[1]) - hoy + 7) % 7) || 7;
    const dia = masDias(n);
    return { dia, etiqueta: etiquetaDe(dia) };
  }
  const num = / el (?:dia )?(\d{1,2}) /.exec(m);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= 31) {
    const objetivo = Number(num[1]);
    const n = Array.from({ length: 62 }, (_, i) => i).find((i) => Number(masDias(i).slice(8)) === objetivo);
    if (n !== undefined) {
      const dia = masDias(n);
      return { dia, etiqueta: etiquetaDe(dia) };
    }
  }
  return null;
}
// Sin repetidos en las listas: un elemento que ya está pendiente en la MISMA lista (o repetido en el
// mismo mensaje) no se vuelve a guardar. Iguales sin mayúsculas, tildes, artículos («la leche» = «leche») ni plural simple («huevo» =
// «huevos», «limón» = «limones»). Devuelve { items, repetidos: [{ titulo, lista }] } (los que ya estaban).
const ARTICULO_LISTA = /^(?:un|una|unos|unas|el|la|los|las|lo|algo de|mas|otra|otro|otras|otros)\s+/;
const palabrasLista = (t) => sinAcentos(t).replace(/[^a-z0-9n ]/g, ' ').replace(/\s+/g, ' ').trim().replace(ARTICULO_LISTA, '').split(' ').filter(Boolean);
const mismaPalabra = (a, b) => a === b || `${a}s` === b || `${b}s` === a || `${a}es` === b || `${b}es` === a;
function mismoElemento(a, b) {
  const x = palabrasLista(a);
  const y = palabrasLista(b);
  return x.length > 0 && x.length === y.length && x.every((p, i) => mismaPalabra(p, y[i]));
}
function quitarRepetidosDeLista(items, pendientes) {
  const enLista = (Array.isArray(pendientes) ? pendientes : []).filter((r) => r && r.tipo === 'lista' && typeof r.titulo === 'string');
  const vistos = [];
  const repetidos = [];
  const salida = [];
  for (const it of items) {
    if (it.tipo !== 'lista') {
      salida.push(it);
      continue;
    }
    const lista = sinAcentos(it.lista ?? '');
    // Se enseña el nombre que ya tiene en la lista («Leche»), no como lo escribió ahora («la leche»)
    const existente = enLista.find((r) => sinAcentos(r.lista ?? '') === lista && mismoElemento(r.titulo, it.titulo))
      ?? vistos.find((v) => v.lista === lista && mismoElemento(v.titulo, it.titulo));
    if (existente) repetidos.push({ titulo: existente.titulo, lista: it.lista ?? '' });
    else {
      vistos.push({ lista, titulo: it.titulo });
      salida.push(it);
    }
  }
  return { items: salida, repetidos };
}
const enumerar = (xs) => xs.map((t) => limpiarTxt(capitalizar(String(t)))).join(', ');
// La confirmación cuando el código ha cambiado lo que propuso el modelo (pasar a la lista o quitar repetidos): la frase del modelo ya no vale
function textoCompraGuardada(items, repetidos, nombreLista) {
  const deLista = items.filter((it) => it.tipo === 'lista');
  const otros = items.filter((it) => it.tipo !== 'lista');
  const enLa = nombreLista === LISTA_COMPRA ? 'la lista de la compra' : `la lista «${limpiarTxt(nombreLista)}»`;
  const lineas = [];
  if (deLista.length > 0) lineas.push(`🛒 Apuntado en ${enLa}: ${enumerar(deLista.map((it) => it.titulo))}.`);
  if (repetidos.length > 0) {
    const nombres = enumerar(repetidos.map((r) => r.titulo));
    lineas.push(deLista.length > 0 ? `Ya estaban: ${nombres}.` : otros.length > 0 ? `Ya estaban en ${enLa}: ${nombres}.` : `Ya lo tenías todo en ${enLa}: ${nombres}.`);
  }
  if (otros.length > 0) lineas.push(`Apuntado también: ${otros.map((it) => `«${limpiarTxt(it.titulo)}»`).join(', ')}.`);
  return lineas.join('\n');
}
const textoAvisoCompra = (etiqueta) => `¿Te aviso ${etiqueta} para ir a comprar? Dime a qué hora (o «no»).`;
const turnoAvisoCompra = (aviso, texto) =>
  JSON.stringify({ intencion: 'aclarar', motivo: 'aviso_compra', origen: 'codigo', aviso_compra: aviso, pregunta: texto, items: [], respuesta_usuario: texto });

// --- Comandos y ayuda ---
// Los comandos empiezan por «/», se escriben en inglés (/help, /about, /manual…) y su contenido está en español. Los resuelve este código, sin el modelo:
// es más fiable y no cuesta nada. Dos clases:
//   - de TEXTO: ayuda fija (/help, /about, /manual, /examples, /name);
//   - ATAJOS (/pending, /today, /files, /folders): se convierten en la respuesta que daría el modelo y siguen por el mismo camino de validación.
// También se reconocen las frases de quien está perdido («ayuda», «estoy perdido», «qué puedes hacer»…) y, con el modelo, la intención «ayuda».
// Un comando NUNCA cierra una pregunta que haya quedado pendiente: se contesta y todo sigue como estaba.

const LIMITE_AYUDA = 3800;

const COMANDOS = [
  ['help', 'Esta lista de comandos', 'aprender'],
  ['about', 'Qué soy y para qué sirvo', 'aprender'],
  ['manual', 'Guía de uso por temas (/manual agenda, /manual archivos…)', 'aprender'],
  ['examples', 'Frases de ejemplo que entiendo', 'aprender'],
  ['pending', 'Lo que tienes pendiente (/pending completo: con todo el detalle)', 'atajos'],
  ['today', 'Lo de hoy', 'atajos'],
  ['files', 'Tus archivos y fotos, con su enlace', 'atajos'],
  ['folders', 'Tus carpetas de Drive', 'atajos'],
  ['projects', 'Tus proyectos', 'atajos'],
  ['name', 'Mi nombre y cómo cambiarlo', 'atajos'],
  ['memory', 'Lo que recuerdo de ti, numerado', 'atajos'],
  ['forget', 'Olvidar un dato de mi memoria: /forget 2 (el número de /memory)', 'atajos'],
  ['schedule', 'Tu horario fijo (/horario quitar 2 para quitar un bloque)', 'atajos'],
];
// Alias en español, por si se escriben sin pensar (el comando oficial es el inglés)
const ALIAS_COMANDO = {
  ayuda: 'help', comandos: 'help', commands: 'help', menu: 'help', menú: 'help', start: 'help', inicio: 'help',
  info: 'about', acerca: 'about', quien: 'about',
  manuales: 'manual', guia: 'manual', guía: 'manual',
  ejemplos: 'examples', example: 'examples',
  pendiente: 'pending', pendientes: 'pending',
  hoy: 'today',
  archivos: 'files', file: 'files', fotos: 'files',
  carpetas: 'folders', folder: 'folders',
  proyectos: 'projects', project: 'projects',
  nombre: 'name',
  memoria: 'memory', recuerdos: 'memory', recuerdas: 'memory',
  olvidar: 'forget', olvida: 'forget', olvidalo: 'forget',
  horario: 'schedule', horarios: 'schedule',
};

const TEXTO_AYUDA =
  '*Comandos* (empiezan por /)\n' +
  'Puedes escribirme con tus palabras, sin comandos. Estos atajos son por si no sabes por dónde empezar:\n\n' +
  '*Para aprender*\n' +
  COMANDOS.filter((c) => c[2] === 'aprender').map((c) => `/${c[0]} — ${c[1]}`).join('\n') +
  '\n\n*Atajos*\n' +
  COMANDOS.filter((c) => c[2] === 'atajos').map((c) => `/${c[0]} — ${c[1]}`).join('\n') +
  '\n\nSi escribo algo que no entiendes, dímelo con otras palabras o escribe /help.';

const textoAbout = (nombre) =>
  [
    `*Qué soy*\nSoy tu secretaria personal por WhatsApp${nombre ? ` y me llamo ${nombre}` : ''}. Me mandas texto, audios y fotos, y yo lo ordeno y lo guardo en su sitio, para que no se te mezcle todo en un mismo chat.`,
    '*Qué puedo hacer por ti*\n' +
      '📅 *Citas*: «dentista el jueves a las 10» → lo apunto en tu calendario «Secretaria» y te aviso antes. Si algo choca con otra cita, te lo digo.\n' +
      '🔔 *Alarmas*: «avísame en 20 minutos de lo del horno». Lo que pasa hasta las 02:00 de mañana lo trato como alarma: te aviso 1 hora antes, 30 minutos antes y a la hora.\n' +
      '✅ *Tareas*: «entregar el informe el viernes». Cuando la hagas, dímelo y la marco como hecha.\n' +
      '📁 *Proyectos*: «proyecto Mudanza: llamar al casero». Lo de cada proyecto va aparte de las tareas del día a día.\n' +
      '🛒 *Listas*: «añade leche y huevos a la compra».\n' +
      '📝 *Notas* (salen como «Pensamientos»): ideas y cosas que no quieres olvidar.\n' +
      '📎 *Archivos*: fotos y documentos, guardados en carpetas de Drive que eliges tú.\n' +
      '🔎 *Consultas*: «qué tengo pendiente», «qué tengo mañana», «dame las fotos de Viajes».',
    '*Además*\n' +
      '• Cada mañana te mando un resumen de lo que tienes.\n' +
      '• Entiendo audios: te digo lo que he entendido antes de actuar.\n' +
      '• Recuerdo lo que me cuentes de ti («Emma es mi hermana»): /memory para verlo y /forget para olvidar algo.\n' +
      '• Conozco tu horario fijo («trabajo los viernes de 16 a 20») y te pregunto si apuntas una cita que choque: /horario.\n' +
      '• Si cambias algo a mano en Drive o en Google Calendar (borrar, mover, renombrar o crear), lo anoto y te lo cuento.\n' +
      '• Borro carpetas y archivos de Drive si me lo pides: antes te enseño la lista y te pregunto, y van a la papelera.\n\n' +
      'Escribe /help para ver los comandos y /manual para la guía completa.',
  ];

const MANUAL = {
  agenda: {
    titulo: 'Agenda: citas, alarmas y recordatorios',
    texto:
      '*Citas*\n• «dentista el jueves a las 10». Si falta la hora, te la pregunto. Por defecto dura 1 hora; si dura otra cosa: «dura 2 horas».\n' +
      '• Va a tu calendario «Secretaria» y te aviso 30 minutos antes.\n' +
      '• Si ya hay algo a esa hora, no la agendo y te digo con qué choca. Si el día ya tiene cosas, te las enseño y te pregunto si sigo.\n' +
      '• Cambiar: «pasa el dentista al viernes a las 11». Quitar: «quita la cita del dentista».\n' +
      '• Horario fijo: «trabajo los viernes de 16 a 20», «voy a natación lunes y miércoles de 19 a 20». Si una cita cae dentro, te pregunto antes. /horario para verlo y /horario quitar 2 para quitar un bloque.\n\n' +
      '*Alarmas*\n• Todo lo que ocurre entre ahora y las 02:00 de mañana (por ejemplo «cortarme el pelo en 2 horas») es una alarma 🔔: no va a Google Calendar y te aviso 1 hora antes, 30 minutos antes y a la hora.\n' +
      '• Lo que sea para más adelante es una cita, aunque lo digas de otra manera.',
  },
  tareas: {
    titulo: 'Tareas',
    texto:
      '• «entregar el informe el viernes» → tarea con fecha límite. Sin fecha también vale: «llamar al banco».\n' +
      '• Cuando la hagas: «ya entregué el informe» (la marco como hecha).\n' +
      '• Para verlas: /pending o «qué tengo pendiente». Si tienes algo atrasado, te lo recuerdo en el resumen de la mañana.',
  },
  proyectos: {
    titulo: 'Proyectos',
    texto:
      '• «proyecto Mudanza: llamar al casero y pedir cajas» → dos tareas del proyecto Mudanza. Si el proyecto no existe, lo creo.\n' +
      '• «crea el proyecto Web del club» (vacío) y luego «para el proyecto Web del club: comprar el dominio».\n' +
      '• Las *Tareas* son las del día a día; lo de cada proyecto sale aparte, en *Proyectos*.\n' +
      '• Ver: «qué tengo del proyecto Mudanza» o /projects (todos, con lo pendiente de cada uno).\n' +
      '• Mover algo a un proyecto: «mete lo del casero en el proyecto Mudanza».\n' +
      '• Cerrar: «cierra el proyecto Mudanza» (si tiene cosas pendientes, te las enseño y te pregunto antes de quitarlas).',
  },
  listas: {
    titulo: 'Listas',
    texto: '• «añade leche y huevos a la compra» (cada cosa se apunta por separado).\n• «qué hay en la compra».\n• «ya compré la leche» la quita de la lista.',
  },
  notas: {
    titulo: 'Notas',
    texto:
      '• «idea: probar el nuevo gimnasio» o «nota: la contraseña del wifi está en el router».\n' +
      '• Aparecen en tu lista de pendientes como *Pensamientos*: «quita todos los pensamientos» las quita todas (si son más de 3, te pregunto antes).\n' +
      '• Si algo es para hacer («tengo que…», «llamar a…»), lo guardo como tarea, no como nota.',
  },
  archivos: {
    titulo: 'Archivos y fotos',
    texto:
      '• Mándame una foto o un documento: lo guardo en *Entrada* de Drive y te lo confirmo.\n' +
      '• Para clasificarlo, *responde a su foto* (o a mi confirmación) con, por ejemplo, «guárdala en Fotos/Viajes» o «es la factura de la luz». También en bloque: «las 3 últimas a Fotos».\n' +
      '• Para recibirlos: «dame las fotos» (te las mando), «dime qué archivos tengo» o /files (la lista con enlaces).\n' +
      '• Nada se clasifica solo: lo que no clasifiques sigue en Entrada y te lo recuerdo.',
  },
  drive: {
    titulo: 'Carpetas de Drive',
    texto:
      '• «crea la carpeta Proyectos dentro de Trabajo» (hasta 3 niveles). Para ver todas: /folders.\n' +
      '• Borrar: «borra la carpeta Fotos/Viajes», «vacía la carpeta Facturas» (quita lo de dentro y deja la carpeta), «borra la foto del DNI». Te enseño lo que se borraría y solo lo mando a la papelera de Drive si me dices que sí (se recupera unos 30 días). Entrada y Notas no se borran enteras.\n' +
      '• Si cambias algo a mano en Drive, lo anoto y te aviso.',
  },
  avisos: {
    titulo: 'Avisos y resumen',
    texto:
      '• Cada mañana a las 7:00 te mando un resumen (citas de hoy, alarmas, tareas, notas, listas y archivos sin clasificar).\n' +
      '• Te aviso antes de tus citas y a las horas de tus alarmas.\n' +
      '• Importante: WhatsApp solo me deja escribirte yo primero si tú me has escrito en las últimas 23 horas. Si no, mi aviso espera a que me escribas.\n' +
      '• Si algo falla o se atasca, te lo digo.',
  },
  cambios: {
    titulo: 'Corregir, completar y cancelar',
    texto:
      '• Corregir: «cambia la hora del dentista a las 11», «el título es otro», «mételo en el proyecto Mudanza».\n' +
      '• Añadir detalles sin borrar lo que había: «añade a la tarea del banco que lleve el DNI».\n' +
      '• Completar: «ya compré la leche», «ya entregué el informe». Todo de golpe: «ya hice todas las tareas».\n' +
      '• Cancelar: «quita la cita de mañana», «olvida lo de la leche». Si solo hay una que encaje, la quito sin preguntar; si hay varias, te pregunto cuál. Todo de golpe: «quita todos los pensamientos», «vacía la lista de la compra».\n' +
      '• Si borras una sección o varias cosas a la vez, siempre te enseño la lista y te pregunto antes; si marcas como hechas más de 3, también. «Borra todo» te pregunta qué sección.\n' +
      '• Ver los detalles de algo: «qué apunté del casero», «enséñame el contenido de la tarea del banco».\n' +
      '• Todo con todos los detalles: «dámelo todo completo» o /pending completo.\n' +
      '• Si no estoy segura de a cuál te refieres, te pregunto.',
  },
  memoria: {
    titulo: 'Lo que recuerdo de ti',
    texto:
      '• Si me cuentas algo que no cambia («Emma es mi hermana», «vivo en Granada»), lo recuerdo y te lo digo con 📌.\n' +
      '• Un horario semanal con días y horas («trabajo los viernes de 16 a 20») no va aquí: va a tu horario fijo (/horario).\n' +
      '• «Llámame Ana»: así te llamaré. «Te llamas Lola»: es mi nombre.\n' +
      '• Ver lo que recuerdo: /memory o «qué sabes de mí» (una lista numerada).\n' +
      '• Olvidar un dato: /forget y su número (/forget 2), o «borra de tu memoria lo de Emma» (te pregunto antes).\n' +
      '• «Olvida lo de la leche» sin decir «memoria» es quitar una tarea o una nota, no un dato.\n' +
      '• Recuerdo como mucho 50 datos. Mi nombre no lo olvido: se cambia.',
  },
};
const TEMAS_MANUAL = Object.keys(MANUAL);

const TEXTO_EJEMPLOS =
  '*Frases que entiendo*\n' +
  '• dentista el jueves a las 10\n' +
  '• avísame en 20 minutos de sacar la ropa\n' +
  '• entregar el informe el viernes\n' +
  '• proyecto Mudanza: llamar al casero y pedir cajas\n' +
  '• añade leche y huevos a la compra\n' +
  '• idea: probar el nuevo gimnasio\n' +
  '• es la factura de la luz (respondiendo a una foto o a un PDF)\n' +
  '• qué tengo pendiente · qué tengo mañana · qué hay en la compra\n' +
  '• pasa el dentista al viernes a las 11\n' +
  '• quita la cita de mañana\n' +
  '• ya compré la leche\n' +
  '• añade a la tarea del banco que lleve el DNI\n' +
  '• quita todos los pensamientos\n' +
  '• guárdala en Fotos/Viajes (respondiendo a una foto)\n' +
  '• dame las fotos de Viajes\n' +
  '• crea la carpeta Proyectos dentro de Trabajo\n' +
  '• borra la carpeta Fotos/Viajes (te enseño lo que hay y te pregunto)\n' +
  '• llámate Marta (para cambiarme el nombre) · llámame Ana\n' +
  '• para que lo sepas: Emma es mi hermana · qué sabes de mí\n' +
  '• trabajo los viernes de 16 a 20 (tu horario fijo)\n\n' +
  'Y si no sabes cómo decirlo, dilo como te salga: te preguntaré lo que me falte.';

const textoManualIndice = () =>
  '*Manual*\nElige un tema con /manual y su nombre, por ejemplo /manual agenda:\n' +
  TEMAS_MANUAL.map((t) => `• ${t} — ${MANUAL[t].titulo}`).join('\n') +
  '\n• todo — el manual entero\n\nTambién tienes /about (qué soy) y /examples (frases de ejemplo).';

const textoName = (nombre) =>
  nombre
    ? `Me llamo ${nombre}. Si quieres cambiármelo, escríbeme por ejemplo «llámate Marta».`
    : 'Todavía no me has puesto nombre. Escríbeme el que quieras (por ejemplo «llámate Lola») y lo recordaré siempre.';

// Quita acentos, signos y mayúsculas para comparar frases de ayuda
const sinSignos = (s) => sinAcentos(s).replace(/[¿?¡!.,;:()"«»]/g, ' ').replace(/\s+/g, ' ').trim();
const FRASES_AYUDA = new Set([
  'ayuda', 'ayuda por favor', 'necesito ayuda', 'ayudame', 'ayudame por favor', 'help', 'menu', 'comandos', 'instrucciones', 'socorro', 'auxilio',
  'no se que hacer', 'no se que puedo hacer', 'no se que decir', 'no se como funciona', 'no se usarte', 'no se como usarte',
  'estoy perdido', 'estoy perdida', 'me he perdido', 'me he perdido un poco', 'no entiendo', 'no entiendo nada', 'no entiendo como funciona',
  'como funciona', 'como funcionas', 'como se usa', 'como te uso', 'como te utilizo', 'que comandos hay', 'que comandos tienes', 'lista de comandos', 'ver comandos', 'muestrame los comandos',
]);
// Preguntar el nombre de la secretaria: lo contesta el código con el nombre guardado (como /name). El modelo no tiene una intención para esto.
const FRASES_NOMBRE = new Set([
  'como te llamas', 'como te llamabas', 'como se llama', 'como se llama la secretaria', 'cual es tu nombre', 'como es tu nombre', 'tu nombre',
  'tienes nombre', 'como te llamo', 'como te puedo llamar', 'como debo llamarte', 'como quieres que te llame', 'te acuerdas de tu nombre',
  'sabes como te llamas', 'dime tu nombre', 'cual era tu nombre',
  'cual es su nombre', 'como es su nombre', 'su nombre', 'como se llama usted', 'como te llamas tu', 'tu como te llamas', 'cual es tu nombre ahora',
  'como te llamas ahora', 'cual es el nombre de la secretaria', 'recuerdas tu nombre', 'sabes tu nombre', 'que nombre tienes', 'tienes algun nombre',
]);
// Saludos y muletillas al principio que no cambian la pregunta del nombre («hola, ¿cómo te llamas?», «oye y tú cómo te llamas»)
const SALUDO_INICIAL = /^(?:(?:hola|holi|oye|buenas|buenos dias|buenas tardes|buenas noches|hey|ey|y|vale|bueno|perdona|por cierto|una pregunta)\s+)+/;
// Ponerle o cambiarle el nombre («llámate Lola», «te llamas Lola», «tu nombre es Lola»): lo aplica el código, sin depender del modelo. Si es una
// pregunta («¿te llamas Lola?»), se contesta con el nombre que tiene.
const PONER_NOMBRE = /^\s*¿?\s*(?:ll[aá]mate|te llamas|te llamar[aá]s|tu nombre (?:es|ser[aá])|a partir de ahora te llamas|desde ahora te llamas|quiero que te llames|ahora te llamas)\s+(.+?)[\s.!?]*$/iu;
const NOMBRE_VALIDO = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,39}$/u;

const FRASES_ABOUT = new Set([
  'que puedes hacer', 'que sabes hacer', 'que puedes hacer por mi', 'que sabes', 'para que sirves', 'para que sirve esto', 'para que sirve', 'que eres', 'quien eres', 'que haces',
  'que funciones tienes', 'que funcionalidades tienes', 'que haces tu', 'que eres capaz de hacer',
]);

// La memoria permanente: verla y olvidar un dato se resuelven sin el modelo. Para olvidar con palabras hay que nombrar la memoria
// («borra de tu memoria lo del trabajo», «olvida el dato del trabajo»): «olvida lo de la leche» a secas es quitar una tarea o una nota.
const FRASES_MEMORIA = new Set([
  'que recuerdas de mi', 'que sabes de mi', 'que sabes sobre mi', 'que recuerdas sobre mi', 'que guardas de mi', 'dime que sabes de mi',
  'que tienes en la memoria', 'que tienes en tu memoria', 'que hay en tu memoria', 'que hay en la memoria', 'que recuerdas', 'que te acuerdas de mi',
  'ensename tu memoria', 'muestrame tu memoria', 'dime tu memoria', 'tu memoria', 'memoria', 'ver memoria', 'ver tu memoria', 'mi memoria',
]);
const FRASES_HORARIO = new Set(['mi horario', 'que horario tengo', 'cual es mi horario', 'ensename mi horario', 'muestrame mi horario', 'dime mi horario', 'horario', 'ver horario', 'ver mi horario']);
const OLVIDAR_MEMORIA = /^(?:por favor )?(?:olvida|olvidate|borra|quita|elimina)(?:r|me)? (?:de (?:tu|la) memoria|del? (?:tu|la) memoria|el dato|ese dato|de lo que (?:recuerdas|sabes) de mi) (?:(?:lo )?(?:del|de|que|sobre) )?(.+)$/;

// Las preguntas más corrientes sobre lo pendiente se resuelven aquí con una consulta SIN filtros, igual que /pending y /today: no dependen de que el modelo
// las interprete bien (si añadía un filtro, "nada pendiente" salía como "nada con esos criterios").
const FRASES_PENDIENTE = new Set([
  'que tengo pendiente', 'que tengo pendiente ahora', 'que tengo', 'que pendientes tengo', 'que tengo por hacer', 'que me queda por hacer', 'que me falta por hacer',
  'que me queda', 'pendientes', 'mis pendientes', 'lo pendiente', 'dime lo pendiente', 'dime mis pendientes', 'que hay pendiente', 'tengo algo pendiente', 'tengo algo pendiente ahora',
]);
// «Dámelo todo completo»: lo pendiente entero, con todo el detalle de cada elemento (el contenido entero). Lo
// decide el código, no el modelo: sin memoria de la conversación, una frase así suelta el modelo no sabe a qué se refiere.
const PEDIR_COMPLETO = /\b(complet[oa]s?|enter[oa]s?|detallad[oa]s?|con (todo el |todos los )?detalles?|todo el contenido|sin (cortar|resumir|recortar))\b/;
// Se compara con un espacio delante (« dame todo completo»): así cada palabra opcional lleva su espacio y «completo» suelto también vale
const FRASE_TODO_COMPLETO = /^( dame| damelo| damela| damelos| dimelo| ensename| ensenamelo| muestrame| muestramelo| pasame| pasamelo| ponmelo| quiero| quiero verlo| lo quiero| y)?( lo| la| los| las)?( todo| toda| todos| todas)?( lo pendiente| mis pendientes| las tareas| mis tareas| la lista| el listado)?( completo| completa| completos| completas| entero| entera| con todo el detalle| con detalle| detallado| sin cortar| sin resumir)$/;
// Pide el detalle completo (vale para cualquier consulta: «qué tengo pendiente completo», «las tareas del banco enteras»)
const pideCompleto = (mensaje) => PEDIR_COMPLETO.test(sinSignos(mensaje ?? ''));

const FRASES_HOY = new Set([
  'que tengo hoy', 'que hay para hoy', 'que tengo para hoy', 'que tengo que hacer hoy', 'que hago hoy', 'agenda de hoy', 'mi agenda de hoy', 'lo de hoy', 'que hay hoy', 'tengo algo hoy',
]);

// «Qué proyectos / alarmas / citas / tareas / pensamientos / listas tengo»: la lista de eso y NADA más, resuelta por código (sin modelo y sin
// detalle). Solo las frases cortas que son exactamente eso; con cualquier otra palabra («tareas del proyecto Mudanza») decide el modelo.
const LISTA_DE = /^(?:(?:que|cuales|dime|dame|ensename|muestrame|lista(?: de)?|ver)\s+)?(?:(?:mis|las|los|todas las|todos los|todas mis|todos mis)\s+)?(proyectos|alarmas|citas|eventos|tareas|notas|pensamientos|ideas|listas)(?:\s+(?:tengo|hay|tienes|guardad[oa]s|pendientes|activ[oa]s))*$/;
const ATAJO_LISTA = {
  proyectos: { intencion: 'proyectos' },
  alarmas: { intencion: 'consultar', consulta: { tipo: 'tarea', vista: 'alarmas', estado: 'pendiente' } },
  citas: { intencion: 'consultar', consulta: { tipo: 'evento', estado: 'pendiente' } },
  eventos: { intencion: 'consultar', consulta: { tipo: 'evento', estado: 'pendiente' } },
  tareas: { intencion: 'consultar', consulta: { tipo: 'tarea', vista: 'tareas', estado: 'pendiente' } },
  notas: { intencion: 'consultar', consulta: { tipo: 'nota', estado: 'pendiente' } },
  pensamientos: { intencion: 'consultar', consulta: { tipo: 'nota', estado: 'pendiente' } },
  ideas: { intencion: 'consultar', consulta: { tipo: 'nota', estado: 'pendiente' } },
  listas: { intencion: 'consultar', consulta: { tipo: 'lista', estado: 'pendiente' } },
};

// Devuelve null si el mensaje no es un comando ni una petición de ayuda; si lo es: { tipo: 'texto', mensajes, motivo } o { tipo: 'atajo', datos }.
function interpretarComando(mensaje, { ahora, nombre } = {}) {
  const texto = typeof mensaje === 'string' ? mensaje.trim() : '';
  if (texto === '') return null;

  if (!texto.startsWith('/')) {
    const f = sinSignos(texto);
    if (FRASES_NOMBRE.has(f) || FRASES_NOMBRE.has(f.replace(SALUDO_INICIAL, ''))) return { tipo: 'texto', mensajes: [textoName(nombre)], motivo: 'name' };
    const pone = PONER_NOMBRE.exec(texto);
    if (pone) {
      const esPregunta = /[¿?]/.test(texto);
      const nuevo = pone[1].replace(/^["«“']+|["»”']+$/g, '').trim();
      if (esPregunta) return { tipo: 'texto', mensajes: [textoName(nombre)], motivo: 'name' };
      if (NOMBRE_VALIDO.test(nuevo) && nuevo.split(/\s+/).length <= 3) {
        return { tipo: 'atajo', datos: { intencion: 'recordar', memoria_nueva: { termino: NOMBRE_TERMINO, significado: nuevo } } };
      }
    }
    if (FRASES_MEMORIA.has(f) || FRASES_MEMORIA.has(f.replace(SALUDO_INICIAL, ''))) return { tipo: 'memoria', accion: 'ver' };
    if (FRASES_HORARIO.has(f) || FRASES_HORARIO.has(f.replace(SALUDO_INICIAL, ''))) return { tipo: 'horario', accion: 'ver' };
    const olvido = OLVIDAR_MEMORIA.exec(f.replace(SALUDO_INICIAL, ''));
    if (olvido) return { tipo: 'memoria', accion: 'olvidar', arg: olvido[1].trim() };
    if (FRASES_AYUDA.has(f)) return { tipo: 'texto', mensajes: [TEXTO_AYUDA], motivo: 'help' };
    if (FRASES_ABOUT.has(f)) return { tipo: 'texto', mensajes: textoAbout(nombre), motivo: 'about' };
    if (FRASES_PENDIENTE.has(f)) return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente' } } };
    const lista = LISTA_DE.exec(f);
    if (lista) return { tipo: 'atajo', datos: ATAJO_LISTA[lista[1]] };
    if (FRASE_TODO_COMPLETO.test(` ${f}`)) return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', completo: true } } };
    if (FRASES_HOY.has(f)) {
      const hoy = diaMadrid((ahora ?? new Date()).getTime());
      return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', desde: hoy, hasta: hoy } } };
    }
    return null;
  }

  const m = /^\/+([\p{L}]*)\s*(.*)$/su.exec(texto);
  const bruto = (m?.[1] ?? '').toLowerCase();
  const arg = sinSignos(m?.[2] ?? '');
  const cmd = ALIAS_COMANDO[bruto] ?? (COMANDOS.some((c) => c[0] === bruto) ? bruto : null);

  if (bruto === '') return { tipo: 'texto', mensajes: [TEXTO_AYUDA], motivo: 'help' };
  if (cmd === null) {
    // Un comando que no existe: se dice y se sugiere el más parecido por el principio del nombre
    const parecido = COMANDOS.find((c) => c[0].startsWith(bruto.slice(0, 2)) && bruto.length >= 2);
    return {
      tipo: 'texto',
      mensajes: [`No conozco el comando /${bruto.slice(0, 30)}. ${parecido ? `¿Querías decir /${parecido[0]}? ` : ''}Escribe /help para ver los que hay.`],
      motivo: 'desconocido',
    };
  }
  switch (cmd) {
    case 'help':
      return { tipo: 'texto', mensajes: [TEXTO_AYUDA], motivo: 'help' };
    case 'about':
      return { tipo: 'texto', mensajes: textoAbout(nombre), motivo: 'about' };
    case 'examples':
      return { tipo: 'texto', mensajes: [TEXTO_EJEMPLOS], motivo: 'examples' };
    case 'name':
      return { tipo: 'texto', mensajes: [textoName(nombre)], motivo: 'name' };
    case 'memory':
      return { tipo: 'memoria', accion: 'ver' };
    case 'forget':
      return arg ? { tipo: 'memoria', accion: 'olvidar', arg } : { tipo: 'memoria', accion: 'ver', pista: true };
    case 'schedule': {
      if (arg === '') return { tipo: 'horario', accion: 'ver' };
      const q = /^(?:quitar|quita|borrar|borra|eliminar|elimina|olvida|olvidar) (\d{1,2})$/.exec(arg);
      return q ? { tipo: 'horario', accion: 'quitar', n: Number(q[1]) } : { tipo: 'horario', accion: 'ver', pista: true };
    }
    case 'manual': {
      if (arg === '') return { tipo: 'texto', mensajes: [textoManualIndice()], motivo: 'manual' };
      if (arg === 'todo' || arg === 'todos' || arg === 'completo') {
        return { tipo: 'texto', mensajes: TEMAS_MANUAL.map((t) => `*${MANUAL[t].titulo}*\n${MANUAL[t].texto}`), motivo: 'manual' };
      }
      const tema = TEMAS_MANUAL.find((t) => t === arg || sinAcentos(MANUAL[t].titulo).startsWith(arg)) ?? null;
      if (tema === null) return { tipo: 'texto', mensajes: [`No tengo un tema «${arg.slice(0, 30)}». ${textoManualIndice()}`], motivo: 'manual' };
      return { tipo: 'texto', mensajes: [`*${MANUAL[tema].titulo}*\n${MANUAL[tema].texto}`], motivo: 'manual' };
    }
    case 'pending':
      // «/pending completo» (o full, todo, entero): con todo el detalle
      return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', completo: /^(complet[oa]|full|todo|enter[oa]|detalle)$/.test(arg) } } };
    case 'today': {
      const hoy = diaMadrid((ahora ?? new Date()).getTime());
      return { tipo: 'atajo', datos: { intencion: 'consultar', consulta: { estado: 'pendiente', desde: hoy, hasta: hoy } } };
    }
    case 'files':
      return { tipo: 'atajo', datos: { intencion: 'ver_archivos', ver_archivos: { enviar: false } } };
    case 'folders':
      return { tipo: 'atajo', datos: { intencion: 'carpetas' } };
    case 'projects':
      return { tipo: 'atajo', datos: { intencion: 'proyectos' } };
    default:
      return null;
  }
}

// --- Aplazar una alarma o una cita RESPONDIENDO a su aviso ---
// «10 minutos», «otros 10», «pospón media hora», «1 hora más», «+15», «en 20 minutos»: lo resuelve este código, sin el modelo (rápido,
// gratis y sin errores de cuentas). Solo cuando se responde a un aviso con UN elemento (si el aviso llevaba varios, decide el modelo,
// que ve cuáles son). Una fecha concreta («al viernes a las 9») también va al modelo.
// La hora nueva:
//   - alarma que YA sonó, o «en N…»: desde ahora (si son las 18:35, «10 minutos» -> 18:45);
//   - alarma que aún no ha sonado: desde su hora (18:30 + «1 hora» -> 19:30);
//   - cita: desde su hora de inicio («retrásala media hora»); con «en N…», desde ahora. Conserva la duración (lo hace comprobarAgenda) y
//     pasa por el control de solapes como cualquier cambio de hora.
const NUMEROS_APLAZAR = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  doce: 12, quince: 15, veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40, cuarenta_y_cinco: 45, cincuenta: 50,
};
const RELLENO_APLAZAR = new Set([
  'y', 'vale', 'ok', 'mejor', 'pues', 'venga', 'porfa', 'porfavor', 'pospon', 'posponla', 'posponlo', 'posponer', 'aplaza', 'aplazala', 'aplazalo',
  'retrasa', 'retrasala', 'retrasalo', 'atrasa', 'atrasala', 'atrasalo', 'amplia', 'ampliala', 'amplialo', 'alarga', 'alargala', 'alargalo',
  'mueve', 'muevela', 'muevelo', 'dame', 'dejame', 'recuerdamelo', 'recuerdamela', 'recuerdame', 'avisame', 'vuelve', 'a', 'avisarme',
  'otra', 'vez', 'la', 'lo', 'alarma', 'cita', 'aviso', 'snooze',
]);
const MAX_APLAZAR_MIN = 7 * 24 * 60;

// Minutos que pide el texto ya normalizado, o null si no es solo una cantidad de tiempo
function minutosDeAplazar(t) {
  let m;
  if ((m = /^\+?(\d{1,5})\s*(min|mins|minuto|minutos|m|h|hora|horas)?$/.exec(t))) return Number(m[1]) * (/^h/.test(m[2] ?? '') ? 60 : 1);
  if (/^media hora$/.test(t)) return 30;
  if (/^(?:un |una )?cuarto de hora$/.test(t)) return 15;
  if (/^tres cuartos de hora$/.test(t)) return 45;
  if ((m = /^(\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce) (?:horas?|h) y media$/.exec(t))) {
    return (Number(m[1]) || NUMEROS_APLAZAR[m[1]]) * 60 + 30;
  }
  if ((m = /^([a-z_ ]+?) (minutos?|horas?)$/.exec(t))) {
    const n = NUMEROS_APLAZAR[m[1].replace(/ /g, '_')];
    if (n) return n * (m[2].startsWith('hora') ? 60 : 1);
  }
  return null;
}

// Devuelve null (no es un aplazamiento resoluble por código) o { ref, cambios, minutos }. "citados": los elementos del aviso al que se
// responde, con su referencia corta (ref), tipo, recordar_en o fecha_inicio.
function interpretarAplazamiento(mensaje, citados, ahora) {
  if (!Array.isArray(citados) || citados.length !== 1) return null;
  const item = citados[0];
  let palabras = sinSignos(mensaje ?? '').split(' ').filter(Boolean);
  while (palabras.length > 0 && RELLENO_APLAZAR.has(palabras[0])) palabras.shift();
  while (palabras.length > 0 && ['mas', 'porfa', 'por', 'favor'].includes(palabras.at(-1))) palabras.pop();
  let desdeAhora = false;
  if (palabras[0] === 'en') {
    desdeAhora = true;
    palabras.shift();
  } else if (palabras[0] === 'dentro' && palabras[1] === 'de') {
    desdeAhora = true;
    palabras = palabras.slice(2);
  }
  while (palabras.length > 0 && ['otros', 'otras', 'otro', 'unos', 'unas', 'por', 'durante', 'de'].includes(palabras[0])) palabras.shift();
  const minutos = palabras.length > 0 ? minutosDeAplazar(palabras.join(' ')) : null;
  if (!minutos || minutos < 1 || minutos > MAX_APLAZAR_MIN) return null;

  const ahoraMs = (ahora ?? new Date()).getTime();
  if (item.tipo === 'tarea' && typeof item.recordar_en === 'string' && !Number.isNaN(Date.parse(item.recordar_en))) {
    const hora = Date.parse(item.recordar_en);
    const base = desdeAhora || hora <= ahoraMs ? ahoraMs : hora;
    return { ref: item.ref, minutos, cambios: { recordar_en: new Date(base + minutos * 60000).toISOString() } };
  }
  if (item.tipo === 'evento' && typeof item.fecha_inicio === 'string' && !Number.isNaN(Date.parse(item.fecha_inicio))) {
    const base = desdeAhora ? ahoraMs : Date.parse(item.fecha_inicio);
    return { ref: item.ref, minutos, cambios: { fecha_inicio: new Date(base + minutos * 60000).toISOString() } };
  }
  return null;
}

// --- Nombre repetido: «¿cuáles hay?» antes de decidir ---
// Si tu última pregunta era "Ya tienes «Dentista» (…). ¿La cambio o añado otra?" y el usuario pregunta cuáles existen, lo contesta el código
// con la lista de las que existen y la pregunta sigue abierta para que decida después.
const PIDE_CUALES = /^(?:y )?(?:(?:dime|dame|muestrame|ensename|ver|lista) )?(?:cuales|cual|las que|lo que|que)(?: ya)?(?: hay| existen| existe| tengo| tienes| son| ya hay)*$|^(?:muestramelas|ensenamelas|dimelas|la lista|lista)$/;
// El turno del modelo se guarda tal cual en el hilo. Una confirmación de borrar en Drive solo la puede escribir el código («Resultado»):
// si el modelo devuelve algo con esa forma (por ejemplo, porque un mensaje reenviado se lo pide), se le quita antes de guardarlo.
function sinMarcaDeCodigo(texto) {
  try {
    const j = JSON.parse(texto);
    if (j && typeof j === 'object' && (j.motivo === 'confirmar_drive' || j.motivo === 'confirmar_memoria' || 'papelera' in j || 'olvidar' in j || 'origen' in j)) {
      delete j.motivo;
      delete j.papelera;
      delete j.olvidar;
      delete j.origen;
      return JSON.stringify(j);
    }
  } catch {
    // no es JSON: se guarda tal cual
  }
  return texto;
}
function motivoDelHilo(hilo) {
  const ultimo = (Array.isArray(hilo) ? hilo : []).at(-1);
  if (ultimo?.rol !== 'model') return null;
  try {
    return JSON.parse(ultimo.texto);
  } catch {
    return null;
  }
}
// Devuelve los títulos (sin acentos) del nombre repetido sobre el que se preguntó, o null si el mensaje no pide la lista
function pideListarRepetidos(mensaje, hilo) {
  const turno = motivoDelHilo(hilo);
  if (turno?.motivo !== 'repetido' || !PIDE_CUALES.test(sinSignos(mensaje ?? ''))) return null;
  return Array.isArray(turno.repetidos) ? turno.repetidos.filter((t) => typeof t === 'string') : [];
}

// --- Varias preguntas abiertas a la vez ---
// Si el usuario escribe antes de que le llegue la respuesta, quedan abiertas varias preguntas («¿alarma, cita o tarea?», «¿los quito?»,
// «¿a qué hora?»). Antes cada pregunta nueva cerraba la anterior y un «sí» acababa contestando a la equivocada. Ahora se leen hasta
// tres y el mensaje contesta a la que encaja con lo que dice; una orden nueva («borra…», «dame…») no contesta a ninguna y las deja abiertas.
const SI_NO = /^(?:si|no|vale|ok|okey|dale|venga|claro|adelante|hazlo|perfecto|de acuerdo|correcto|exacto|por supuesto|sip|nop|ni hablar|mejor no|no gracias|cancelalo|dejalo|quitalos|quitalo|quitala|quitalas|borralos|borralo|borrala|borralas|eliminalo|eliminala|eliminalos|eliminalas|mandalo|mandalos|olvidalo|olvidalos|marcalos|cierralo)\b/;
const CUANDO = /\d|\b(?:mediodia|medianoche|manana|hoy|pasado|noche|tarde|lunes|martes|miercoles|jueves|viernes|sabado|domingo|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/;
const ELIGE_TIPO = /\b(?:alarma|cita|tarea)s?\b/;
const ELIGE_REPETIDO = /\b(?:cambia|cambiala|cambialo|actualiza|actualizala|modifica|sustituye|reemplaza|anade|anadela|otra|otro|nueva|nuevo|las dos|los dos|ambas|ambos|si|no|cuales|cual)\b/;
const ORDEN_NUEVA = /^(?:que|cuales|cual|cuantos|cuantas|dame|dime|ensename|muestrame|mis|lista|borra|quita|elimina|recuerdame|apunta|anota|crea|abre|cierra|completa|marca|\/)/;
const MOTIVOS_SI_NO = ['confirmar_agenda', 'confirmar_lote', 'crear_proyecto', 'confirmar_drive', 'confirmar_horario', 'confirmar_memoria'];
function tipoDePregunta(fila) {
  const motivo = motivoDelHilo(fila.hilo)?.motivo;
  if (MOTIVOS_SI_NO.includes(motivo)) return 'sino';
  if (motivo === 'repetido') return 'eleccion';
  if (motivo === 'convertir_hora' || motivo === 'solape') return 'cuando';
  const texto = sinAcentos(fila.pregunta);
  if (/alarma/.test(texto) && /cita/.test(texto) && /tarea/.test(texto)) return 'tipo';
  if (/\bhora\b/.test(texto)) return 'cuando';
  return 'libre';
}
const RESPONDE = { sino: SI_NO, cuando: CUANDO, tipo: ELIGE_TIPO, eleccion: ELIGE_REPETIDO };
// De las preguntas abiertas (la más reciente primero) devuelve la que este mensaje contesta, o null si es una orden nueva.
// 1) la más reciente cuyo contenido encaja con el mensaje; 2) si no encaja con ninguna pero tampoco parece una orden nueva, la más
// reciente (como antes de esta decisión); 3) si parece una orden nueva, ninguna.
function elegirPregunta(mensaje, abiertas) {
  const filas = (Array.isArray(abiertas) ? abiertas : []).filter((f) => f && typeof f.id === 'string');
  if (filas.length === 0) return null;
  const m = sinSignos(mensaje ?? '');
  const esOrden = ORDEN_NUEVA.test(m) && !SI_NO.test(m);
  if (esOrden) return filas.find((f) => tipoDePregunta(f) === 'libre') ?? null;
  return filas.find((f) => RESPONDE[tipoDePregunta(f)]?.test(m)) ?? filas[0];
}

// Un «sí» o un «no» sueltos sin ninguna pregunta abierta (ya caducó o ya se contestó): no hay nada que confirmar y el modelo se lo inventaba
// («¿a qué hora?»). Se contesta sin él. Solo «sí» y «no» exactos: un «vale» o un «ok» pueden ser un simple acuse de recibo y no se tocan.
const TEXTO_SI_NO_SUELTO = 'No tengo ninguna pregunta pendiente (puede que ya caducara). Dime qué quieres que haga.';
function siNoSinPregunta(mensaje, hilo) {
  if (Array.isArray(hilo) && hilo.length > 0) return null;
  return /^(?:si|no)$/.test(sinSignos(mensaje ?? '')) ? TEXTO_SI_NO_SUELTO : null;
}

// «Tarea», «cita» o «alarma» suelto SIN pregunta abierta: el usuario contesta a una pregunta que
// ya se resolvió (los mensajes se cruzaron: «Tarea» a «¿alarma, cita o tarea?» cuando ya estaba apuntada) y el modelo contestaba «No te he
// entendido…» tras 30 s. Si en los últimos 2 minutos se apuntó algo (reciente: el pendiente más nuevo, con su created_at), se resuelve por
// código, sin el modelo: mismo tipo → se dice que ya está; otro tipo → se convierte. Sin nada reciente, decide el modelo como siempre.
// Devuelve null o { ref, pedido, actual, igual, titulo, item }.
const TIPO_SUELTO = /^(?:pues |mejor |como )?(?:una? )?(tarea|cita|evento|alarma|recordatorio)(?: por favor)?$/;
const TIPO_PEDIDO = { tarea: 'tarea', cita: 'cita', evento: 'cita', alarma: 'alarma', recordatorio: 'alarma' };
const VENTANA_TIPO_SUELTO_MS = 2 * 60 * 1000;
function tipoSuelto(mensaje, hilo, reciente, ahora) {
  if (Array.isArray(hilo) && hilo.length > 0) return null;
  const m = TIPO_SUELTO.exec(sinSignos(mensaje ?? ''));
  if (!m || !reciente || typeof reciente.ref !== 'string') return null;
  const creado = Date.parse(reciente.created_at);
  const edad = (ahora instanceof Date ? ahora.getTime() : Date.now()) - creado;
  if (!Number.isFinite(creado) || edad < 0 || edad > VENTANA_TIPO_SUELTO_MS) return null;
  const actual = reciente.tipo === 'evento' ? 'cita' : reciente.tipo !== 'tarea' ? null : reciente.recordar_en && !reciente.fecha_limite ? 'alarma' : 'tarea';
  if (!actual) return null; // una nota o una lista: decide el modelo
  const pedido = TIPO_PEDIDO[m[1]];
  return { ref: reciente.ref, pedido, actual, igual: pedido === actual, titulo: String(reciente.titulo ?? ''), item: reciente };
}

// Respuesta a «¿Te aviso mañana (…) para ir a comprar? Dime a qué hora.» (motivo aviso_compra), por código:
//   «no» → no se avisa; «a las 18», «sí, a las 6 y media», «18:30», «a las 7 de la tarde» → alarma «Ir a comprar» ese día a esa hora;
//   «sí» sin hora → se pregunta la hora. Una hora de 1 a 7 sin «de la mañana» se entiende de la tarde («a las 6» → 18:00).
//   Cualquier otra cosa (una orden nueva, «mejor el jueves»…) no es una respuesta de este tipo: null, y sigue el camino de siempre.
const NO_AVISO_COMPRA = /^(?:no|nop|no hace falta|no gracias|mejor no|nada|no te preocupes|no avises|sin aviso)$/;
const SI_AVISO_COMPRA = /^(?:si|vale|ok|venga|claro|por favor|si por favor|si porfa|perfecto|dale)$/;
const HORA_AVISO_COMPRA = /^(?:(?:si|vale|ok|venga|claro|perfecto|dale) )?(?:avisame )?(?:(?:a|sobre|hacia) (?:las|la) )?(\d{1,2})(?: ?h| (\d{2}))?(?: y (media|cuarto))?(?: (?:de la|por la) (manana|tarde|noche))?(?: por favor)?$/;
function respuestaAvisoCompra(mensaje, hilo) {
  const turno = motivoDelHilo(hilo);
  if (turno?.motivo !== 'aviso_compra' || typeof turno.aviso_compra?.dia !== 'string') return null;
  const m = sinSignos(mensaje ?? '');
  if (NO_AVISO_COMPRA.test(m)) return { tipo: 'no' };
  const h = HORA_AVISO_COMPRA.exec(m);
  if (h) {
    let hora = Number(h[1]);
    let min = h[2] ? Number(h[2]) : h[3] === 'media' ? 30 : h[3] === 'cuarto' ? 15 : 0;
    if (h[4] === 'tarde' || h[4] === 'noche' ? hora < 12 : !h[4] && hora >= 1 && hora <= 7) hora += 12;
    if (hora > 23 || min > 59) return null;
    return { tipo: 'hora', hora, min, dia: turno.aviso_compra.dia, etiqueta: turno.aviso_compra.etiqueta ?? '' };
  }
  if (SI_AVISO_COMPRA.test(m)) return { tipo: 'sin_hora', dia: turno.aviso_compra.dia, etiqueta: turno.aviso_compra.etiqueta ?? '' };
  return null;
}

// «Borra todo»: nunca se borra todo de golpe. La frase se reconoce aquí, sin el modelo, y se convierte en un
// cancelar sin sección, que Planificar contesta preguntando qué sección se quiere borrar.
const BORRAR_TODO = /^(?:por favor )?(?:quiero |puedes |me )?(?:borra(?:r|lo|me)?|elimina(?:r|lo)?|quita(?:r|lo)?|limpia(?:r|lo)?|vacia(?:r|lo)?)(?: lo)? todo(?: lo que tengo| lo pendiente| lo que hay| lo apuntado)?(?: por favor)?$/;
const pideBorrarTodo = (mensaje) => BORRAR_TODO.test(sinSignos(mensaje ?? ''));

// «Borra la cita», «elimina la tarea del banco», «quita la alarma de la ropa» (con UNA sola cita, el modelo llegaba a contestar
// «Tienes varias citas de Médico, ¿cuál?»). Se resuelve por código cuando no hay duda: si de ese tipo (y con
// esas palabras en el título) hay exactamente uno, se quita ese, sin el modelo; si no hay ninguno, se dice; si hay varios, decide el modelo
// (que pregunta cuál). pendientes: los elementos pendientes con su id (real o referencia corta, el que use quien llama).
const QUITAR_UNO = /^(?:por favor )?(?:borra|borrame|elimina|eliminame|quita|quitame|cancela|cancelame|anula)(?:r)? (?:la|el|mi) (cita|evento|tarea|alarma|recordatorio|nota|pensamiento|idea)(?: (?:del|de la|de|para|con|sobre) (.+))?$/;
const TIPO_A_QUITAR = { cita: 'cita', evento: 'cita', tarea: 'tarea', alarma: 'alarma', recordatorio: 'alarma', nota: 'nota', pensamiento: 'nota', idea: 'nota' };
const NOMBRE_A_QUITAR = { cita: 'ninguna cita', tarea: 'ninguna tarea', alarma: 'ninguna alarma', nota: 'ningún pensamiento' };
// (los días no se ignoran: «la cita de mañana» con una única cita de la semana que viene no encaja, y decide el modelo)
const VACIAS_QUITAR = new Set(['del', 'las', 'los', 'una', 'uno', 'que', 'con', 'para', 'esta', 'este', 'esa', 'ese']);
function quitarConcreto(mensaje, pendientes) {
  const m = QUITAR_UNO.exec(sinSignos(mensaje ?? ''));
  if (!m) return null;
  // Con un número («la cita del 25», «la de las 10») el título no lo lleva y no se puede comprobar: decide el modelo
  if (m[2] && /\d/.test(m[2])) return null;
  const clase = TIPO_A_QUITAR[m[1]];
  const esAlarma = (r) => r.tipo === 'tarea' && Boolean(r.recordar_en) && !r.fecha_limite;
  const deClase = (Array.isArray(pendientes) ? pendientes : []).filter((r) => {
    if (!r || typeof r.id !== 'string') return false;
    if (clase === 'cita') return r.tipo === 'evento';
    if (clase === 'alarma') return esAlarma(r);
    if (clase === 'tarea') return r.tipo === 'tarea' && !esAlarma(r);
    return r.tipo === 'nota';
  });
  const palabras = m[2] ? m[2].split(' ').filter((w) => w.length > 2 && !VACIAS_QUITAR.has(w)) : [];
  const encajan = palabras.length === 0 ? deClase : deClase.filter((r) => palabras.every((w) => sinAcentos(r.titulo ?? '').includes(w)));
  if (encajan.length === 1) return { id: encajan[0].id };
  // «No tienes ninguna…» solo si no hay nada pendiente: si hay otras cosas, puede que el usuario llame «tarea» a una alarma (decide el modelo)
  if ((Array.isArray(pendientes) ? pendientes : []).filter((r) => r && typeof r.id === 'string').length === 0) return { ninguno: `No tienes ${NOMBRE_A_QUITAR[clase]} pendiente.` };
  return null;
}

// Respuestas a las preguntas de borrar, resueltas por CÓDIGO (a «¿Qué sección quieres borrar?» se puede contestar
// «Tareas», que es también el atajo de «enséñame las tareas»; si ese atajo fuera primero, enseñaría el listado):
//   - con la pregunta de la sección abierta, el nombre de una sección es esa sección (y no un listado): un cancelar con su filtro;
//   - con la confirmación de un lote abierta, un «sí» corto repite ese lote (sus ids exactos) y un «no» corto no toca nada.
// Así ninguno de los dos pasos depende de cómo interprete el modelo un hilo que empieza por «borra todo».
function seccionElegida(mensaje, hilo) {
  if (motivoDelHilo(hilo)?.motivo !== 'elegir_seccion') return null;
  let m = sinSignos(mensaje ?? '')
    .replace(/^(?:pues|vale|ok|venga)\s+/, '')
    .replace(/^(?:borra(?:r|me)?|quita(?:r|me)?|elimina(?:r)?)\s+/, '')
    .replace(/^(?:todas?|todos?)\s+/, '')
    .replace(/^(?:las|los|la|el|mis)\s+/, '')
    .trim();
  if (/^alarmas?$/.test(m)) return { tipo: 'alarma' };
  if (/^tareas?$/.test(m)) return { tipo: 'tarea' };
  if (/^(?:citas?|eventos?|calendario)$/.test(m)) return { tipo: 'evento' };
  if (/^(?:pensamientos?|notas?|ideas?)$/.test(m)) return { tipo: 'nota' };
  if (/^(?:lista (?:de (?:la )?)?)?compra$/.test(m)) return { tipo: 'lista', lista: 'compra' };
  let r = /^lista (?:de la |del |de )?(.+)$/.exec(m);
  if (r) return { tipo: 'lista', lista: r[1] };
  r = /^(?:lo )?(?:del |de )?proyecto (.+)$/.exec(m);
  if (r) return { proyecto: r[1] };
  return null;
}
const NO_CONFIRMA = /^(?:no|mejor no|no gracias|ni hablar|dejalo|cancela|cancelalo|espera|olvidalo|olvidate)\b/;
const SI_CONFIRMA = /^(?:si|vale|ok|okey|dale|venga|claro|adelante|hazlo|por supuesto|de acuerdo|sip|perfecto|correcto|quitalos|quitalo|quitalas|quitala|borralos|borralo|borralas|borrala|eliminalos|eliminalo|eliminala|eliminalas|mandalo|mandalos|marcalos|marcalo)\b/;
// Lo que se manda a la papelera de Drive: ids de Drive con la forma de siempre, como mucho MAX_PAPELERA
const ID_DRIVE_PAPELERA = /^[A-Za-z0-9_-]{10,100}$/;
const MAX_PAPELERA = 50;
function papeleraDelHilo(t) {
  if (t?.motivo !== 'confirmar_drive' || t.origen !== 'codigo' || !Array.isArray(t.papelera)) return null;
  const lista = t.papelera
    .filter((e) => e && ['carpeta', 'archivo'].includes(e.tipo) && typeof e.id === 'string' && ID_DRIVE_PAPELERA.test(e.id))
    .map((e) => ({ tipo: e.tipo, id: e.id, nombre: String(e.nombre ?? '').slice(0, 200) }))
    .slice(0, MAX_PAPELERA);
  return lista.length > 0 ? lista : null;
}
// Olvidar datos de la memoria: ids de la tabla memoria, solo si la pregunta la escribió el código
const ID_MEMORIA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function olvidarDelHilo(t) {
  if (t?.motivo !== 'confirmar_memoria' || t.origen !== 'codigo' || !Array.isArray(t.olvidar)) return null;
  const ids = t.olvidar.filter((x) => typeof x === 'string' && ID_MEMORIA.test(x)).slice(0, 50);
  return ids.length > 0 ? ids : null;
}
function respuestaConfirmacion(mensaje, hilo) {
  const t = motivoDelHilo(hilo);
  const papelera = papeleraDelHilo(t);
  const olvidar = olvidarDelHilo(t);
  if (!papelera && !olvidar && (t?.motivo !== 'confirmar_lote' || !Array.isArray(t.lotes) || t.lotes.length === 0)) return null;
  const m = sinSignos(mensaje ?? '');
  if (!m || m.split(' ').length > 4) return null;
  // «Olvídalo» es «sí» solo ante «¿Olvido esto?»; ante borrar en Drive o un lote es «déjalo» (revisión del 2026-10-19)
  if (olvidar && /^olvidalos?\b/.test(m)) return { tipo: 'si', accion: 'olvidar', ids: olvidar };
  if (NO_CONFIRMA.test(m)) return { tipo: 'no' };
  if (!SI_CONFIRMA.test(m)) return null;
  if (papelera) return { tipo: 'si', accion: 'papelera', papelera };
  if (olvidar) return { tipo: 'si', accion: 'olvidar', ids: olvidar };
  const lote = t.lotes.at(-1);
  if (!['cancelar', 'completar'].includes(lote?.accion) || !Array.isArray(lote.ids)) return null;
  return { tipo: 'si', accion: lote.accion, ids: lote.ids.filter((x) => typeof x === 'string') };
}

// La respuesta del modelo que equivale a un atajo (con la forma de la respuesta de Gemini: así sigue el camino normal de validación)
const respuestaDeAtajo = (datos) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [], respuesta_usuario: '', ...datos }) }] } }],
});

// --- Alarmas y citas ---
// Lo que empieza entre ahora y las 02:00 (hora de Madrid) del día siguiente es una ALARMA: una tarea con hora de aviso, sin calendario y
// sin control de solapes. Lo que empieza más tarde es una CITA y va al calendario. Lo decide el código, da igual cómo lo pida el usuario.
// Un evento cuya hora ya pasó se queda como evento (es un registro, no algo que avisar).
const HORA_FIN_ALARMAS = 2;
function limiteAlarmas(ahora) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(ahora).split('-').map(Number);
  return madridAUtc(y, m, d + 1, HORA_FIN_ALARMAS, 0).getTime();
}

// Si el usuario dice «cita» o «en el calendario», es una cita aunque empiece enseguida: se respeta su palabra
const PIDE_CITA = /\b(citas?|calendario)\b/;
function eventosAAlarmas(datos, ahora, meta, mensaje = '') {
  if (datos.intencion !== 'guardar') return;
  if (PIDE_CITA.test(sinAcentos(mensaje))) return;
  const limite = limiteAlarmas(ahora);
  const convertidos = [];
  datos.items = datos.items.map((it) => {
    if (it.tipo !== 'evento' || !esFecha(it.fecha_inicio)) return it;
    const ini = Date.parse(it.fecha_inicio);
    if (!(ini > ahora.getTime() && ini <= limite)) return it;
    convertidos.push(it.titulo);
    return { ...it, tipo: 'tarea', recordar_en: it.fecha_inicio, fecha_inicio: null, fecha_fin: null, fecha_limite: null };
  });
  if (convertidos.length > 0) meta.alarmas = convertidos;
}

// --- Parecido entre un nombre y los proyectos que ya existen ---
const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a', 'al', 'para']);
const palabrasDe = (s) => sinAcentos(s).replace(/[^a-z0-9ñ]+/g, ' ').trim().split(' ').filter(Boolean);

function distanciaEdicion(a, b) {
  const fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return fila[b.length];
}

// 0 = nada que ver; hasta 100 = casi seguro. Siglas («ONG» y «Organización No Gubernamental»), texto contenido, palabra compartida y distancia de edición.
function parecido(nombre, existente) {
  const pn = palabrasDe(nombre);
  const pe = palabrasDe(existente);
  const n = pn.join('');
  const e = pe.join('');
  if (!n || !e) return 0;
  const sigla = pe.filter((p) => !PALABRAS_VACIAS.has(p)).map((p) => p[0]).join('');
  let mejor = 0;
  if (sigla.length >= 2 && n === sigla) mejor = 100;
  else if (sigla.length >= 2 && n.length >= 2 && (sigla.startsWith(n) || n.startsWith(sigla))) mejor = 70;
  if (n.length >= 3 && (e.includes(n) || n.includes(e))) mejor = Math.max(mejor, 85);
  if (pn.some((p) => p.length >= 4 && !PALABRAS_VACIAS.has(p) && pe.includes(p))) mejor = Math.max(mejor, 60);
  const sim = 1 - distanciaEdicion(n, e) / Math.max(n.length, e.length);
  if (sim >= 0.6) mejor = Math.max(mejor, Math.round(sim * 55));
  return mejor;
}

// Hasta 3 nombres existentes, de más a menos parecidos (vacío si ninguno se parece)
function nombresParecidos(nombre, existentes) {
  return [...new Set(existentes.map((a) => limpiarTxt(a)).filter(Boolean))]
    .map((a) => ({ a, p: parecido(nombre, a) }))
    .filter((x) => x.p >= 40)
    .sort((x, y) => y.p - x.p || x.a.localeCompare(y.a, 'es'))
    .slice(0, 3)
    .map((x) => x.a);
}

// --- Proyectos nuevos ---
// Un proyecto que no existe se crea solo al guardar (la base de datos lo crea con el item). Solo se pregunta si se PARECE a uno que ya
// existe ("Mudanzas" y "Mudanza"): así una errata no parte un proyecto en dos. Devuelve null o { motivo, proyectos, texto }.
function comprobarProyectos({ datos, config, hiloPrevio }) {
  const conocidos = new Set((config.proyectos ?? []).map(sinAcentos));
  const confirmados = confirmacionesDelHilo(hiloPrevio).proyectos;
  const candidatos = [];
  if (datos.intencion === 'guardar') for (const it of datos.items) if (it.proyecto) candidatos.push(it.proyecto);
  if (datos.intencion === 'corregir' && typeof datos.correccion.cambios.proyecto === 'string') candidatos.push(datos.correccion.cambios.proyecto);
  const vistos = new Set();
  for (const p of candidatos) {
    const k = sinAcentos(p);
    if (conocidos.has(k) || confirmados.has(k) || vistos.has(k)) continue;
    vistos.add(k);
    const parecidos = nombresParecidos(p, config.proyectos ?? []).filter((x) => parecido(p, x) >= 60);
    if (parecidos.length > 0) {
      const texto = `¿Es el proyecto ${parecidos.map((x) => `«${x}»`).join(' o ')}, o creo uno nuevo, «${limpiarTxt(p)}»?`;
      return { motivo: 'crear_proyecto', proyectos: [p], texto };
    }
  }
  return null;
}

// Proyectos que no existían y que este guardado va a crear (para decírselo al usuario)
function proyectosNuevos(datos, config) {
  const conocidos = new Set((config.proyectos ?? []).map(sinAcentos));
  const nuevos = [];
  const cambios = datos.intencion === 'corregir' ? [datos.correccion.cambios.proyecto] : datos.intencion === 'guardar' ? datos.items.map((it) => it.proyecto) : [];
  for (const p of cambios) {
    if (typeof p === 'string' && p && !conocidos.has(sinAcentos(p)) && !nuevos.some((n) => sinAcentos(n) === sinAcentos(p))) nuevos.push(p);
  }
  return nuevos;
}

// «Ya lo tengo apuntado como tarea: «Ir a comprar» (mié 21).» (tipoSuelto con el mismo tipo)
function textoYaApuntado({ actual, titulo, item }) {
  const iso = actual === 'cita' ? item.fecha_inicio : actual === 'alarma' ? item.recordar_en : item.fecha_limite;
  const cuando = !esFecha(iso) ? '' : actual === 'tarea' ? ` (${diaCorto(Date.parse(iso))})` : ` (${diaCorto(Date.parse(iso))}, ${horaCorta(Date.parse(iso))})`;
  return `Ya lo tengo apuntado como ${actual}: «${limpiarTxt(titulo)}»${cuando}.`;
}

// --- Cambiar de tipo: tarea, alarma y cita ---
// El modelo solo dice a cuál (correccion.convertir_a) y, si el usuario la dio, la fecha nueva (correccion.cuando). Este código mueve la fecha
// de un campo a otro, que es lo que el modelo hacía mal («dice que lo ha hecho y no lo ha hecho»):
//   alarma: tarea con recordar_en (la hora de la cita, o la de la alarma, o la de un plazo con hora real) y sin fecha límite ni de inicio.
//   cita:   evento con fecha_inicio (la hora de la alarma o de la cita) y una hora de duración.
//   tarea:  sin hora de aviso ni de inicio; el día que tuviera pasa a ser su fecha límite (fin de ese día).
// Una alarma y una cita necesitan hora: si no hay de dónde sacarla, se pregunta (no se inventa).
const esFinDeDia = (iso) => esFecha(iso) && horaCorta(Date.parse(iso)) === '23:59';
function finDeDia(iso) {
  const [y, m, d] = diaMadrid(Date.parse(iso)).split('-').map(Number);
  return new Date(madridAUtc(y, m, d, 23, 59).getTime() + 59000).toISOString();
}
// Devuelve null o { motivo, texto } (falta la hora). Si todo está claro, deja los cambios de cada elemento en datos.correccion.porId.
function aplicarConversion({ datos, fechas, titulos }) {
  if (datos.intencion !== 'corregir' || !datos.correccion.convertir) return null;
  const c = datos.correccion;
  const porId = {};
  const sinHora = [];
  for (const id of c.ids) {
    const f = fechas.get(id) ?? {};
    const conHora = (iso) => (esFecha(iso) && !esFinDeDia(iso) ? iso : null);
    if (c.convertir === 'tarea') {
      const base = c.cuando ?? f.fecha_limite ?? f.recordar_en ?? f.fecha_inicio ?? null;
      porId[id] = { tipo: 'tarea', recordar_en: null, fecha_inicio: null, fecha_fin: null, fecha_limite: esFecha(base) ? finDeDia(base) : null };
    } else if (c.convertir === 'alarma') {
      const base = c.cuando ?? f.recordar_en ?? f.fecha_inicio ?? conHora(f.fecha_limite);
      if (!esFecha(base)) sinHora.push(id);
      else porId[id] = { tipo: 'tarea', recordar_en: new Date(base).toISOString(), fecha_inicio: null, fecha_fin: null, fecha_limite: null };
    } else {
      const base = c.cuando ?? f.fecha_inicio ?? f.recordar_en ?? conHora(f.fecha_limite);
      if (!esFecha(base)) sinHora.push(id);
      else {
        const inicio = new Date(base).toISOString();
        // Si ya era una cita y no se mueve, conserva su duración; si no, una hora
        const igual = esFecha(f.fecha_inicio) && Date.parse(f.fecha_inicio) === Date.parse(base);
        porId[id] = { tipo: 'evento', fecha_inicio: inicio, recordar_en: null, fecha_limite: null, ...(igual && esFecha(f.fecha_fin) ? {} : { fecha_fin: new Date(Date.parse(base) + 3600000).toISOString() }) };
      }
    }
  }
  if (sinHora.length > 0) {
    const quien = sinHora.map((id) => `«${limpiarTxt(titulos.get(id) ?? 'eso')}»`);
    const que = c.convertir === 'alarma' ? 'alarma' : 'cita';
    return {
      motivo: 'convertir_hora',
      texto: sinHora.length === 1
        ? `Para dejar ${quien[0]} como ${que} necesito la hora. ¿A qué hora?`
        : `Para dejarlas como ${que} necesito la hora de ${quien.join(', ')}. ¿A qué hora?`,
    };
  }
  // Lo que el modelo hubiera puesto de más en cambios (tipo, fechas) lo sustituye la conversión
  for (const k of ['tipo', 'recordar_en', 'fecha_inicio', 'fecha_fin', 'fecha_limite']) delete c.cambios[k];
  c.porId = porId;
  return null;
}

// Una alarma o una cita con un nombre igual o parecido al de otra pendiente: se pregunta si se cambia la que hay o se añade otra. Lo que el usuario
// ya aceptó añadir ("añade otra") viaja en el hilo (repetidos). Compara las alarmas y citas nuevas con las pendientes de las dos clases.
const esAlarmaOCita = (r) => r.tipo === 'evento' || esAlarmaItem(r);
function cuandoDe(r) {
  const iso = r.tipo === 'evento' ? r.fecha_inicio : r.recordar_en;
  return esFecha(iso) ? `${diaCorto(Date.parse(iso))}, ${horaCorta(Date.parse(iso))}` : 'sin hora';
}
const lineaExistente = (e) => `«${limpiarTxt(e.titulo)}» (${e.tipo === 'evento' ? 'cita' : 'alarma'}, ${cuandoDe(e)})`;
function comprobarRepetidos({ datos, pendientes, hiloPrevio }) {
  if (datos.intencion !== 'guardar') return null;
  const aceptados = confirmacionesDelHilo(hiloPrevio).repetidos;
  const existentes = pendientes.filter(esAlarmaOCita);
  const claves = [];
  const bloques = [];
  for (const it of datos.items.filter(esAlarmaOCita)) {
    const k = sinAcentos(it.titulo);
    if (!k || aceptados.has(k) || claves.includes(k)) continue;
    const parecidas = existentes.filter((e) => parecido(it.titulo, e.titulo) >= 70);
    if (parecidas.length === 0) continue;
    claves.push(k);
    bloques.push({ titulo: it.titulo, parecidas });
  }
  if (bloques.length === 0) return null;
  const linea = lineaExistente;
  const texto =
    bloques.length === 1 && bloques[0].parecidas.length === 1
      ? `Ya tienes ${linea(bloques[0].parecidas[0])}. ¿La cambio o añado otra con el mismo nombre?`
      : `Ya tienes esto parecido:\n${bloques.flatMap((b) => b.parecidas).map((e) => `• ${linea(e)}`).join('\n')}\n¿Cambio la que ya existe o añado otra nueva?`;
  return { motivo: 'repetido', repetidos: claves, texto };
}
// Las alarmas y citas que se parecen a los títulos de la pregunta (para contestar «¿cuáles hay?» sin cerrarla)
function parecidasA(titulos, pendientes) {
  return pendientes.filter(esAlarmaOCita).filter((e) => titulos.some((t) => parecido(t, e.titulo) >= 70));
}

// --- Borrar por secciones ---
// Quitar «todo» no se hace nunca: se pregunta qué sección (alarmas, tareas, citas…), con cuántos elementos tiene cada una. Una sección
// es lo que abarca un filtro (tipo, lista o proyecto). Elegida la sección, comprobarLote pide confirmación siempre.
const NOMBRE_SECCION = { alarma: 'Alarmas', tarea: 'Tareas', evento: 'Citas', nota: 'Pensamientos' };
function seccionDe(r) {
  if (r.proyecto) return `proyecto:${sinAcentos(r.proyecto)}`;
  if (r.tipo === 'lista') return `lista:${sinAcentos(r.lista ?? '')}`;
  return esAlarmaItem(r) ? 'alarma' : r.tipo;
}
function textoSecciones(pendientes) {
  const lineas = [];
  for (const t of ['alarma', 'tarea', 'evento', 'nota']) {
    const n = resolverFiltro({ tipo: t, lista: null, proyecto: null }, pendientes).length;
    if (n > 0) lineas.push(`• ${NOMBRE_SECCION[t]} (${n})`);
  }
  const contar = (clave) => {
    const m = new Map();
    for (const r of pendientes) {
      const k = clave(r);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()];
  };
  for (const [l, n] of contar((r) => (r.tipo === 'lista' && !r.proyecto ? r.lista || 'compra' : null))) lineas.push(`• Lista ${sinAcentos(l) === 'compra' ? 'de la compra' : `«${limpiarTxt(l)}»`} (${n})`);
  for (const [pr, n] of contar((r) => r.proyecto || null)) lineas.push(`• Proyecto «${limpiarTxt(pr)}» (${n})`);
  if (lineas.length === 0) return null;
  return `No borro todo de golpe. ¿Qué sección quieres borrar?\n${lineas.join('\n')}\nDímela (por ejemplo «las alarmas») y te pediré confirmación antes de quitar nada.`;
}
// Cancelar sin decir qué (un filtro vacío) o un montón de cosas de secciones distintas: se pregunta la sección
function comprobarSeccion({ datos, selIds, porId, pendientes }) {
  if (datos.intencion !== 'cancelar' || !datos.seleccion) return null;
  const f = datos.seleccion.filtro;
  const sinSeccion = f && !f.tipo && !f.lista && !f.proyecto;
  const mezcla = !f && selIds.length > MAX_SIN_CONFIRMAR && new Set(selIds.map((id) => porId.get(id)).filter(Boolean).map(seccionDe)).size > 1;
  if (!sinSeccion && !mezcla) return null;
  const texto = textoSecciones(pendientes);
  return texto ? { motivo: 'elegir_seccion', texto } : { vacio: true };
}

// --- Cancelar o completar muchos de golpe ---
// Más de MAX_SIN_CONFIRMAR elementos (o cerrar un proyecto con cosas pendientes) se enseña y se pregunta antes. El "sí" repite la petición
// (regla 11 del prompt) y aquí se reconoce porque los ids ya se plantearon en este hilo.
const MAX_LINEAS_LOTE = 15;
const VERBO_LOTE = { cancelar: ['quitar', '¿Los quito?', '¿Lo quito?'], completar: ['marcar como hechos', '¿Los marco como hechos?', '¿Lo marco como hecho?'] };
function comprobarLote({ accion, ids, porId, hiloPrevio, proyecto = null, siempre = false }) {
  if (ids.length === 0) return null;
  if (!proyecto && !siempre && ids.length <= MAX_SIN_CONFIRMAR) return null;
  const confirmados = new Set(confirmacionesDelHilo(hiloPrevio).lotes.filter((l) => l.accion === accion).flatMap((l) => l.ids));
  if (ids.every((id) => confirmados.has(id))) return null;
  const titulos = ids.map((id) => porId.get(id)).filter(Boolean).map((r) => `• ${limpiarTxt(r.titulo)}`);
  const lineas = titulos.slice(0, MAX_LINEAS_LOTE).join('\n') + (titulos.length > MAX_LINEAS_LOTE ? `\n… y ${titulos.length - MAX_LINEAS_LOTE} más` : '');
  const texto = proyecto
    ? `El proyecto «${limpiarTxt(proyecto)}» tiene ${ids.length === 1 ? '1 cosa pendiente' : `${ids.length} cosas pendientes`}:\n${lineas}\nSi lo cierro, las quito. ¿Lo cierro?`
    : ids.length === 1
      ? `Voy a ${VERBO_LOTE[accion][0]} 1 elemento:\n${lineas}\n${VERBO_LOTE[accion][2]}`
      : `Voy a ${VERBO_LOTE[accion][0]} ${ids.length} elementos:\n${lineas}\n${VERBO_LOTE[accion][1]}`;
  return { motivo: 'confirmar_lote', lotes: [{ accion, ids }], texto };
}

const nombreEvento = (e) => `«${limpiarTxt(e.titulo)}» (${diaCorto(e.ini)}, ${horaCorta(e.ini)}-${horaCorta(e.fin)})`;

function textoSolape(choques, varios) {
  const frases = choques.map(({ p, e, entreNuevos }) =>
    entreNuevos
      ? `«${limpiarTxt(p.titulo)}» y «${limpiarTxt(e.titulo)}», que me pides a la vez, coinciden en el tiempo`
      : `${varios ? `«${limpiarTxt(p.titulo)}» ` : ''}choca con ${nombreEvento(e)}`,
  );
  return `No puedo agendarlo: ${frases.join('; ')}. ¿A qué otra hora lo pongo?`;
}

function textoConfirmar(ocupados, propuestos) {
  const bloques = ocupados.map((o) => {
    const lineas = [
      ...o.eventos.map((e) => `• ${limpiarTxt(e.titulo)}, ${horaCorta(e.ini)}-${horaCorta(e.fin)}`),
      ...o.tareas.map((t) => `• ${limpiarTxt(t.titulo)} (tarea que vence ese día)`),
    ];
    return `El ${diaCorto(o.ms)} ya tienes:\n${lineas.join('\n')}`;
  });
  const titulos = propuestos.map((p) => `«${limpiarTxt(p.titulo)}»`).join(' y ');
  return `${bloques.join('\n')}\n¿Agendo ${titulos} igualmente?`;
}

// Devuelve null (se puede continuar) o { motivo, texto, dias }. Al mover un evento sin tocar su fin, desplaza el fin lo
// mismo para conservar la duración (modifica datos.correccion.cambios).
function comprobarAgenda({ datos, agenda, hiloPrevio, horario = [] }) {
  const porId = new Map(agenda.map((a) => [a.id, a]));
  const propuestos = [];

  if (datos.intencion === 'guardar') {
    for (const it of datos.items) {
      if (it.tipo === 'evento' && esFecha(it.fecha_inicio)) propuestos.push({ titulo: it.titulo, ...intervalo(it.fecha_inicio, it.fecha_fin) });
    }
  } else if (datos.intencion === 'corregir') {
    const { ids, cambios: comunes, porId: porIdCambios } = datos.correccion;
    for (const id of ids) {
      // Al cambiar de tipo cada elemento lleva sus propios cambios (porId): los comunes (título…) más los suyos
      const propios = porIdCambios?.[id];
      const cambios = propios ? { ...comunes, ...propios } : comunes;
      const actual = porId.get(id);
      const eraEvento = actual?.tipo === 'evento' && esFecha(actual.fecha_inicio);
      const seraEvento = (cambios.tipo ?? actual?.tipo) === 'evento';
      const tocaFechas = 'fecha_inicio' in cambios || 'fecha_fin' in cambios || cambios.tipo === 'evento';
      if (!seraEvento || !tocaFechas) continue;
      if (eraEvento && esFecha(cambios.fecha_inicio) && !('fecha_fin' in cambios)) {
        const antes = intervalo(actual.fecha_inicio, actual.fecha_fin);
        cambios.fecha_fin = new Date(Date.parse(cambios.fecha_inicio) + (antes.fin - antes.ini)).toISOString();
        if (propios) propios.fecha_fin = cambios.fecha_fin;
      }
      const inicio = 'fecha_inicio' in cambios ? cambios.fecha_inicio : actual?.fecha_inicio;
      const fin = 'fecha_fin' in cambios ? cambios.fecha_fin : actual?.fecha_fin;
      if (!esFecha(inicio)) continue;
      propuestos.push({ titulo: cambios.titulo ?? actual?.titulo ?? 'el evento', ...intervalo(inicio, fin) });
    }
  }
  if (propuestos.length === 0) return null;

  // Los eventos que se están moviendo no cuentan como existentes (se compara con su nueva posición)
  const movidos = new Set(datos.intencion === 'corregir' ? datos.correccion.ids : []);
  const existentes = agenda
    .filter((a) => a.tipo === 'evento' && esFecha(a.fecha_inicio) && !movidos.has(a.id))
    .map((a) => ({ id: a.id, titulo: a.titulo, ...intervalo(a.fecha_inicio, a.fecha_fin) }));

  const choques = [];
  propuestos.forEach((p, i) => {
    for (const e of existentes) if (solapa(p, e)) choques.push({ p, e });
    for (let j = i + 1; j < propuestos.length; j++) if (solapa(p, propuestos[j])) choques.push({ p, e: propuestos[j], entreNuevos: true });
  });
  if (choques.length > 0) return { motivo: 'solape', dias: [], texto: textoSolape(choques, propuestos.length > 1) };

  // Horario fijo: una cita que cae dentro de un bloque se pregunta antes; el «sí» vale para ese bloque ese día
  const confirmadosHorario = confirmacionesDelHilo(hiloPrevio).horario;
  const choquesHorario = [];
  for (const p of propuestos) {
    const ini = partesMadrid(p.ini);
    const finMin = diaMadrid(p.fin - 1) === diaMadrid(p.ini) ? partesMadrid(p.fin).min || 24 * 60 : 24 * 60;
    for (const b of horario) {
      if (b.dia_semana !== ini.dia || !(ini.min < aMinutos(b.hora_fin) && aMinutos(b.hora_inicio) < finMin)) continue;
      const clave = `${diaMadrid(p.ini)}|${b.id}`;
      if (!confirmadosHorario.has(clave)) choquesHorario.push({ p, b, clave });
    }
  }
  if (choquesHorario.length > 0) {
    const lineas = choquesHorario.map(({ p, b }) => `«${limpiarTxt(p.titulo)}» (${diaCorto(p.ini)}, ${horaCorta(p.ini)}) cae en tu horario: ${lineaHorario(b)}.`);
    const verbo = datos.intencion === 'corregir' ? (propuestos.length > 1 ? '¿Las muevo igualmente?' : '¿La muevo igualmente?') : propuestos.length > 1 ? '¿Las apunto igualmente?' : '¿La apunto igualmente?';
    return { motivo: 'confirmar_horario', horario: [...new Set(choquesHorario.map((c) => c.clave))], texto: `${lineas.join('\n')}\n${verbo}` };
  }

  const confirmados = diasConfirmados(hiloPrevio);
  const ocupados = [];
  for (const dia of [...new Set(propuestos.map((p) => diaMadrid(p.ini)))]) {
    if (confirmados.has(dia)) continue;
    const eventos = existentes.filter((e) => diaMadrid(e.ini) === dia);
    const tareas = agenda.filter((a) => a.tipo === 'tarea' && esFecha(a.fecha_limite) && diaMadrid(Date.parse(a.fecha_limite)) === dia);
    if (eventos.length > 0 || tareas.length > 0) ocupados.push({ dia, ms: propuestos.find((p) => diaMadrid(p.ini) === dia).ini, eventos, tareas });
  }
  if (ocupados.length > 0) return { motivo: 'confirmar_agenda', dias: ocupados.map((o) => o.dia), texto: textoConfirmar(ocupados, propuestos) };
  return null;
}

// Función principal: no toca la red ni el reloj salvo por "ahora", que se pasa desde fuera
// "contexto": { mensaje (el texto de este mensaje), pendienteId (la pregunta anterior que este mensaje contesta,
// si la hay) y hiloPrevio (los turnos guardados hasta esa pregunta) }.
// "archivos": { refs (a1… -> id real), info (a1… -> { nombre, creado }) } de los archivos que vio el modelo.
// "pendientes": los elementos pendientes que vio el modelo, con ids reales (para resolver los filtros de cancelar y completar y para
// nombrar lo que se va a tocar). "config.proyectos": los nombres de los proyectos que existen (activos y cerrados).
function planificar({ resp, mensajeId, config, ahora, refs = {}, contexto = {}, agenda = [], archivos = {}, pendientes = [] }) {
  const base = config.supabase_url.replace(/\/+$/, '') + '/rest/v1';
  const peticion = (etiqueta, metodo, ruta, cuerpo, prefer) => ({ etiqueta, metodo, url: base + ruta, cuerpo, prefer });
  const marcarMensaje = (cuerpo) => peticion('actualizar mensaje', 'PATCH', `/mensajes?id=eq.${mensajeId}`, cuerpo, 'return=minimal');
  // "Leer consulta" se ejecuta siempre; si no hay consulta lee algo inocuo (el mensaje recién guardado)
  const urlNeutra = `${base}/mensajes?select=id&id=eq.${mensajeId}`;
  const conError = (motivo, meta) => ({
    peticiones: [marcarMensaje({ procesado: false, error: motivo })],
    meta: { ok: false, error: motivo, avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, ...meta },
  });

  // Comandos (/help, /manual…) y frases de quien está perdido («ayuda», «qué puedes hacer»): se contestan sin el modelo. Los atajos (/pending, /today…)
  // sustituyen la respuesta del modelo por la equivalente y siguen el camino normal. Nunca cierran una pregunta pendiente y van antes de la pregunta del nombre.
  // Demasiados mensajes seguidos: ni el modelo ni escritura alguna; el mensaje queda guardado y se avisa
  if (typeof contexto.avisoDemasiados === 'string' && contexto.avisoDemasiados !== '') {
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null })],
      meta: { ok: true, error: null, intencion: 'ayuda', avisos: [], respuesta_usuario: contexto.avisoDemasiados, mensajes_fijos: [contexto.avisoDemasiados], pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  // Las respuestas a las preguntas de borrar van antes que los comandos y atajos («Tareas» es la sección, no el listado)
  const elegida = seccionElegida(contexto.mensaje, contexto.hiloPrevio);
  const confirmacion = elegida ? null : respuestaConfirmacion(contexto.mensaje, contexto.hiloPrevio);
  const comando = elegida || confirmacion ? null : interpretarComando(contexto.mensaje, { ahora, nombre: contexto.nombreSecretaria });
  const ayudaFija = (mensajes, intencion = 'ayuda') => ({
    peticiones: [marcarMensaje({ procesado: true, error: null })],
    meta: { ok: true, error: null, intencion, avisos: [], respuesta_usuario: mensajes.join('\n\n'), mensajes_fijos: mensajes, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
  });
  if (comando?.tipo === 'texto') return ayudaFija(comando.mensajes);
  const filasMem = filasDeMemoria(contexto.memoria);
  const olvidarIds = (ids, cerrarPregunta) => {
    const vivos = ids.filter((id) => filasMem.some((m) => m.id === id && !esNombreSecretaria(m)));
    if (vivos.length === 0) return ayudaFija(['Eso ya no está en mi memoria. Escribe /memory para ver lo que recuerdo.']);
    return {
      peticiones: [
        ...(cerrarPregunta && contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
        ...vivos.map((id) => peticion('olvidar un dato', 'POST', '/rpc/olvidar_memoria', { p_id: id }, 'return=representation')),
      ],
      meta: { ok: true, error: null, intencion: 'olvidar_memoria', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  };
  if (comando?.tipo === 'memoria' && comando.accion === 'ver') return ayudaFija([textoMemoria(filasMem, comando.pista === true)]);
  const filasHor = filasDeHorario(contexto.horario);
  if (comando?.tipo === 'horario' && comando.accion === 'ver') return ayudaFija([textoMiHorario(filasHor, comando.pista === true)]);
  if (comando?.tipo === 'horario' && comando.accion === 'quitar') {
    const bloque = filasHor[comando.n - 1];
    if (!bloque) return ayudaFija([`No tengo el bloque número ${comando.n}.\n\n${textoMiHorario(filasHor, true)}`]);
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null }), peticion('quitar un bloque del horario', 'POST', '/rpc/quitar_horario', { p_id: bloque.id }, 'return=representation')],
      meta: { ok: true, error: null, intencion: 'quitar_horario', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (comando?.tipo === 'memoria' && comando.accion === 'olvidar') {
    const arg = String(comando.arg ?? '').trim();
    // «/forget 2»: el número de la lista, sin preguntar (lo que se olvida se dice tal cual)
    if (/^\d{1,3}$/.test(arg)) {
      const fila = filasMem[Number(arg) - 1];
      if (!fila) return ayudaFija([`No tengo el dato número ${arg}.\n\n${textoMemoria(filasMem, true)}`]);
      if (esNombreSecretaria(fila)) return ayudaFija([TEXTO_NOMBRE_NO_SE_OLVIDA]);
      return olvidarIds([fila.id], false);
    }
    // Con palabras: se busca y se pregunta antes (con la lista de lo que se olvidaría)
    const encontrados = buscarEnMemoria(filasMem, arg);
    const olvidables = encontrados.filter((m) => !esNombreSecretaria(m));
    if (olvidables.length === 0) {
      return ayudaFija([encontrados.length > 0 ? TEXTO_NOMBRE_NO_SE_OLVIDA : `No encuentro nada en mi memoria sobre «${limpiarTxt(arg).slice(0, 60)}». Escribe /memory para ver lo que recuerdo.`]);
    }
    const lineas = olvidables.map((m) => `${filasMem.indexOf(m) + 1}. ${lineaMemoria(m)}`);
    const texto = olvidables.length === 1
      ? `¿Olvido esto?\n${lineas[0]}`
      : `Esto es lo que encuentro:\n${lineas.join('\n')}\n¿Lo olvido todo? Si solo es uno, escribe /forget y su número.`;
    const turno = JSON.stringify({ intencion: 'aclarar', motivo: 'confirmar_memoria', origen: 'codigo', olvidar: olvidables.map((m) => m.id), pregunta: texto, items: [], respuesta_usuario: texto });
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null, pregunta: texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turno }] })],
      meta: { ok: true, error: null, intencion: 'aclarar', avisos: [], respuesta_usuario: texto, pregunta: texto, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  const sinPregunta = comando || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : siNoSinPregunta(contexto.mensaje, contexto.hiloPrevio);
  if (sinPregunta) return ayudaFija([sinPregunta]);
  // Respuesta a «¿Te aviso … para ir a comprar?»: no, una hora (alarma «Ir a comprar») o «sí» sin hora (se pregunta)
  const avisoResp = comando || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : respuestaAvisoCompra(contexto.mensaje, contexto.hiloPrevio);
  if (avisoResp?.tipo === 'no') {
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ok: true, error: null, intencion: 'descartar', avisos: [], respuesta_usuario: 'Vale, sin aviso.', respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (avisoResp?.tipo === 'sin_hora') {
    const texto = `¿A qué hora te aviso ${avisoResp.etiqueta || 'ese día'}?`;
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null, pregunta: texto, pregunta_pendiente: true, hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoAvisoCompra({ dia: avisoResp.dia, etiqueta: avisoResp.etiqueta }, texto) }] }),
      ],
      meta: { ok: true, error: null, intencion: 'aclarar', avisos: [], respuesta_usuario: texto, pregunta: texto, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (avisoResp?.tipo === 'hora') {
    const [a, b, c] = avisoResp.dia.split('-').map(Number);
    resp = respuestaDeAtajo({ intencion: 'guardar', items: [{ tipo: 'tarea', titulo: 'Ir a comprar', recordar_en: madridAUtc(a, b, c, avisoResp.hora, avisoResp.min).toISOString(), confianza: 1 }] });
  }
  // «Tarea» suelto que llega tarde a una pregunta ya resuelta: ya está (mismo tipo) o se convierte (otro tipo), sin el modelo
  const suelto = comando || contexto.pedirNombre === true || contexto.esperaNombre === true ? null : tipoSuelto(contexto.mensaje, contexto.hiloPrevio, contexto.reciente, ahora);
  if (suelto?.igual) return ayudaFija([textoYaApuntado(suelto)]);
  if (suelto) resp = respuestaDeAtajo({ intencion: 'corregir', correccion: { item_ids: [suelto.ref], convertir_a: suelto.pedido, cambios: {} } });
  if (comando?.tipo === 'atajo') resp = respuestaDeAtajo(comando.datos);
  if (!comando && pideBorrarTodo(contexto.mensaje)) resp = respuestaDeAtajo({ intencion: 'cancelar', cancelar: { filtro: {} } });
  // «Borra la cita» cuando solo hay una (o ninguna): por código, sin el modelo
  const concreto = comando || elegida || confirmacion || contexto.pedirNombre === true ? null : quitarConcreto(contexto.mensaje, pendientes);
  if (concreto?.ninguno) return ayudaFija([concreto.ninguno], 'cancelar');
  if (concreto?.id) {
    const refDe = new Map(Object.entries(refs).map(([r, id]) => [id, r]));
    if (refDe.has(concreto.id)) resp = respuestaDeAtajo({ intencion: 'cancelar', cancelar: { item_ids: [refDe.get(concreto.id)] } });
  }
  if (elegida) resp = respuestaDeAtajo({ intencion: 'cancelar', cancelar: { filtro: elegida } });
  if (confirmacion?.tipo === 'no') {
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ok: true, error: null, intencion: 'descartar', avisos: [], respuesta_usuario: 'Vale, no quito nada.', respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  if (confirmacion?.tipo === 'si' && confirmacion.accion === 'olvidar') return olvidarIds(confirmacion.ids, true);
  if (confirmacion?.tipo === 'si' && confirmacion.accion === 'papelera') {
    // Borrar en Drive confirmado: se cierra la pregunta y se leen otra vez el árbol y los archivos registrados. «Preparar papelera»
    // comprueba con ellos cada id antes de mandarlo a la papelera (una carpeta tiene que colgar de Secretaria y no ser Entrada ni
    // Notas; un archivo tiene que estar registrado) y «Resultado» cuenta lo que de verdad se hizo.
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ok: true, error: null, intencion: 'borrar_drive', avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: true, papelera: confirmacion.papelera, ahora: ahora.toISOString() },
    };
  }
  if (confirmacion?.tipo === 'si') {
    // Los ids del lote son reales; el cancelar los quiere con sus referencias cortas (lo que ya no está pendiente se queda fuera)
    const refDe = new Map(Object.entries(refs).map(([r, id]) => [id, r]));
    resp = respuestaDeAtajo({ intencion: confirmacion.accion, [confirmacion.accion]: { item_ids: confirmacion.ids.map((id) => refDe.get(id)).filter(Boolean) } });
  }
  // «¿Cuáles hay?» ante la pregunta de un nombre repetido: se contesta con las que existen y la pregunta sigue abierta (no se cierra)
  const titulosRepetidos = comando ? null : pideListarRepetidos(contexto.mensaje, contexto.hiloPrevio);
  if (titulosRepetidos) {
    const existentes = parecidasA(titulosRepetidos, pendientes);
    const texto = existentes.length > 0
      ? `Esto es lo que ya tienes:\n${existentes.map((e) => `• ${lineaExistente(e)}`).join('\n')}\n¿La cambio o añado otra con el mismo nombre?`
      : 'Ya no encuentro nada parecido pendiente. Dime otra vez lo que quieres apuntar.';
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null })],
      meta: { ok: true, error: null, intencion: 'consultar', avisos: [], respuesta_usuario: texto, respuesta_fija: true, pregunta: null, consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }
  // Aplazar respondiendo a un aviso («10 minutos más»): se convierte en el corregir equivalente y sigue el camino normal (validación,
  // solapes de las citas, reabrir la alarma ya sonada…)
  const aplazamiento = comando ? null : interpretarAplazamiento(contexto.mensaje, contexto.citados, ahora);
  if (aplazamiento) resp = respuestaDeAtajo({ intencion: 'corregir', correccion: { item_ids: [aplazamiento.ref], cambios: aplazamiento.cambios } });

  // La primera pregunta de la secretaria es su nombre: mientras no tenga uno (y no se le acabe de preguntar), cualquier mensaje se contesta
  // con esa pregunta, sin mirar lo que diga el modelo (que no se ha usado para nada). El mensaje original queda guardado, sin procesar.
  if (contexto.pedirNombre === true && comando?.tipo !== 'atajo' && !aplazamiento) {
    if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') throw new Error('Planificar: falta el texto del mensaje para guardar la pregunta del nombre');
    const texto = TEXTO_PEDIR_NOMBRE;
    const turnoModelo = JSON.stringify({
      intencion: 'aclarar', items: [], consulta: null, correccion: null, completar: null, memoria_nueva: null,
      pregunta: texto, respuesta_usuario: texto, motivo: 'pedir_nombre', dias: [],
    });
    return {
      peticiones: [
        ...(contexto.pendienteId ? [peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal')] : []),
        marcarMensaje({
          procesado: true, error: null, pregunta: texto, pregunta_pendiente: true,
          hilo: [{ rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoModelo }],
        }),
      ],
      meta: { ok: true, error: null, intencion: 'aclarar', avisos: [], respuesta_usuario: texto, pregunta: texto, bloqueo: 'pedir_nombre', consulta_url: urlNeutra, consulta: null, carpetas: false, ahora: ahora.toISOString() },
    };
  }

  const { texto, error } = textoDeRespuesta(resp);
  if (error) return conError(`Error del modelo: ${error}`, { intencion: null });

  let validado;
  try {
    validado = validarRespuesta(texto, config, refs, archivos.refs ?? {}, { esperaNombre: contexto.esperaNombre === true });
  } catch (e) {
    if (!(e instanceof ErrorValidacion)) throw e;
    // El modelo devolvió algo que no encaja: no se hace nada y se contesta «no te he entendido» (Resultado). No es un fallo del flujo:
    // el mensaje queda procesado, con el motivo anotado para poder revisarlo (supabase/comprobaciones/ver-errores.sql).
    const motivo = `Respuesta no válida: ${e.message}. Texto recibido: ${texto.slice(0, MAX_TEXTO_ERROR)}`;
    return {
      peticiones: [marcarMensaje({ procesado: true, error: motivo })],
      meta: { ok: false, no_entendido: true, error: motivo, intencion: null, avisos: [], respuesta_usuario: '', pregunta: null, consulta_url: urlNeutra, consulta: null },
    };
  }

  const { datos, avisos } = validado;
  // Sin seguridad no se apunta nada (regla 5 del prompt, ahora también por código): si algo de lo que iba a guardar tiene una confianza baja,
  // se pregunta en vez de guardar, enseñando lo que se ha entendido. La respuesta vuelve al modelo con el hilo.
  const dudosos = datos.intencion === 'guardar' ? datos.items.filter((it) => typeof it.confianza === 'number' && it.confianza < UMBRAL_CONFIANZA) : [];
  if (dudosos.length > 0) {
    avisos.push(`confianza baja (${dudosos.map((it) => it.confianza).join(', ')}): se pregunta en vez de guardar`);
    const lineas = datos.items.slice(0, 5).map((it) => `• ${NOMBRE_TIPO[it.tipo] ?? it.tipo}: «${limpiarTxt(it.titulo)}»`);
    datos.intencion = 'aclarar';
    datos.pregunta = `No estoy segura de haberte entendido y prefiero no apuntar nada mal. He entendido esto:\n${lineas.join('\n')}\n¿Es así? Si no, dímelo de otra forma.`;
    datos.items = [];
    datos.archivos = null;
    datos.memoriaNueva = null; // de un mensaje que no se ha entendido no se recuerda nada
    datos.nombreUsuario = null;
  }
  const meta = {
    ok: true,
    error: null,
    intencion: datos.intencion,
    avisos,
    respuesta_usuario: datos.respuestaUsuario,
    pregunta: datos.pregunta,
    consulta_url: urlNeutra,
    consulta: null,
    carpetas: false,
    ahora: ahora.toISOString(),
    ...(datos.nombreNuevo ? { nombre_nuevo: datos.nombreNuevo, tras_pregunta_nombre: contexto.esperaNombre === true } : {}),
  };

  // Tope de la memoria: un dato NUEVO (un término que no existe) no se guarda si ya hay MAX_MEMORIA; cambiar uno que existe, sí
  if (datos.memoriaNueva) {
    const norma = (t) => String(t).trim().toLowerCase();
    const existe = filasMem.some((m) => norma(m.termino) === norma(datos.memoriaNueva.termino));
    const fijo = [NOMBRE_TERMINO, NOMBRE_USUARIO].includes(sinAcentos(datos.memoriaNueva.termino));
    if (!existe && !fijo && filasMem.length >= MAX_MEMORIA) {
      avisos.push(`memoria llena (${filasMem.length}): no se guarda «${datos.memoriaNueva.termino}»`);
      meta.memoria_llena = datos.memoriaNueva.termino;
      if (datos.intencion === 'recordar') {
        meta.respuesta_usuario = textoMemoriaLlena(datos.memoriaNueva.termino);
        meta.respuesta_fija = true;
      }
      datos.memoriaNueva = null;
    }
  }

  const cerrarAnterior = () =>
    peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal');

  // La compra: lo que sea comprar cosas va a la lista de la compra, y si el mensaje dice un día se pregunta si se avisa ese día.
  // No aplica a la respuesta a la propia pregunta del aviso (avisoResp).
  const esCompra = !avisoResp && ES_COMPRA.test(sinSignos(contexto.mensaje ?? ''));
  const diaCompra = esCompra ? diaDeCompra(contexto.mensaje, ahora) : null;
  const antesDeCompra = datos.intencion === 'guardar' ? datos.items.length : 0;
  if (esCompra && datos.intencion === 'guardar') datos.items = aListaDeCompra(datos.items, avisos);
  const pasoALista = datos.intencion === 'guardar' && datos.items.length !== antesDeCompra || (datos.intencion === 'guardar' && avisos.some((a) => a.includes('pasa a la lista de la compra')));
  const huboCompra = datos.intencion === 'guardar' && datos.items.some((it) => it.tipo === 'lista' && it.lista === LISTA_COMPRA);
  // Sin repetidos en las listas
  const repetidosLista = datos.intencion === 'guardar' ? quitarRepetidosDeLista(datos.items, pendientes) : { items: [], repetidos: [] };
  if (datos.intencion === 'guardar') {
    datos.items = repetidosLista.items;
    if (repetidosLista.repetidos.length > 0) avisos.push(`ya estaban en la lista: ${repetidosLista.repetidos.map((r) => r.titulo).join(', ')}`);
  }
  if (datos.intencion === 'guardar' && (pasoALista || repetidosLista.repetidos.length > 0)) {
    const nombreLista = datos.items.find((it) => it.tipo === 'lista')?.lista ?? repetidosLista.repetidos[0]?.lista ?? LISTA_COMPRA;
    meta.respuesta_usuario = textoCompraGuardada(datos.items, repetidosLista.repetidos, nombreLista);
  }
  const tipoPregunta = (p) => /alarma/.test(sinAcentos(p ?? '')) && /cita/.test(sinAcentos(p ?? '')) && /tarea/.test(sinAcentos(p ?? ''));
  if (diaCompra && datos.intencion === 'aclarar' && tipoPregunta(datos.pregunta)) {
    // «Quiero ir a comprar mañana» (sin decir qué): en vez de «¿alarma, cita o tarea?», si se le avisa ese día
    const texto = textoAvisoCompra(diaCompra.etiqueta);
    return {
      peticiones: [
        ...(contexto.pendienteId ? [cerrarAnterior()] : []),
        marcarMensaje({ procesado: true, error: null, pregunta: texto, pregunta_pendiente: true, hilo: [...(contexto.hiloPrevio ?? []), { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoAvisoCompra(diaCompra, texto) }] }),
      ],
      meta: { ...meta, intencion: 'aclarar', pregunta: texto, respuesta_usuario: texto },
    };
  }
  if (diaCompra && huboCompra) {
    meta.aviso_compra = { ...diaCompra, pregunta: textoAvisoCompra(diaCompra.etiqueta) };
  }

  // Ayuda: lo pidió con palabras que no son un comando («no sé cómo usarte»). Se enseña la lista de comandos y no se toca nada (la pregunta pendiente sigue abierta).
  if (datos.intencion === 'ayuda') return ayudaFija([TEXTO_AYUDA]);

  // Descartar: el usuario rechaza lo que la pregunta anterior proponía. No se guarda ni se cambia nada.
  if (datos.intencion === 'descartar') {
    const respuesta = contexto.pendienteId ? datos.respuestaUsuario.trim() || 'Vale, no hago nada.' : 'No hay nada pendiente que cancelar.';
    return {
      peticiones: [...(contexto.pendienteId ? [cerrarAnterior()] : []), marcarMensaje({ procesado: true, error: null })],
      meta: { ...meta, respuesta_usuario: respuesta },
    };
  }

  // Horario fijo: se guarda cada bloque (uno por día); el mismo bloque repetido no se duplica (restricción única)
  if (datos.intencion === 'horario') {
    const nuevos = datos.horarioNuevo.filter((n) => !filasHor.some((b) => b.dia_semana === n.dia_semana && hhmm(b.hora_inicio) === n.hora_inicio && hhmm(b.hora_fin) === n.hora_fin && sinAcentos(b.titulo) === sinAcentos(n.titulo)));
    if (filasHor.length + nuevos.length > MAX_HORARIO) {
      const texto = `Tu horario fijo está lleno (${MAX_HORARIO} bloques). Mira /horario y quita alguno con /horario quitar y su número.`;
      return { peticiones: [marcarMensaje({ procesado: true, error: null })], meta: { ...meta, respuesta_usuario: texto, respuesta_fija: true } };
    }
    return {
      peticiones: [
        ...(contexto.pendienteId ? [cerrarAnterior()] : []),
        ...(nuevos.length > 0 ? [peticion('guardar el horario fijo', 'POST', '/horario_fijo?on_conflict=titulo_norm,dia_semana,hora_inicio,hora_fin', nuevos, 'resolution=ignore-duplicates,return=representation')] : []),
        marcarMensaje({ procesado: true, error: null }),
      ],
      meta: { ...meta, horario_nuevo: datos.horarioNuevo, horario_ya_estaba: nuevos.length === 0 },
    };
  }

  // Borrar carpetas o archivos de Drive: aquí no se borra nada. Se leen el árbol de carpetas y los archivos registrados y
  // «Resultado» enseña la lista de lo que se mandaría a la papelera y deja la pregunta abierta; con el «sí» se manda (más abajo, por código).
  // Es una orden nueva: no contesta ni cierra otra pregunta abierta.
  if (datos.intencion === 'borrar_drive') {
    if (!datos.borrarDrive) {
      return { peticiones: [marcarMensaje({ procesado: true, error: null })], meta: { ...meta, respuesta_usuario: TEXTO_QUE_BORRAR_DRIVE, respuesta_fija: true } };
    }
    return {
      peticiones: [marcarMensaje({ procesado: true, error: null })],
      meta: { ...meta, respuesta_usuario: '', carpetas: true, borrar_drive: datos.borrarDrive },
    };
  }

  const sinTocarNada = (texto) => ({
    peticiones: [...(contexto.pendienteId ? [cerrarAnterior()] : []), marcarMensaje({ procesado: true, error: null })],
    meta: { ...meta, respuesta_usuario: texto, respuesta_fija: true },
  });
  const porId = new Map(pendientes.map((r) => [r.id, r]));

  // Mover una alarma o una cita a una hora que ya ha pasado no sirve para nada: se dice y no se toca nada. En las citas solo se comprueba
  // si es la del aviso al que se responde (corregir a mano la hora de una cita pasada, para que conste, sigue valiendo).
  // Las fechas y el tipo actuales de lo pendiente (y de las alarmas ya sonadas), por id real: de ahí salen las fechas al cambiar de tipo
  const fechasPorId = new Map(Object.entries(contexto.fechas ?? {}).map(([ref, f]) => [refs[ref], f]).filter(([id]) => id));
  const titulosPorId = new Map([...pendientes.map((r) => [r.id, r.titulo]), ...Object.entries(contexto.fechas ?? {}).map(([ref, f]) => [refs[ref], f.titulo])].filter(([id, t]) => id && t));
  // Cambiar de tipo (alarma, cita, tarea): si falta la hora, se pregunta (entra en la cadena de bloqueos de más abajo)
  const bloqueoConversion = aplicarConversion({ datos, fechas: fechasPorId, titulos: titulosPorId });
  if (datos.intencion === 'corregir' && !bloqueoConversion) {
    const citadosIds = new Set((contexto.citados ?? []).map((x) => refs[x.ref]).filter(Boolean));
    let pasada = null;
    for (const id of datos.correccion.ids) {
      const propios = datos.correccion.porId?.[id];
      const cam = { ...datos.correccion.cambios, ...(propios ?? {}) };
      if (esFecha(cam.recordar_en) && Date.parse(cam.recordar_en) <= ahora.getTime()) pasada = cam.recordar_en;
      else if (esFecha(cam.fecha_inicio) && Date.parse(cam.fecha_inicio) <= ahora.getTime() && (citadosIds.has(id) || propios)) pasada = cam.fecha_inicio;
      if (pasada) break;
    }
    if (pasada) {
      return sinTocarNada(`Esa hora ya ha pasado (${fmtDiaCorto.format(new Date(pasada))}, ${fmtHoraCorta.format(new Date(pasada))}). Dime otra, por ejemplo «a las 19:00» o «10 minutos más».`);
    }
  }

  // Cancelar o completar: el filtro se convierte aquí en ids. Nada que tocar (p. ej. "borra lo del proyecto X" y no hay nada): se
  // dice y no se toca nada.
  let selIds = [];
  let bloqueoSeccion = null;
  if (datos.seleccion) {
    selIds = datos.seleccion.filtro ? resolverFiltro(datos.seleccion.filtro, pendientes).map((r) => r.id) : datos.seleccion.ids;
    if (datos.seleccion.filtro) meta.filtro = datos.seleccion.filtro;
    // «Borra todo» o un montón de cosas de secciones distintas: se pregunta qué sección, sin tocar nada
    const seccion = comprobarSeccion({ datos, selIds, porId: new Map(pendientes.map((r) => [r.id, r])), pendientes });
    if (seccion?.vacio) return sinTocarNada('No tienes nada pendiente que borrar.');
    if (seccion) bloqueoSeccion = seccion;
    if (selIds.length === 0) {
      return sinTocarNada(datos.intencion === 'cancelar' ? 'No encuentro nada pendiente que cancelar con eso.' : 'No encuentro nada pendiente que marcar como hecho con eso.');
    }
    if (datos.seleccion.filtro && pendientes.length >= MAX_PENDIENTES_VISTOS) avisos.push(`Solo se han mirado los ${MAX_PENDIENTES_VISTOS} elementos pendientes más recientes`);
  }

  // Proyectos: crear uno que ya existe no hace nada; cerrar uno que no existe se dice. Cerrar quita (archiva) lo que tenga pendiente.
  const proyectosTodos = config.proyectos ?? [];
  if (datos.intencion === 'proyecto') {
    const existe = proyectosTodos.find((p) => sinAcentos(p) === sinAcentos(datos.proyecto.nombre)) ?? null;
    const activo = existe && (config.proyectos_activos ?? proyectosTodos).some((p) => sinAcentos(p) === sinAcentos(existe));
    if (datos.proyecto.accion === 'crear' && activo) return sinTocarNada(`Ya tienes el proyecto «${limpiarTxt(existe)}». Para añadirle cosas: «para el proyecto ${limpiarTxt(existe)}: …».`);
    if (datos.proyecto.accion === 'cerrar' && !existe) {
      const lista = (config.proyectos_activos ?? proyectosTodos).map((p) => `«${limpiarTxt(p)}»`).join(', ');
      return sinTocarNada(`No tengo ningún proyecto «${limpiarTxt(datos.proyecto.nombre)}».${lista ? ` Tus proyectos: ${lista}.` : ''}`);
    }
    if (datos.proyecto.accion === 'cerrar') {
      datos.proyecto.nombre = existe;
      selIds = pendientes.filter((r) => sinAcentos(r.proyecto) === sinAcentos(existe)).map((r) => r.id);
    }
  }

  // Agenda: un solape bloquea siempre; un día ocupado pide confirmación. En ambos casos no se escribe ningún item: se
  // guarda la pregunta con su hilo (la respuesta del "modelo" la fabrica este código, con su motivo y los días).
  // Primero los proyectos nuevos (qué se guarda) y después la agenda (cuándo). Lo que el usuario ya aceptó en la pregunta anterior
  // viaja en la nueva, sea del tipo que sea.
  const hiloPrevio = contexto.hiloPrevio ?? [];
  // Las alarmas se convierten antes de comprobar la agenda: no entran en el control de solapes ni piden confirmar el día
  eventosAAlarmas(datos, ahora, meta, contexto.mensaje);
  const bloqueo =
    bloqueoConversion ??
    comprobarProyectos({ datos, config, hiloPrevio }) ??
    comprobarRepetidos({ datos, pendientes, hiloPrevio }) ??
    comprobarAgenda({ datos, agenda, hiloPrevio, horario: filasHor }) ??
    bloqueoSeccion ??
    // Quitar en bloque (una sección entera o más de un elemento) se confirma SIEMPRE, aunque sea poco
    (datos.seleccion ? comprobarLote({ accion: datos.intencion, ids: selIds, porId, hiloPrevio, siempre: datos.intencion === 'cancelar' && (Boolean(datos.seleccion.filtro) || selIds.length > 1) }) : null) ??
    (datos.intencion === 'proyecto' && datos.proyecto.accion === 'cerrar' ? comprobarLote({ accion: 'cerrar_proyecto', ids: selIds, porId, hiloPrevio, proyecto: datos.proyecto.nombre }) : null);
  if (bloqueo) {
    if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') {
      throw new Error('Planificar: falta el texto del mensaje para guardar el hilo de la pregunta');
    }
    const previas = confirmacionesDelHilo(hiloPrevio);
    const turnoModelo = JSON.stringify({
      intencion: 'aclarar', items: [], consulta: null, correccion: null, completar: null, memoria_nueva: null,
      pregunta: bloqueo.texto, respuesta_usuario: bloqueo.texto, motivo: bloqueo.motivo,
      dias: [...new Set([...previas.dias, ...(bloqueo.dias ?? [])])],
      proyectos: [...new Set([...previas.proyectos, ...(bloqueo.proyectos ?? []).map(sinAcentos)])],
      lotes: [...previas.lotes, ...(bloqueo.lotes ?? [])],
      repetidos: [...new Set([...previas.repetidos, ...(bloqueo.repetidos ?? [])])],
      horario: [...new Set([...previas.horario, ...(bloqueo.horario ?? [])])],
    });
    return {
      peticiones: [
        ...(contexto.pendienteId ? [cerrarAnterior()] : []),
        marcarMensaje({
          procesado: true, error: null, pregunta: bloqueo.texto, pregunta_pendiente: true,
          hilo: [...hiloPrevio, { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoModelo }],
        }),
      ],
      meta: { ...meta, intencion: 'aclarar', pregunta: bloqueo.texto, respuesta_usuario: bloqueo.texto, bloqueo: bloqueo.motivo },
    };
  }

  const peticiones = [];
  if (datos.intencion === 'guardar') {
    // Recordatorios cortos (tareas con recordar_en): no van al calendario ni al control de solapes. Una hora que ya ha pasado no se
    // puede avisar: se guarda la tarea sin aviso y se dice. Los demás salen en la meta, para decirle al usuario cuándo se le avisará.
    const pasados = [];
    const recordatorios = [];
    datos.items = datos.items.map((it) => {
      if (it.tipo !== 'tarea' || !esFecha(it.recordar_en)) return it;
      if (Date.parse(it.recordar_en) <= ahora.getTime()) {
        pasados.push(it.titulo);
        return { ...it, recordar_en: null };
      }
      recordatorios.push({ titulo: it.titulo, recordar_en: new Date(Date.parse(it.recordar_en)).toISOString() });
      return it;
    });
    if (recordatorios.length > 0) meta.recordatorios = recordatorios;
    const nuevos = proyectosNuevos(datos, config);
    if (nuevos.length > 0) meta.proyectos_nuevos = nuevos;
    if (pasados.length > 0) meta.recordatorios_pasados = pasados;
    const filas = datos.items.map((it) => aFila(it, mensajeId, ahora, config));
    // Con archivos que cuelgan del item (uno solo, validado), el item y el enlace de los archivos van en UNA petición a la función
    // guardar_con_archivos, dentro de una transacción. Varias peticiones no sirven: "Escribir en Supabase" las lanza
    // a la vez y el enlace llegaba a veces antes de que el item existiera (error de clave foránea).
    // Sin nada que guardar (todo estaba ya en la lista) no se escribe nada
    if (!datos.archivos && filas.length > 0) peticiones.push(peticion('guardar items', 'POST', '/items', filas, 'return=representation'));
    // Horario de cada evento guardado, para decírselo al usuario en la confirmación: así la hora de fin que se asume cuando no
    // la dice (una hora) no pasa en silencio
    const eventos = datos.items
      .filter((it) => it.tipo === 'evento' && esFecha(it.fecha_inicio))
      .map((it) => {
        const { ini, fin } = intervalo(it.fecha_inicio, it.fecha_fin);
        return { titulo: it.titulo, inicio: new Date(ini).toISOString(), fin: new Date(fin).toISOString(), minutos: Math.round((fin - ini) / 60000) };
      });
    if (eventos.length > 0) meta.eventos = eventos;
    if (datos.archivos) {
      const nombres = nombresNuevos(datos.archivos.refs, archivos.info ?? {}, { titulo: datos.items[0].titulo, nombre: datos.archivos.nombre });
      // La función cuelga los archivos del item, quita cualquier carpeta pedida antes (ahora la decide el item) y, si no se pide
      // nada, conserva su nombre. Si algún archivo no existe, no crea nada.
      peticiones.push(
        peticion(
          'guardar item con archivos',
          'POST',
          '/rpc/guardar_con_archivos',
          // El item solo existe para colgar los archivos que se acaban de clasificar: no es nada pendiente y nace "hecho".
          // Así no sale en "qué tengo pendiente"; sus archivos siguen saliendo en "dame los archivos".
          { p_item: { ...filas[0], estado: 'hecho' }, p_archivos: datos.archivos.refs.map((r, i) => ({ id: archivos.refs[r], nombre: nombres[i] ?? null })) },
          'return=representation',
        ),
      );
    }
  }
  if (datos.intencion === 'archivar') {
    const nombres = nombresNuevos(datos.archivos.refs, archivos.info ?? {}, { nombre: datos.archivos.nombre });
    datos.archivos.refs.forEach((r, i) =>
      peticiones.push(
        peticion(`archivar ${r} en ${datos.archivos.carpeta}`, 'PATCH', `/archivos?id=eq.${encodeURIComponent(archivos.refs[r])}`, { carpeta_destino: datos.archivos.carpeta, estado: 'asignado', ...(nombres[i] ? { nombre: nombres[i] } : {}) }, 'return=representation'),
      ),
    );
  }
  if (datos.intencion === 'carpetas') meta.carpetas = true;
  // Crear carpetas vacías: se apuntan en carpetas_pedidas y el flujo "Sincronizar Drive" las crea (un nivel por pasada). Pedir otra vez
  // una carpeta ya pedida la vuelve a marcar como pendiente, así se recrea una que se hubiera borrado a mano en Drive.
  if (datos.intencion === 'crear_carpeta') {
    peticiones.push(
      peticion(
        `pedir ${datos.rutasNuevas.length === 1 ? 'la carpeta' : 'las carpetas'} ${datos.rutasNuevas.join(', ')}`,
        'POST',
        '/carpetas_pedidas?on_conflict=ruta',
        datos.rutasNuevas.map((ruta) => ({ ruta, drive_pendiente: true, eliminada_at: null })),
        'resolution=merge-duplicates,return=representation',
      ),
    );
    meta.carpetas_pedidas = datos.rutasNuevas;
  }
  // Cancelar pasa el item a "archivado": deja de salir en consultas y en la agenda y libera el hueco. No se borra de la base de datos
  // (se puede recuperar) y el flujo "Sincronizar Calendar" borra su evento de Calendar.
  if (datos.intencion === 'cancelar') {
    const ids = selIds.map(encodeURIComponent).join(',');
    peticiones.push(peticion('cancelar items', 'PATCH', `/items?id=in.(${ids})`, { estado: 'archivado' }, 'return=representation'));
  }
  if (datos.intencion === 'proyectos') meta.listar_proyectos = true;
  // Crear: upsert por nombre sin mayúsculas (si existía cerrado, se reabre). Cerrar: el proyecto pasa a cerrado y lo pendiente, a archivado.
  // Las dos peticiones de cerrar no dependen una de otra (cambiar el estado del proyecto no toca sus items).
  if (datos.intencion === 'proyecto') {
    const { accion, nombre } = datos.proyecto;
    meta.proyecto = { accion, nombre, quitados: accion === 'cerrar' ? selIds.length : 0 };
    if (accion === 'crear') {
      peticiones.push(peticion(`crear el proyecto ${nombre}`, 'POST', '/proyectos?on_conflict=nombre_norm', { nombre, estado: 'activo' }, 'resolution=merge-duplicates,return=representation'));
    } else {
      peticiones.push(peticion(`cerrar el proyecto ${nombre}`, 'PATCH', `/proyectos?nombre=eq.${encodeURIComponent(nombre)}`, { estado: 'cerrado' }, 'return=representation'));
      if (selIds.length > 0) {
        peticiones.push(peticion(`quitar lo pendiente de ${nombre}`, 'PATCH', `/items?id=in.(${selIds.map(encodeURIComponent).join(',')})`, { estado: 'archivado' }, 'return=representation'));
      }
    }
  }
  // Los archivos se filtran en "Resultado" (sin patrones de búsqueda con datos del modelo): aquí solo se lee la lista, de cualquier
  // estado (también los ya clasificados) y con el item del que cuelgan, que decide su carpeta.
  if (datos.intencion === 'ver_archivos') {
    meta.consulta_url = `${base}/archivos?select=nombre,drive_file_id,drive_url,created_at,tipo_mime,carpeta_destino,estado,items(tipo)&eliminado_at=is.null&order=created_at.desc&limit=1000`;
    meta.consulta_archivos = datos.filtroArchivos;
  }
  if (datos.memoriaNueva) {
    peticiones.push(
      peticion('guardar memoria', 'POST', '/memoria?on_conflict=termino_norm', datos.memoriaNueva, 'resolution=merge-duplicates,return=representation'),
    );
    if (datos.intencion !== 'recordar') meta.memoria_nueva = datos.memoriaNueva;
    if (datos.nombreUsuario) meta.nombre_usuario = datos.nombreUsuario;
  }
  // Charla: no se escribe nada; la respuesta es la del modelo, sin promesas de haber hecho algo
  if (datos.intencion === 'charla') meta.respuesta_usuario = textoCharla(datos.respuestaUsuario, Boolean(datos.memoriaNueva));
  if (datos.intencion === 'corregir') {
    // Añadir al contenido va por la función anadir_contenido, que concatena en la base de datos; el resto de cambios, con un
    // PATCH. No dependen uno del otro (anadir_contenido nunca va junto a contenido).
    const { anadir_contenido: anadir, ...comunes } = datos.correccion.cambios;
    // Una alarma que ya sonó (quedó «hecha») vuelve a estar pendiente si se le da otra hora o se cambia de tipo: solo las del aviso citado o las
    // recientes (contexto.reabribles); nunca otra cosa hecha.
    const reabribles = new Set(contexto.reabribles ?? []);
    const porIdCambios = datos.correccion.porId ?? null;
    const lista = (xs) => xs.map(encodeURIComponent).join(',');
    // Sin cambio de tipo, un solo PATCH para todos. Con él, un PATCH por elemento: cada uno lleva sus fechas
    const grupos = porIdCambios ? datos.correccion.ids.map((id) => ({ ids: [id], cambios: { ...comunes, ...porIdCambios[id] } })) : [{ ids: datos.correccion.ids, cambios: comunes }];
    for (const g of grupos) {
      const reabrir = g.ids.filter((id) => reabribles.has(id) && (esFecha(g.cambios.recordar_en) || porIdCambios));
      const normales = g.ids.filter((id) => !reabrir.includes(id));
      if (Object.keys(g.cambios).length > 0 && normales.length > 0) peticiones.push(peticion('corregir items', 'PATCH', `/items?id=in.(${lista(normales)})`, g.cambios, 'return=representation'));
      if (reabrir.length > 0) peticiones.push(peticion('reabrir alarma', 'PATCH', `/items?id=in.(${lista(reabrir)})`, { ...g.cambios, estado: 'pendiente' }, 'return=representation'));
    }
    // La confirmación de una hora nueva o de un cambio de tipo la redacta Resultado con lo guardado (no con lo que diga el modelo)
    if (datos.correccion.convertir) meta.conversion = datos.correccion.convertir;
    else if (['recordar_en', 'fecha_inicio', 'fecha_fin'].some((k) => esFecha(comunes[k]))) meta.hora_movida = true;
    if (anadir) peticiones.push(peticion('añadir al contenido', 'POST', '/rpc/anadir_contenido', { p_ids: datos.correccion.ids, p_texto: anadir }, 'return=representation'));
    const nuevos = proyectosNuevos(datos, config);
    if (nuevos.length > 0) meta.proyectos_nuevos = nuevos;
  }
  if (datos.intencion === 'completar') {
    const ids = selIds.map(encodeURIComponent).join(',');
    peticiones.push(peticion('completar items', 'PATCH', `/items?id=in.(${ids})`, { estado: 'hecho' }, 'return=representation'));
  }
  if (datos.intencion === 'consultar') {
    const q = datos.consulta;
    meta.consulta_url = urlConsulta(base, q);
    // Con todo el detalle si lo pide el atajo o si el mensaje lo dice («qué tengo pendiente completo», «dámelo todo entero»)
    const completo = q.completo || pideCompleto(contexto.mensaje);
    meta.consulta = { tipo: q.tipo, vista: q.vista, lista: q.lista, proyecto: q.proyecto, buscar: q.buscar, completo, estado: q.estado, con_rango: Boolean(q.desde || q.hasta), limite: MAX_FILAS_CONSULTA };
  }
  const cuerpoMensaje = { procesado: true, error: null };
  if (datos.intencion === 'aclarar') {
    // La pregunta queda esperando respuesta, con el hilo hasta ella para devolvérselo al modelo cuando llegue
    if (typeof contexto.mensaje !== 'string' || contexto.mensaje === '') {
      throw new Error('Planificar: falta el texto del mensaje para guardar el hilo de la pregunta');
    }
    Object.assign(cuerpoMensaje, {
      pregunta: datos.pregunta,
      pregunta_pendiente: true,
      hilo: [...(contexto.hiloPrevio ?? []), { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: sinMarcaDeCodigo(texto) }],
    });
  }
  if (meta.aviso_compra && datos.intencion === 'guardar') {
    // Se apunta lo de la compra y la pregunta del aviso queda abierta (con el día en el hilo, para resolver la respuesta por código)
    const { pregunta: texto, ...aviso } = meta.aviso_compra;
    Object.assign(cuerpoMensaje, {
      pregunta: texto,
      pregunta_pendiente: true,
      hilo: [...(contexto.hiloPrevio ?? []), { rol: 'user', texto: contexto.mensaje }, { rol: 'model', texto: turnoAvisoCompra(aviso, texto) }],
    });
  }
  peticiones.push(marcarMensaje(cuerpoMensaje));

  // La pregunta anterior queda contestada en cuanto este mensaje se procesa bien (si falló, sigue abierta para reintentar)
  if (contexto.pendienteId) {
    peticiones.unshift(peticion('cerrar pregunta anterior', 'PATCH', `/mensajes?id=eq.${encodeURIComponent(contexto.pendienteId)}`, { pregunta_pendiente: false }, 'return=minimal'));
  }
  return { peticiones, meta };
}

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const mensajeId = $('Guardar mensaje').first().json.id;
if (!mensajeId) throw new Error('Planificar: "Guardar mensaje" no devolvió el id del mensaje');

// Referencias cortas (i1, i2…) → ids reales, tal como las vio el modelo en "Construir petición"
const construccion = $('Construir petición').first().json;
const refs = construccion.refs ?? {};

// La conversación: este mensaje (los mensajes seguidos ya juntados por el flujo de WhatsApp), la pregunta anterior que contesta (si la
// hay) y el hilo guardado hasta ella
const contexto = {
  mensaje: $('Entrada').first().json.mensaje,
  // Demasiados mensajes seguidos (lo decide el flujo de WhatsApp): no se procesa nada y se contesta con su aviso
  avisoDemasiados: $('Entrada').first().json.demasiados === true ? String($('Entrada').first().json.aviso_demasiados ?? '') : '',
  pendienteId: construccion.pendiente_id ?? null,
  hiloPrevio: construccion.hilo_previo ?? [],
  pedirNombre: construccion.pedir_nombre === true,
  esperaNombre: construccion.espera_nombre === true,
  nombreSecretaria: typeof construccion.nombre_secretaria === 'string' ? construccion.nombre_secretaria : null,
  // La memoria permanente con sus ids (para /memory y /forget) y el tope
  memoria: Array.isArray(construccion.memoria_filas) ? construccion.memoria_filas : [],
  // El horario fijo
  horario: Array.isArray(construccion.horario) ? construccion.horario : [],
  // El aviso de alarma o cita al que responde el usuario (referencias cortas) y las alarmas ya sonadas que se pueden reabrir (ids reales)
  citados: Array.isArray(construccion.avisos_citados) ? construccion.avisos_citados : [],
  reabribles: Array.isArray(construccion.reabribles) ? construccion.reabribles : [],
  // Tipo y fechas de lo pendiente y de las alarmas ya sonadas, por referencia corta: de ahí salen las fechas al cambiar de tipo
  fechas: construccion.fechas && typeof construccion.fechas === 'object' ? construccion.fechas : {},
  // El pendiente más nuevo (referencia corta y cuándo se apuntó): para un «tarea» suelto que llega tarde (tipoSuelto)
  reciente: construccion.reciente && typeof construccion.reciente === 'object' ? construccion.reciente : null,
};

// La agenda (eventos y tareas con fecha límite pendientes) llega con las referencias cortas; aquí se pasan a ids reales
const agenda = (construccion.agenda ?? []).filter((a) => Object.prototype.hasOwnProperty.call(refs, a.id)).map((a) => ({ ...a, id: refs[a.id] }));

// Referencias cortas de los archivos recibidos (a1, a2…) -> ids reales, con su nombre actual
const archivos = { refs: construccion.refs_archivos ?? {}, info: construccion.archivos_info ?? {} };

// Los proyectos que existen (todos, para reconocer uno cerrado; y los activos, que son los que vio el modelo)
const resumenProyectos = Array.isArray(construccion.proyectos) ? construccion.proyectos : [];
const configPlan = {
  ...config,
  proyectos: resumenProyectos.map((p) => p.nombre).filter((n) => typeof n === 'string'),
  proyectos_activos: resumenProyectos.filter((p) => p.estado === 'activo').map((p) => p.nombre).filter((n) => typeof n === 'string'),
};

// Los elementos pendientes que vio el modelo, con ids reales: para resolver "todas las tareas" y nombrar lo que se va a tocar
const pendientes = (construccion.pendientes ?? []).filter((r) => Object.prototype.hasOwnProperty.call(refs, r.id)).map((r) => ({ ...r, id: refs[r.id] }));

// Si "¿Hace falta el modelo?" se lo saltó (comando o frase fija), lo que llega es la salida de "Construir petición": no hay respuesta del modelo
const llegada = $input.first().json;
const resp = llegada?.saltar_modelo === true ? { error: 'no se llamó al modelo y el mensaje no es un comando' } : llegada;
const plan = planificar({ resp, mensajeId, config: configPlan, ahora: new Date(), refs, contexto, agenda, archivos, pendientes });
return plan.peticiones.map((p) => ({ json: { ...p, meta: plan.meta } }));
