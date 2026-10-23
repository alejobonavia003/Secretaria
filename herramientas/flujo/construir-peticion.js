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
    // created_at no se le enseña al modelo (el prompt no cambia): solo sirve para «reciente», abajo
    const { id, created_at: _creado, ...resto } = r;
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
// Horario fijo semanal: con try, por si el flujo aún no tiene el nodo; si la tabla no existe (base de datos sin actualizar), la lectura falla y no hay horario
const DIAS_SEMANA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
let horario = [];
try {
  horario = $('Leer horario')
    .all()
    .map((i) => i.json)
    .filter((b) => b && typeof b.id === 'string' && typeof b.titulo === 'string' && Number.isInteger(b.dia_semana) && typeof b.hora_inicio === 'string' && typeof b.hora_fin === 'string')
    .map(({ id, titulo, dia_semana, hora_inicio, hora_fin }) => ({ id, titulo, dia_semana, hora_inicio: hora_inicio.slice(0, 5), hora_fin: hora_fin.slice(0, 5) }));
} catch (e) {
  horario = [];
}
// Lo que el usuario quitó por WhatsApp en los últimos 7 días (base de datos 1.4), para «deshaz». Con try: si falta el nodo o la base de datos 1.4, no hay nada que recuperar
let quitados = [];
try {
  quitados = $('Leer quitados')
    .all()
    .map((i) => i.json)
    .filter((r) => r && typeof r.id === 'string' && typeof r.titulo === 'string' && typeof r.quitado_en === 'string' && ['archivado', 'hecho'].includes(r.estado))
    .map(({ id, tipo, titulo, estado, quitado_en, recordar_en, fecha_limite, lista, proyecto }) => ({ id, tipo, titulo, estado, quitado_en, recordar_en: recordar_en ?? null, fecha_limite: fecha_limite ?? null, lista: lista ?? null, proyecto: proyecto ?? null }));
} catch (e) {
  quitados = [];
}
const horarioPrompt = horario.map((b) => `${DIAS_SEMANA[b.dia_semana] ?? b.dia_semana} ${b.hora_inicio}-${b.hora_fin} ${b.titulo}`);

const avisoCitado = (leidoAvisos?.citados ?? []).filter(valido).map((it) => ({
  ref: conRef(it), tipo: it.tipo, aviso: it.aviso, titulo: it.titulo, estado: it.estado,
  recordar_en: it.recordar_en ?? null, fecha_inicio: it.fecha_inicio ?? null, fecha_fin: it.fecha_fin ?? null,
}));
const recientes = (Array.isArray(leidoAvisos?.recientes) ? leidoAvisos.recientes : []).filter(valido);
recientes.forEach(conRef);
// Las alarmas ya sonadas («hechas») que se pueden reabrir al darles otra hora: solo las del aviso citado y las recientes
const reabribles = [...new Set([...(leidoAvisos?.citados ?? []), ...recientes].filter((it) => valido(it) && it.tipo === 'tarea' && it.estado === 'hecho').map((it) => it.id))];

// El pendiente más nuevo (la lectura viene ordenada por created_at, el primero es i1), con cuándo se apuntó: un «tarea» suelto que llega
// tarde a una pregunta ya resuelta se contesta por código si se apuntó algo hace menos de 2 minutos (tipoSuelto, en planificar.js)
const primeroLeido = $('Leer items pendientes').all().map((i) => i.json).find((r) => r && typeof r.id === 'string');
const reciente = primeroLeido && typeof primeroLeido.created_at === 'string'
  ? { ref: 'i1', tipo: primeroLeido.tipo, titulo: primeroLeido.titulo, recordar_en: primeroLeido.recordar_en ?? null, fecha_limite: primeroLeido.fecha_limite ?? null, fecha_inicio: primeroLeido.fecha_inicio ?? null, created_at: primeroLeido.created_at }
  : null;

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
// Un aviso de la secretaria puede juntar varios archivos : responderle los cita a todos
const citados = entrada.contexto_id
  ? filasArchivos.filter((f) => f.respuesta_wa_id === entrada.contexto_id || f.mensajes?.wa_message_id === entrada.contexto_id)
  : [];
