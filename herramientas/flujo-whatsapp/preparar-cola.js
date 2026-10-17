// Nodo "Preparar cola": cada mensaje de texto (o audio ya transcrito) se mete en la cola de la base de datos antes de
// procesarlo. Devuelve la fila que guarda "Guardar en cola": en_cola = true, el texto y, si el usuario respondió a una foto o a una
// confirmación, el id de ese mensaje (contexto_wa_id). La fila sirve además para descartar los reenvíos de Meta (wa_message_id es único).

const VALIDO = /^[A-Za-z0-9._=+\/-]{1,300}$/;
return $input
  .all()
  .map((x) => x.json)
  .filter((m) => m && typeof m.mensaje === 'string' && m.mensaje.trim() !== '' && typeof m.wa_message_id === 'string' && VALIDO.test(m.wa_message_id))
  .map((m) => ({
    json: {
      wa_message_id: m.wa_message_id,
      tipo_entrada: m.tipo_entrada === 'audio' ? 'audio' : 'texto',
      texto_original: m.mensaje.trim(),
      contexto_wa_id: typeof m.contexto_id === 'string' && VALIDO.test(m.contexto_id) ? m.contexto_id : null,
      en_cola: true,
    },
  }));
