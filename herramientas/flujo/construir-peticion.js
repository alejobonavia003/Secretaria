// Nodo "Construir petición": monta el cuerpo de la llamada a Gemini.
// El prompt se inserta al generar el flujo desde prompts/clasificador.md; no editar aquí.
const PROMPT = __PROMPT__;

const config = $('Configuración').first().json.config;
// El mensaje que se procesa: uno solo o varios seguidos que el flujo de WhatsApp ya ha juntado (cola de la base de datos)
const entrada = $('Entrada').first().json;

if (!entrada.mensaje || !entrada.fecha_actual) {
  throw new Error('Construir petición: faltan mensaje o fecha_actual (Gemini rechaza un contenido vacío y no se gasta cuota)');
}

// "Leer memoria" devuelve un item vacío si la tabla no tiene filas: se descartan los que no son términos. El modelo ve término y
// significado; "Planificar" recibe además el id (para /memory y /forget)
const memoriaFilas = $('Leer memoria')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.termino === 'string' && typeof r.significado === 'string')
  .map(({ id, termino, significado }) => ({ id, termino, significado }));
const memoria = memoriaFilas.map(({ termino, significado }) => ({ termino, significado }));

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Todos los items pendientes (los más recientes primero), para que el modelo pueda referirse a cualquiera
// al corregir, completar o cancelar. Se le dan referencias cortas (i1, i2…) en lugar de los ids de la base de datos:
// gastan menos tokens y son más difíciles de inventar. "Planificar" las traduce de vuelta con "refs".
// Se quitan las claves nulas (menos tokens) y los items vacíos que devuelve "Always Output Data". El contenido se le enseña recortado
// (MAX_CONTENIDO_MODELO): sirve para saber de qué va cada uno; para añadirle algo no hace falta el texto entero (lo concatena la base de datos).
const MAX_CONTENIDO_MODELO = 120;
const refs = {};
const itemsPendientes = $('Leer items pendientes')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string')
  .map((r, n) => {
    const { id, ...resto } = r;
    refs[`i${n + 1}`] = id;
    if (typeof resto.contenido === 'string') {
      const c = resto.contenido.replace(/\s+/g, ' ').trim();
      resto.contenido = c.length > MAX_CONTENIDO_MODELO ? `${c.slice(0, MAX_CONTENIDO_MODELO)}…` : c || null;
    }
    return { id: `i${n + 1}`, ...Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== null)) };
  });

// Avisos: si el usuario RESPONDE a un aviso de alarma o de cita, qué elementos llevaba; y las alarmas que sonaron hace poco
// (ya «hechas»). Unos y otros reciben referencia corta como los pendientes, para que el modelo pueda moverlos («pospón la alarma de la
// ropa 10 minutos») y Planificar pueda reabrir una alarma que ya sonó. Si la lectura falla, no hay avisos.
const ID_AVISO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Con try: en un flujo que todavía no tenga el nodo «Leer avisos», sin avisos (como antes)
let leidoAvisos;
try {
  leidoAvisos = $('Leer avisos')
    .all()
    .map((i) => i.json)
    .find((r) => r && Array.isArray(r.citados));
} catch (e) {
  leidoAvisos = undefined;
}
const valido = (it) => it && typeof it.id === 'string' && ID_AVISO.test(it.id) && typeof it.titulo === 'string' && ['tarea', 'evento'].includes(it.tipo);
const refPorId = Object.fromEntries(Object.entries(refs).map(([r, id]) => [id, r]));
const conRef = (it) => {
  if (refPorId[it.id]) return refPorId[it.id];
  const ref = `i${Object.keys(refs).length + 1}`;
  refs[ref] = it.id;
  refPorId[it.id] = ref;
  const { id, aviso, ...resto } = it;
  itemsPendientes.push({ id: ref, ...Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== null && v !== undefined)) });
  return ref;
};
const avisoCitado = (leidoAvisos?.citados ?? []).filter(valido).map((it) => ({
  ref: conRef(it), tipo: it.tipo, aviso: it.aviso, titulo: it.titulo, estado: it.estado,
  recordar_en: it.recordar_en ?? null, fecha_inicio: it.fecha_inicio ?? null, fecha_fin: it.fecha_fin ?? null,
}));
const recientes = (Array.isArray(leidoAvisos?.recientes) ? leidoAvisos.recientes : []).filter(valido);
recientes.forEach(conRef);
// Las alarmas ya sonadas («hechas») que se pueden reabrir al darles otra hora: solo las del aviso citado y las recientes
const reabribles = [...new Set([...(leidoAvisos?.citados ?? []), ...recientes].filter((it) => valido(it) && it.tipo === 'tarea' && it.estado === 'hecho').map((it) => it.id))];