const citado = citados[0];
const visibles = filasArchivos.filter((f) => f.estado === 'pendiente').slice(0, MAX_ARCHIVOS_VISIBLES);
for (const c of citados) if (!visibles.includes(c)) visibles.push(c);

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
const refDeArchivo = (fila) => Object.entries(refsArchivos).find(([, id]) => id === fila.id)?.[0] ?? '';
const refsCitados = citados.map(refDeArchivo).filter(Boolean);
const archivoCitado = refsCitados.join(', ');

// Si la secretaria hizo una pregunta hace poco y sigue sin respuesta, este mensaje es su respuesta: se le devuelve
// al modelo el hilo guardado (turnos user/model) y la pregunta. "Leer pregunta pendiente" ya aplica la caducidad.
// El hilo debe alternar user/model y acabar en un turno del modelo; si está dañado se ignora (sin romper el flujo).
// Pueden estar abiertas hasta tres preguntas a la vez (el usuario escribe antes de que le llegue la respuesta): el mensaje contesta a la
// que encaja con lo que dice, y una orden nueva («borra…», «dame…») no contesta a ninguna y las deja abiertas.
// Las funciones son la MISMA sección de planificar.js, que el generador inserta aquí; no editar aquí.
const { interpretarComando, interpretarAplazamiento, pideListarRepetidos, elegirPregunta, siNoSinPregunta, pideBorrarTodo, borrarSecciones, interpretarDeshacer, seccionElegida, respuestaConfirmacion, quitarConcreto, tipoSuelto, respuestaAvisoCompra, respuestaOferta, esOrdenNueva, interpretarCarpetaSuelta, interpretarMoverCarpeta } = __COMANDOS__;
const hiloCoherente = (h) =>
  h.length >= 2 && h.length % 2 === 0 && h.every((t, i) => t?.rol === (i % 2 === 0 ? 'user' : 'model') && typeof t.texto === 'string' && t.texto !== '');
const todas = $('Leer pregunta pendiente')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.hilo) && typeof r.pregunta === 'string');
const abiertas = todas.filter((r) => hiloCoherente(r.hilo));
// Responder citando CUALQUIER respuesta de la secretaria (base de datos 1.4): el flujo de WhatsApp anota en el mensaje del usuario los
// ids de lo que se le contestó, y aquí se busca por el id del mensaje citado. Si la respuesta citada dejó una pregunta abierta (aunque ya
// haya caducado o haya otras más recientes), el mensaje contesta a ésa; si no, el modelo recibe delante qué dijo la secretaria. Sin actualizar la base de datos a la 1.4
// (o sin cita) no hay fila y todo sigue como antes.
const filaCitada = (() => {
  if (!entrada.contexto_id) return undefined;
  try {
    return $('Leer respuesta citada').all().map((i) => i.json).find((r) => r && typeof r.id === 'string' && typeof r.respuesta_texto === 'string');
  } catch (e) {
    return undefined; // el nodo no se ejecutó (flujo antiguo): sin cita
  }
})();
// Condiciones para que citar una pregunta sea contestarla: sigue abierta; se hizo hace menos de un día y, si es una confirmación (sí/no: borrar,
// apuntar con choque…), antes de que caduque (si no, un «sí» a una pregunta de hace días ejecutaría datos viejos); y el mensaje no es una orden
// nueva que no encaje con ella (cita una pregunta y manda «dame las tareas»: es otra cosa).
const candidataCitada = filaCitada && filaCitada.pregunta_pendiente === true && Array.isArray(filaCitada.hilo) && typeof filaCitada.pregunta === 'string' && hiloCoherente(filaCitada.hilo)
  ? { id: filaCitada.id, pregunta: filaCitada.pregunta, hilo: filaCitada.hilo }
  : null;
