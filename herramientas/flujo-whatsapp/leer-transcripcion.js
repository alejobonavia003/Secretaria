// Nodo "Leer transcripción": interpreta la respuesta de Gemini y deja el audio como un mensaje de texto más.
//   transcrito  { ok: true, mensaje, wa_message_id, tipo_entrada: 'audio', contexto_id }   (sigue a "Procesar mensaje")
//   fallido     { ok: false, mensajes: [texto], motivo }                                    (sigue a "Preparar envío")
// El texto transcrito va al flujo principal exactamente igual que un mensaje escrito: mismas reglas, mismas confirmaciones.
// El flujo principal antepone «Entendí: …» a su respuesta para que se vea qué se oyó.

/*__COMUN__*/

const salida = [];
$input.all().forEach((item, i) => {
  const original = $('Comprobar audio').itemMatching(i).json;
  const t = leerTranscripcion(item.json);
  const json = t.ok
    ? { ok: true, mensaje: t.texto, wa_message_id: original.wa_message_id, tipo_entrada: 'audio', contexto_id: original.contexto_id || '' }
    : { ok: false, mensajes: [t.texto], motivo: t.motivo };
  salida.push({ json, pairedItem: { item: i } });
});

return salida;