// Para "Planificar": lo justo de cada pendiente para resolver "todas las tareas", "todos los pensamientos"… y nombrar lo que se va a tocar
// (sin las alarmas ya sonadas: «quita todas las alarmas» no debe contar las que ya pasaron)
const pendientes = itemsPendientes.filter((i) => i.estado !== 'hecho').map(({ id, tipo, titulo, lista, proyecto, recordar_en, fecha_limite, fecha_inicio, fecha_fin }) => ({ id, tipo, titulo, lista, proyecto, recordar_en, fecha_limite, fecha_inicio, fecha_fin }));
// Tipo y fechas de TODO lo que el modelo ve (también las alarmas ya sonadas), por referencia corta: Planificar las usa al cambiar de tipo
// (una alarma pasa a cita con su hora, una cita a tarea con su día…) y para preguntar la hora si falta
const fechas = Object.fromEntries(itemsPendientes.map(({ id, tipo, titulo, recordar_en, fecha_limite, fecha_inicio, fecha_fin }) => [id, { tipo, titulo, recordar_en: recordar_en ?? null, fecha_limite: fecha_limite ?? null, fecha_inicio: fecha_inicio ?? null, fecha_fin: fecha_fin ?? null }]));

// Proyectos que existen (función resumen_proyectos): nombre, estado y cuántas cosas pendientes tienen. El modelo ve los
// activos. Si la lectura falla, no hay proyectos conocidos: un proyecto que se nombre se crea (o se pregunta si se parece a otro).
const proyectos = $('Leer proyectos')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.nombre === 'string' && typeof r.estado === 'string')
  .map(({ nombre, estado, pendientes: n }) => ({ nombre, estado, pendientes: Number(n) || 0 }));
const proyectosActivos = proyectos.filter((p) => p.estado === 'activo').map((p) => p.nombre);

// La agenda para "Planificar": eventos con inicio y tareas con fecha límite pendientes. Sirve para detectar solapes y
// días ocupados antes de guardar o mover algo. Con referencias cortas, como el resto (Planificar las traduce).
const agenda = itemsPendientes
  .filter((i) => i.estado !== 'hecho')
  .filter((i) => (i.tipo === 'evento' && i.fecha_inicio) || (i.tipo === 'tarea' && i.fecha_limite))
  .map(({ id, tipo, titulo, fecha_inicio, fecha_fin, fecha_limite }) => ({ id, tipo, titulo, fecha_inicio, fecha_fin, fecha_limite }));

// Archivos recibidos (los 60 más recientes). Se le enseñan al modelo los pendientes de clasificar, el más reciente primero
// (a1), con referencias cortas como los items, más el archivo al que el usuario se refirió al RESPONDER a un mensaje: su foto
// o la confirmación de la secretaria. Ese caso lo resuelve este código (el id del mensaje citado llega en contexto_id) y el
// modelo solo recibe la referencia. Si el mensaje citado no corresponde a ningún archivo, no hay archivo citado.
const MAX_ARCHIVOS_VISIBLES = 30;
const filasArchivos = $('Leer archivos')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string');
const citado = entrada.contexto_id
  ? filasArchivos.find((f) => f.respuesta_wa_id === entrada.contexto_id || f.mensajes?.wa_message_id === entrada.contexto_id)
  : undefined;
const visibles = filasArchivos.filter((f) => f.estado === 'pendiente').slice(0, MAX_ARCHIVOS_VISIBLES);
if (citado && !visibles.includes(citado)) visibles.push(citado);

