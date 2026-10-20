// Nodo "Juntar mensajes": interpreta lo que devolvió reclamar_mensajes, un item por mensaje en cola de esta ejecución.
//   - "procesar": esta ejecución tiene el turno y se ha llevado los mensajes en cola (el suyo, el último). Los junta en UN texto, uno por
//                 línea, y devuelve lo que espera "Procesar mensaje": mensaje, wa_message_id, tipo_entrada y contexto_id (+ mensaje_id).
//   - "esperar":  otra ejecución está procesando o mandando su respuesta. Se devuelve el id para volver a reclamar tras "Esperar turno".
//                 Si lleva más vueltas que lo que tarda en caducar el turno, se detiene con un error (algo va mal).
//   - "nada":     llegaron mensajes después de este (la ejecución del último los junta) o ya los reclamó otra: no se devuelve nada.
// El turno se suelta DESPUÉS de mandar la respuesta ("Liberar turno"): así la respuesta de un mensaje nunca llega después de la del
// siguiente.

/*__COMUN__*/

const config = $('Configuración').first().json.config;
const vuelta = typeof $runIndex === 'number' ? $runIndex : 0;

// Id del mensaje que se reclamó en el item i: en la primera pasada viene de "Esperar a más mensajes" (las filas de "En cola"); en las
// siguientes, de "Esperar turno" (que lleva mensaje_id). Se busca por el emparejamiento de items de n8n y, si no se puede, con la
// única fila en cola de esta ejecución (el caso normal: un mensaje por notificación de Meta).
function idDelItem(i) {
  // En la primera ejecución de este nodo el item viene seguro de "Esperar a más mensajes": no se mira "Esperar turno"
  if (vuelta > 0) {
    try {
      const t = $('Esperar turno').itemMatching(i)?.json;
      if (t && typeof t.mensaje_id === 'string') return t.mensaje_id;
    } catch (e) {
      // este item no viene de "Esperar turno"
    }
  }
  try {
    const f = $('Esperar a más mensajes').itemMatching(i)?.json;
    if (f && typeof f.id === 'string') return f.id;
  } catch (e) {
    // sin emparejamiento
  }
  const filas = $('En cola').all().map((x) => x.json).filter((r) => r && typeof r.id === 'string');
  if (filas.length === 1) return filas[0].id;
  throw new Error('Juntar mensajes: no se pudo saber qué mensaje se reclamó');
}

const VALIDO = /^[A-Za-z0-9._=+\/-]{1,300}$/;
const salida = [];
$input.all().forEach((item, i) => {
  const r = item.json ?? {};
  if (!['procesar', 'esperar', 'nada'].includes(r.accion)) {
    throw new Error(`Juntar mensajes: respuesta inesperada de reclamar_mensajes (¿está instalada la base de datos? supabase/instalar.sql): ${JSON.stringify(r).slice(0, 300)}`);
  }
  if (r.accion === 'nada') return;
  if (r.accion === 'esperar') {
    if (vuelta + 1 >= config.max_esperas_turno) {
      throw new Error(`Juntar mensajes: otra ejecución tiene el turno desde hace más de ${config.max_esperas_turno} esperas; el mensaje sigue en la cola`);
    }
    salida.push({ json: { accion: 'esperar', mensaje_id: idDelItem(i), vuelta }, pairedItem: { item: i } });
    return;
  }
  const mensajes = (Array.isArray(r.mensajes) ? r.mensajes : []).filter((m) => m && typeof m.id === 'string');
  const propio = mensajes.at(-1); // reclamar_mensajes los devuelve en orden de llegada: el de esta ejecución es el último
  if (!propio || typeof propio.wa_message_id !== 'string') throw new Error('Juntar mensajes: reclamar_mensajes no devolvió el mensaje de esta ejecución');
  const textos = mensajes.map((m) => (typeof m.texto === 'string' ? m.texto.trim() : '')).filter(Boolean);
  if (textos.length === 0) throw new Error('Juntar mensajes: los mensajes reclamados no tienen texto');
  // Si alguno respondía a una foto o a una confirmación, vale el último que lo hacía
  const citas = mensajes.map((m) => m.contexto_wa_id).filter((c) => typeof c === 'string' && VALIDO.test(c));
  salida.push({
    json: {
      accion: 'procesar',
      mensaje: textos.join('\n'),
      wa_message_id: propio.wa_message_id,
      tipo_entrada: propio.tipo_entrada === 'audio' ? 'audio' : 'texto',
      contexto_id: citas.at(-1) ?? '',
      mensaje_id: propio.id,
      // La respuesta cita el PRIMER mensaje del grupo (WhatsApp solo deja citar uno): contesta a todos los que van desde ese
      // Tuvo que esperar a que otra ejecución contestara: el usuario mandó este mientras se procesaba otro (varios mensajes)
      espero_turno: vuelta > 0,
      // Cuándo llegó el primero del grupo: el flujo principal sabe así si el usuario ya había visto una pregunta abierta
      recibido_at: typeof mensajes[0]?.created_at === 'string' ? mensajes[0].created_at : null,
      // Todos los mensajes que contesta esta respuesta (se marcan como contestados al mandarla)
      wa_ids: mensajes.map((m) => m.wa_message_id).filter((w) => typeof w === 'string' && VALIDO.test(w)),
      // Lo entendido de cada audio del grupo, para el «🎙️ Entendí» (sale justo antes de procesar, en su turno)
      ecos: mensajes.length > MAX_MENSAJES_DE_GOLPE ? [] : mensajes.filter((m) => m.tipo_entrada === 'audio' && typeof m.texto === 'string' && m.texto.trim() !== '').map((m) => m.texto),
      responde_a: mensajes.map((m) => m.wa_message_id).find((w) => typeof w === 'string' && VALIDO.test(w)) ?? propio.wa_message_id,
      juntados: mensajes.length,
      // Demasiados seguidos (p. ej. se reenvió medio chat): el flujo principal no los procesa y lo avisa con este texto
      demasiados: mensajes.length > MAX_MENSAJES_DE_GOLPE,
      aviso_demasiados: mensajes.length > MAX_MENSAJES_DE_GOLPE ? MENSAJE_EXCESO_COLA(mensajes.length) : '',
    },
    pairedItem: { item: i },
  });
});
return salida;
