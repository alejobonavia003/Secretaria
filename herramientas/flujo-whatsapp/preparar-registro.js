// Nodo "Preparar registro": tras subir el archivo a Drive, deja listas las dos filas de Supabase (mensajes y archivos).
// Si la subida falló (no hay descarga, Drive rechazó el archivo…) no se registra nada y se avisa con un mensaje honesto.
//   subido    { ok: true, nombre, tiene_pie, mensaje: {...}, archivo: {...} }
//   fallido   { ok: false, mensajes: [texto], responde_a }   (sigue directo a "Preparar envío")

/*__COMUN__*/

// --- Pegamento con n8n ---
const salida = [];
$input.all().forEach((item, i) => {
  // La respuesta de Drive ha sustituido al item: el plan (nombre, tipo, id del mensaje…) se recupera por posición
  const plan = $('Comprobar adjunto').itemMatching(i).json;
  const subida = item.json && !item.json.error ? item.json : null;
  const r = registroDeSubida({ plan, subida });
  salida.push({ json: r.ok ? r : { ok: false, mensajes: [r.texto], responde_a: plan.wa_message_id ?? null }, pairedItem: { item: i } });
});

return salida;
