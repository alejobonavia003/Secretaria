// Nodo "Comprobar audio": decide, con lo que ha devuelto Meta (GET /{media_id}), si el audio se descarga y transcribe.
// Rechaza lo que no es de un dominio de Meta (el token de acceso se enviaría ahí), lo que pesa más del límite y los formatos que
// Gemini no entiende. Un item de entrada, un item de salida.
//   aceptado  { ok: true, media_url, mime_type, tamano, wa_message_id, contexto_id }
//   rechazado { ok: false, mensajes: [texto], motivo, responde_a }   (sigue directo a "Preparar envío")

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;

const salida = [];
$input.all().forEach((item, i) => {
  // La respuesta de Meta ha sustituido al item: lo que llegó en el webhook se recupera por posición
  const entrada = $('¿Es audio?').itemMatching(i).json;
  const plan = planificarAudio({ entrada, metadatos: item.json, limiteMb: config.limite_audio_mb });
  const json = plan.ok
    ? { ...plan, wa_message_id: entrada.wa_message_id, contexto_id: entrada.contexto_id || '' }
    : { ok: false, mensajes: [plan.texto], motivo: plan.motivo, responde_a: entrada.wa_message_id ?? null };
  salida.push({ json, pairedItem: { item: i } });
});

return salida;
