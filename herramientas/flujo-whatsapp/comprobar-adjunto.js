// Nodo "Comprobar adjunto": decide, con lo que ha devuelto Meta (GET /{media_id}), si el adjunto se guarda.
// Rechaza lo que no es de un dominio de Meta (el token de acceso se enviaría ahí), lo que pesa más del límite y los tipos
// no admitidos, y calcula el nombre del archivo. Un item de entrada, un item de salida.
//   aceptado  { ok: true, media_url, mime_type, nombre, tamano, wa_message_id, tipo_entrada, caption }
//   rechazado { ok: false, mensajes: [texto], motivo, responde_a }   (sigue directo a "Preparar envío")

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const ahora = DateTime.now().setZone('Europe/Madrid').toFormat('yyyy-MM-dd HHmm');

const salida = [];
$input.all().forEach((item, i) => {
  // La respuesta de Meta ha sustituido al item: lo que llegó en el webhook se recupera por posición
  const entrada = $('¿Es archivo?').itemMatching(i).json;
  const plan = planificarAdjunto({ entrada, metadatos: item.json, ahora, limiteMb: config.limite_adjunto_mb });
  const json = plan.ok
    ? { ...plan, wa_message_id: entrada.wa_message_id, tipo_entrada: entrada.tipo_entrada, caption: entrada.caption || '' }
    : { ok: false, mensajes: [plan.texto], motivo: plan.motivo, responde_a: entrada.wa_message_id ?? null };
  salida.push({ json, pairedItem: { item: i } });
});

return salida;