const motivoCitada = (() => {
  try {
    return JSON.parse(candidataCitada?.hilo.at(-1)?.texto ?? '')?.motivo ?? '';
  } catch {
    return '';
  }
})();
const edadCitadaMs = Date.now() - Date.parse(filaCitada?.created_at ?? '');
const reciente24h = Number.isFinite(edadCitadaMs) && edadCitadaMs < 24 * 3600 * 1000;
const sigueVigente = !String(motivoCitada).startsWith('confirmar_') || edadCitadaMs < (Number.isFinite(config.caducidad_min) ? config.caducidad_min : 30) * 60000;
const preguntaCitada = candidataCitada && reciente24h && sigueVigente && (!esOrdenNueva(entrada.mensaje) || elegirPregunta(entrada.mensaje, [candidataCitada]) !== null) ? candidataCitada : null;
// Si la única pregunta abierta tiene el hilo dañado, se ignora el hilo pero la pregunta se cierra igualmente
const pendiente = preguntaCitada ?? elegirPregunta(entrada.mensaje, abiertas) ?? (abiertas.length === 0 ? (todas[0] ?? null) : null);
const hiloPrevio = pendiente && hiloCoherente(pendiente.hilo) ? pendiente.hilo : [];
const preguntaPendiente = hiloPrevio.length > 0 ? pendiente.pregunta : '';
// Preguntas que el usuario ya había VISTO y deja sin contestar al mandar otra cosa: si este mensaje no contesta a ninguna
// (una orden nueva) y llegó después de que se hiciera la pregunta (con unos segundos de margen), esa pregunta se cierra y se le dice. Si
// llegó antes (escribió dos cosas seguidas y la pregunta de la primera aún no le había llegado), sigue abierta, como antes. Una pregunta sin
// hora (de antes de este cambio) o un mensaje sin hora de llegada (prueba manual) no se tocan.
const MARGEN_VISTA_MS = 3000;
const recibido = Date.parse(entrada.recibido_at ?? '');
// El motivo con el que Planificar dejó la pregunta (último turno del hilo): «oferta» = la charla ofreció apuntar algo 
const motivoDe = (q) => {
  try {
    return JSON.parse(q.hilo.at(-1)?.texto ?? '')?.motivo ?? '';
  } catch {
    return '';
  }
};
const preguntasIgnoradas = pendiente || !Number.isFinite(recibido)
  ? []
  : abiertas
    .filter((q) => Number.isFinite(Date.parse(q.hilo.at(-1)?.en ?? '')) && recibido > Date.parse(q.hilo.at(-1).en) + MARGEN_VISTA_MS)
    .map((q) => ({ id: q.id, pregunta: q.pregunta, silenciosa: motivoDe(q) === 'oferta' }));

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
  (!pedirNombre && (pideBorrarTodo(entrada.mensaje) || borrarSecciones(entrada.mensaje) !== null || interpretarDeshacer(entrada.mensaje) !== null)) ||
  seccionElegida(entrada.mensaje, hiloPrevio) !== null ||
  respuestaConfirmacion(entrada.mensaje, hiloPrevio) !== null ||
  (!pedirNombre && quitarConcreto(entrada.mensaje, pendientes) !== null) ||
  (!pedirNombre && !esperaNombre && tipoSuelto(entrada.mensaje, hiloPrevio, reciente, new Date()) !== null) ||
  (!pedirNombre && !esperaNombre && respuestaAvisoCompra(entrada.mensaje, hiloPrevio) !== null) ||
  (!pedirNombre && !esperaNombre && respuestaOferta(entrada.mensaje, hiloPrevio) !== null) ||
  // Un archivo con pie (o su confirmación respondida) que es solo una ruta de carpeta: se archiva por código
  (!pedirNombre && !esperaNombre && interpretarCarpetaSuelta(entrada.mensaje, refsCitados) !== null) ||
  // Meter una carpeta dentro de otra: se reconoce por código («mete la carpeta Viajes dentro de Fotos»)
  (!pedirNombre && !esperaNombre && interpretarMoverCarpeta(entrada.mensaje) !== null);

// Si responde a un aviso, el modelo recibe delante del mensaje de qué alarma o cita se trata (solo en ese caso: el resto de mensajes
// le llegan igual que siempre). Así «muévela al viernes a las 9» sabe a qué se refiere.
const fmtAviso = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const describirCitado = (c) => {
  const cuando = c.tipo === 'tarea' ? c.recordar_en : c.fecha_inicio;
  const hora = cuando && !Number.isNaN(Date.parse(cuando)) ? fmtAviso.format(new Date(cuando)) : 'sin hora';
  const estado = c.tipo === 'tarea' && c.estado === 'hecho' ? ', ya sonó' : '';
  return `${c.ref} «${String(c.titulo).replace(/\s+/g, ' ').trim()}» (${c.tipo === 'tarea' ? 'alarma' : 'cita'}, ${hora}${estado})`;
};
// Si contesta a una oferta de la charla («¿quieres que te lo apunte como tarea?»), el modelo recibe delante qué hacer con el «sí» 
const notaOferta = pendiente && motivoDe(pendiente) === 'oferta'
  ? '[El usuario responde a tu oferta de apuntar algo. Si acepta (sí, apúntalo, vale…), guárdalo como tarea (tipo tarea) con un título corto y claro basado en su pregunta anterior, sin fecha salvo que él la diga; no vuelvas a preguntar qué apuntar. Si lo rechaza, usa descartar.]\n'
  : '';