const fmtRecibido = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const refsArchivos = {};
const infoArchivos = {};
const archivosPrompt = visibles.map((f, n) => {
  const ref = `a${n + 1}`;
  refsArchivos[ref] = f.id;
  infoArchivos[ref] = { nombre: f.nombre, creado: f.created_at };
  const pie = typeof f.mensajes?.texto_original === 'string' ? f.mensajes.texto_original.trim().slice(0, 100) : '';
  return {
    id: ref,
    nombre: f.nombre,
    recibido: f.created_at ? fmtRecibido.format(new Date(f.created_at)) : null,
    estado: f.estado,
    ...(pie ? { pie } : {}),
    ...(f.carpeta_destino ? { carpeta: f.carpeta_destino } : {}),
  };
});
const archivoCitado = citado ? (Object.entries(refsArchivos).find(([, id]) => id === citado.id)?.[0] ?? '') : '';

// Si la secretaria hizo una pregunta hace poco y sigue sin respuesta, este mensaje es su respuesta: se le devuelve
// al modelo el hilo guardado (turnos user/model) y la pregunta. "Leer pregunta pendiente" ya aplica la caducidad.
// El hilo debe alternar user/model y acabar en un turno del modelo; si está dañado se ignora (sin romper el flujo).
// Pueden estar abiertas hasta tres preguntas a la vez (el usuario escribe antes de que le llegue la respuesta): el mensaje contesta a la
// que encaja con lo que dice, y una orden nueva («borra…», «dame…») no contesta a ninguna y las deja abiertas.
// Las funciones son la MISMA sección de planificar.js, que el generador inserta aquí; no editar aquí.
const { interpretarComando, interpretarAplazamiento, pideListarRepetidos, elegirPregunta, siNoSinPregunta, pideBorrarTodo, seccionElegida, respuestaConfirmacion } = __COMANDOS__;
const hiloCoherente = (h) =>
  h.length >= 2 && h.length % 2 === 0 && h.every((t, i) => t?.rol === (i % 2 === 0 ? 'user' : 'model') && typeof t.texto === 'string' && t.texto !== '');
const todas = $('Leer pregunta pendiente')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.hilo) && typeof r.pregunta === 'string');
const abiertas = todas.filter((r) => hiloCoherente(r.hilo));
// Si la única pregunta abierta tiene el hilo dañado, se ignora el hilo pero la pregunta se cierra igualmente
const pendiente = elegirPregunta(entrada.mensaje, abiertas) ?? (abiertas.length === 0 ? (todas[0] ?? null) : null);
const hiloPrevio = pendiente && hiloCoherente(pendiente.hilo) ? pendiente.hilo : [];
const preguntaPendiente = hiloPrevio.length > 0 ? pendiente.pregunta : '';

// El nombre que el usuario le ha puesto a la secretaria vive en la memoria con un término fijo. Sin nombre, la primera respuesta es
// preguntárselo (lo hace Planificar); si la última pregunta pendiente ya era esa, el mensaje es la respuesta y se procesa con el modelo.
const NOMBRE_TERMINO = 'nombre de la secretaria';
const filaNombre = memoria.find((m) => sinAcentos(m.termino) === NOMBRE_TERMINO);
const nombreSecretaria = filaNombre ? filaNombre.significado : null;
const esperaNombre = hiloPrevio.length > 0 && (() => {
  try {
    return JSON.parse(hiloPrevio.at(-1).texto)?.motivo === 'pedir_nombre';
  } catch {
    return false;
  }
})();
const pedirNombre = nombreSecretaria === null && !esperaNombre;

// Comandos y frases fijas (/help, /pending, «cómo te llamas», «llámate Lola», «qué tengo hoy»…): los resuelve "Planificar" sin el
// modelo, y lo mismo la primera pregunta del nombre. En esos casos no se llama a Gemini (nodo "¿Hace falta el modelo?"): ni espera ni
// coste. La función es la MISMA sección de planificar.js, que el generador inserta aquí; no editar aquí.
// Lo mismo con los aplazamientos simples al responder a un aviso («10 minutos más», «pospón media hora»).
const saltarModelo =
  entrada.demasiados === true ||
  pedirNombre ||
  interpretarComando(entrada.mensaje, { ahora: new Date(), nombre: nombreSecretaria }) !== null ||
  interpretarAplazamiento(entrada.mensaje, avisoCitado, new Date()) !== null ||
  pideListarRepetidos(entrada.mensaje, hiloPrevio) !== null ||
  (!esperaNombre && siNoSinPregunta(entrada.mensaje, hiloPrevio) !== null) ||
  (!pedirNombre && pideBorrarTodo(entrada.mensaje)) ||
  seccionElegida(entrada.mensaje, hiloPrevio) !== null ||
  respuestaConfirmacion(entrada.mensaje, hiloPrevio) !== null;

