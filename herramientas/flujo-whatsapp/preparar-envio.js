// Nodo "Preparar envío": un item por mensaje de WhatsApp que hay que mandar, siempre al número permitido.
// Llega por dos ramas:
//   - lo que devuelve el flujo principal (campo "mensajes", un elemento por mensaje; ya partidos a menos de 3.800 caracteres)
//   - un tipo de mensaje que todavía no se entiende (imagen, audio…): respuesta honesta, sin pasar por el modelo
// Si el flujo principal falló y no devolvió "mensajes", se avisa en lugar de callar.
// Si el flujo principal dice "agrupado" (no se usa desde que la cola vive en este flujo, pero se respeta), no se contesta nada.

/*__COMUN__*/

// --- Pegamento con n8n ---
const para = soloDigitos($env.WHATSAPP_NUMERO_PERMITIDO);
if (!para) throw new Error('Preparar envío: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const LIMITE_WHATSAPP = 4096; // caracteres por mensaje de texto en la API de Meta

// El texto que se procesó en esta ejecución, para decir cuál falló. Se busca el mensaje de esta ejecución (emparejado por posición con el item
// que entró en «Procesar mensaje»); si no se puede, y solo hay uno, ese. Sin texto, el mensaje genérico.
function textoDeEsteMensaje(i) {
  try {
    const t = $('Juntar mensajes').itemMatching(i)?.json?.mensaje;
    if (typeof t === 'string' && t.trim() !== '') return t;
  } catch (e) {
    // sin emparejamiento
  }
  try {
    const todos = $('Juntar mensajes').all().map((x) => x.json).filter((j) => j && j.accion === 'procesar' && typeof j.mensaje === 'string');
    if (todos.length === 1) return todos[0].mensaje;
  } catch (e) {
    // este camino no pasó por la cola
  }
  return '';
}

// El mensaje del usuario al que se contesta, por si hay que citarlo: lo trae el item (ramas de audio, archivos y avisos) o, si viene del
// flujo principal, «Juntar mensajes» (el primero del grupo). «varios»: la respuesta es de varios mensajes juntos o de uno que llegó
// mientras se contestaba otro. Si se cita o no lo decide «Turno de respuesta».
// «contesta»: todos los mensajes del usuario que contesta esta respuesta (se marcan como contestados al mandarla); «de_cola»:
// viene de la cola de texto, que ya va en orden (no espera turno de respuesta).
function citaDe(i, r) {
  const solo = (id) => ({ id, varios: false, contesta: id ? [id] : [], de_cola: false });
  // Las ramas de audio, archivos y rechazos siempre traen «responde_a» (aunque sea nulo): nunca toman los mensajes de la cola
  if ('responde_a' in r) return solo(idCitable(r.responde_a));
  if (r.tipo_entrada === 'no_soportado') return solo(idCitable(r.wa_message_id));
  const deJuntar = (j) => ({
    id: idCitable(j.responde_a ?? j.wa_message_id),
    varios: Number(j.juntados) > 1 || j.espero_turno === true,
    contesta: (Array.isArray(j.wa_ids) ? j.wa_ids : [j.wa_message_id]).filter((w) => idCitable(w)),
    de_cola: true,
  });
  try {
    const j = $('Juntar mensajes').itemMatching(i)?.json;
    if (j && idCitable(j.responde_a ?? j.wa_message_id)) return deJuntar(j);
  } catch (e) {
    // sin emparejamiento
  }
  try {
    // Sin emparejamiento: la única salida «procesar» de esta ejecución (solo puede haber una: el último mensaje se lleva los demás). Si hubiera
    // varias, se marcan todos sus mensajes como contestados (mejor que dejar alguno haciendo esperar a los demás) y no se cita.
    const todos = $('Juntar mensajes').all().map((x) => x.json).filter((j) => j && j.accion === 'procesar');
    if (todos.length === 1) return deJuntar(todos[0]);
    if (todos.length > 1) return { id: null, varios: false, contesta: todos.flatMap((j) => deJuntar(j).contesta), de_cola: true };
  } catch (e) {
    // este camino no pasó por la cola
  }
  return { id: null, varios: false, contesta: [], de_cola: false };
}

const ahora = Date.now();
const envios = [];
for (const [i, item] of $input.all().entries()) {
  const r = item.json || {};
  if (r.agrupado === true && r.ok === true) continue;
  let textos;
  if (r.tipo_entrada === 'no_soportado') {
    textos = [MENSAJE_NO_SOPORTADO(r.tipo, r.cantidad)];
  } else if (Array.isArray(r.mensajes) && r.mensajes.some((t) => typeof t === 'string' && t.trim() !== '')) {
    textos = r.mensajes.filter((t) => typeof t === 'string' && t.trim() !== '');
  } else {
    textos = [mensajeFalloCanal(textoDeEsteMensaje(i))];
  }
  // Si el mensaje es la confirmación de un archivo recién guardado, el primer texto lleva el id de ese archivo en Drive:
  // "Anotar confirmación" lo usa para guardar el id del mensaje enviado (así el usuario puede clasificarlo respondiéndolo)
  const archivo = typeof r.archivo_drive_id === 'string' && r.archivo_drive_id !== '' ? r.archivo_drive_id : null;
  // Solo el primer mensaje de la respuesta puede citar al usuario: los siguientes (una lista larga partida, una pregunta) van justo debajo
  const cita = citaDe(i, r);
  textos.forEach((t, n) =>
    envios.push({
      json: {
        para,
        texto: t.slice(0, LIMITE_WHATSAPP),
        ...(archivo && n === 0 ? { archivo_drive_id: archivo } : {}),
        ...(cita.id && n === 0 ? { responde_a: cita.id, varios_mensajes: cita.varios } : {}),
        // «desde»: cuándo empezó a esperar su turno de respuesta (el tope de espera es TURNO_MIN)
        ...(n === 0 ? { contesta: cita.contesta, de_cola: cita.de_cola, desde: ahora } : {}),
        // Los archivos que pidió el usuario: se mandan después de este texto y antes de soltar el turno
        ...(n === 0 && Array.isArray(r.envios_archivos) && r.envios_archivos.length > 0 ? { envios_archivos: r.envios_archivos } : {}),
      },
    }),
  );
}

return envios;