// Si cita una respuesta de la secretaria que no era una pregunta abierta ni un aviso ni la confirmación de un archivo (por ejemplo un «Apuntado…»
// o una lista), el modelo recibe delante lo que ella dijo y a qué contestaba 
const recortar = (t, max) => {
  const x = String(t ?? '').replace(/\s+/g, ' ').trim();
  return x.length > max ? `${x.slice(0, max).trimEnd()}…` : x;
};
// Una respuesta larga (varios mensajes) se recorta por el medio: así se ve el principio y el final, que es lo que suele citarse (una pregunta, un cierre)
const recortarMedio = (t, max) => {
  const x = String(t ?? '').replace(/\s+/g, ' ').trim();
  return x.length > max ? `${x.slice(0, Math.floor(max / 2)).trimEnd()} […] ${x.slice(-Math.floor(max / 2)).trimStart()}` : x;
};
const notaCitada = filaCitada && !preguntaCitada && avisoCitado.length === 0 && !citado
  ? `[El usuario responde a tu mensaje: «${recortarMedio(filaCitada.respuesta_texto, 600)}»${filaCitada.texto_original ? ` (que era tu respuesta a: «${recortar(filaCitada.texto_original, 200)}»)` : ''}. Úsalo para entender a qué se refiere; los elementos de los que habla están en los pendientes.]\n`
  : '';
// Respondió al aviso que juntaba varios archivos: lo que pida vale para todos ellos
const notaArchivos = refsCitados.length > 1
  ? `[El usuario responde a tu aviso de ${refsCitados.length} archivos guardados juntos (${refsCitados.join(', ')}). Lo que pida vale para todos ellos.]\n`
  : '';
const notaAviso = avisoCitado.length > 0
  ? `[El usuario responde a tu aviso de: ${avisoCitado.map(describirCitado).join('; ')}. Si pide aplazarla, moverla o cambiarla, es un corregir de ${avisoCitado.length === 1 ? 'ese elemento' : 'uno de ellos'}.]\n`
  : '';

const sistema = PROMPT
  .split('{{fecha_actual}}').join(entrada.fecha_actual)
  .split('{{proyectos}}').join(proyectosActivos.length > 0 ? proyectosActivos.join(', ') : '(ninguno todavía)')
  .split('{{memoria}}').join(JSON.stringify(memoria))
  .split('{{horario}}').join(JSON.stringify(horarioPrompt))
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
      reciente,
      // Referencias cortas de archivos (a1, a2…) -> id real, y su nombre actual y fecha de recepción (para renombrarlos)
      refs_archivos: refsArchivos,
      // Los archivos a los que se refiere este mensaje (su pie, o la respuesta a su confirmación): "Planificar" los archiva por código si el mensaje es una ruta
      archivos_citados: refsCitados,
      archivos_info: infoArchivos,
      agenda,
      // Para "Planificar": la pregunta anterior que este mensaje cierra y el hilo que hay que acumular
      pendiente_id: pendiente?.id ?? null,
      // Las que se cierran por no contestarlas
      preguntas_ignoradas: preguntasIgnoradas,
      // Nombre de la secretaria: si falta se pregunta antes que nada; si se acaba de preguntar, la respuesta es el nombre
      pedir_nombre: pedirNombre,
      // El nombre actual (para /name y /about)
      nombre_secretaria: nombreSecretaria,
      memoria_filas: memoriaFilas,
      // El horario fijo (para avisar si una cita cae dentro y para /horario)
      horario,
      // Lo que quitó el usuario (para «deshaz», sección 63)
      quitados,
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
          { role: 'user', parts: [{ text: `${notaAviso}${notaArchivos}${notaCitada}${notaOferta}${entrada.mensaje}` }] },
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