// Si responde a un aviso, el modelo recibe delante del mensaje de qué alarma o cita se trata (solo en ese caso: el resto de mensajes
// le llegan igual que siempre). Así «muévela al viernes a las 9» sabe a qué se refiere.
const fmtAviso = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const describirCitado = (c) => {
  const cuando = c.tipo === 'tarea' ? c.recordar_en : c.fecha_inicio;
  const hora = cuando && !Number.isNaN(Date.parse(cuando)) ? fmtAviso.format(new Date(cuando)) : 'sin hora';
  const estado = c.tipo === 'tarea' && c.estado === 'hecho' ? ', ya sonó' : '';
  return `${c.ref} «${String(c.titulo).replace(/\s+/g, ' ').trim()}» (${c.tipo === 'tarea' ? 'alarma' : 'cita'}, ${hora}${estado})`;
};
const notaAviso = avisoCitado.length > 0
  ? `[El usuario responde a tu aviso de: ${avisoCitado.map(describirCitado).join('; ')}. Si pide aplazarla, moverla o cambiarla, es un corregir de ${avisoCitado.length === 1 ? 'ese elemento' : 'uno de ellos'}.]\n`
  : '';

const sistema = PROMPT
  .split('{{fecha_actual}}').join(entrada.fecha_actual)
  .split('{{proyectos}}').join(proyectosActivos.length > 0 ? proyectosActivos.join(', ') : '(ninguno todavía)')
  .split('{{memoria}}').join(JSON.stringify(memoria))
  .split('{{nombre_secretaria}}').join(nombreSecretaria ?? '(todavía no te ha puesto nombre)')
  .split('{{pregunta_pendiente}}').join(preguntaPendiente)
  .split('{{ultimos_items}}').join(JSON.stringify(itemsPendientes))
  .split('{{archivos}}').join(JSON.stringify(archivosPrompt))
  .split('{{archivo_citado}}').join(archivoCitado);

return [
  {
    json: {
      modelo: config.modelo,
      // Los proyectos (todos, con su estado y lo pendiente): "Planificar" reconoce los que existen y "Resultado" los lista
      proyectos,
      refs,
      pendientes,
      // Referencias cortas de archivos (a1, a2…) -> id real, y su nombre actual y fecha de recepción (para renombrarlos)
      refs_archivos: refsArchivos,
      archivos_info: infoArchivos,
      agenda,
      // Para "Planificar": la pregunta anterior que este mensaje cierra y el hilo que hay que acumular
      pendiente_id: pendiente?.id ?? null,
      // Nombre de la secretaria: si falta se pregunta antes que nada; si se acaba de preguntar, la respuesta es el nombre
      pedir_nombre: pedirNombre,
      // El nombre actual (para /name y /about)
      nombre_secretaria: nombreSecretaria,
      memoria_filas: memoriaFilas,
      espera_nombre: esperaNombre,
      // Sin llamada a Gemini: "Planificar" lo contesta con código
      saltar_modelo: saltarModelo,
      // El aviso al que responde el usuario (con referencias cortas) y las alarmas ya sonadas que se pueden reabrir (ids reales)
      avisos_citados: avisoCitado,
      reabribles,
      fechas,
      hilo_previo: hiloPrevio,
      cuerpo: {
        systemInstruction: { parts: [{ text: sistema }] },
        contents: [
          ...hiloPrevio.map((t) => ({ role: t.rol, parts: [{ text: t.texto }] })),
          { role: 'user', parts: [{ text: `${notaAviso}${entrada.mensaje}` }] },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          // Solo si se ha elegido un nivel en Configuración (NIVEL_RAZONAMIENTO); vacío = no se envía y Gemini usa su valor por defecto.
          // En mayúsculas, como el enum de la API (ThinkingConfig.thinkingLevel: MINIMAL, LOW, MEDIUM, HIGH; verificado en su documento de descubrimiento)
          ...(config.nivel_razonamiento ? { thinkingConfig: { thinkingLevel: config.nivel_razonamiento.toUpperCase() } } : {}),
        },
      },
    },
  },
];
