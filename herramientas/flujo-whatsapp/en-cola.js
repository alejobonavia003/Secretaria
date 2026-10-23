// Nodo "En cola": deja pasar solo los mensajes que de verdad entraron en la cola (la respuesta de "Guardar en cola" trae su id). Un
// reenvío de Meta que se coló entre la comprobación de duplicados y el guardado choca con wa_message_id (único) y se descarta aquí sin
// contestar: el mensaje original ya se está atendiendo.
return $input
  .all()
  .map((x) => x.json)
  .filter((r) => r && typeof r.id === 'string' && typeof r.wa_message_id === 'string')
  // tipo_entrada y texto_original: se conservan por si hacen falta aguas abajo (ya no hay eco de los audios)
  .map((r) => ({ json: { id: r.id, wa_message_id: r.wa_message_id, tipo_entrada: r.tipo_entrada, texto_original: r.texto_original } }));
