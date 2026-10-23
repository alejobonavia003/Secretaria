// Nodo "Leer transcripción": interpreta la respuesta de Gemini y deja el audio como un mensaje de texto más.
//   transcrito  { ok: true, mensaje, wa_message_id, tipo_entrada: 'audio', contexto_id }   (sigue a "Procesar mensaje")
//   fallido     { ok: false, mensajes: [texto], motivo, responde_a }                                (sigue a "Preparar envío")
// El texto transcrito va al flujo principal exactamente igual que un mensaje escrito: mismas reglas, mismas confirmaciones.
// No se repite lo transcrito : la respuesta del flujo principal es lo único que se manda.

/*__COMUN__*/

const salida = [];
$input.all().forEach((item, i) => {
  const original = $('Comprobar audio').itemMatching(i).json;
  const t = leerTranscripcion(item.json);
  const json = t.ok
    ? { ok: true, mensaje: t.texto, wa_message_id: original.wa_message_id, tipo_entrada: 'audio', contexto_id: original.contexto_id || '' }
    : { ok: false, mensajes: [t.texto], motivo: t.motivo, responde_a: original.wa_message_id ?? null };
  salida.push({ json, pairedItem: { item: i } });
});

return salida;
