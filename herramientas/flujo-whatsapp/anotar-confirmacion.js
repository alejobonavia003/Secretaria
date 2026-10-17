// Nodo "Anotar confirmación": tras enviar un mensaje de WhatsApp, si era la confirmación de un archivo recién guardado,
// prepara la escritura del id del mensaje enviado (messages[0].id de la respuesta de Meta) en la fila del archivo.
// Con ese id, cuando el usuario responda a la confirmación, el webhook trae el mismo id en "context.id" y se sabe de qué
// archivo habla.
// Está dentro del bucle "Recorrer mensajes" (se envía un mensaje cada vez y en orden): por eso devuelve SIEMPRE un item por cada
// uno de entrada, con "guardar" a verdadero solo si hay un id que anotar, y con "envio_error" si el envío falló.
//   guardar  { guardar: true, envio_error, url, cuerpo }
//   resto    { guardar: false, envio_error }

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const idValido = (s) => typeof s === 'string' && /^[A-Za-z0-9._=+\/-]{1,300}$/.test(s);
const resumen = (e) =>
  String(typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e ?? '')))
    .replace(/\s+/g, ' ')
    .slice(0, 200);

return $input.all().map((item, i) => {
  // La respuesta de Meta ha sustituido al item: lo que se envió se recupera del bucle por posición
  const envio = $('Recorrer mensajes').itemMatching(i).json;
  const wamid = item.json?.messages?.[0]?.id;
  const envio_error = item.json?.error ? resumen(item.json.error) : null;
  const esConfirmacion = typeof envio.archivo_drive_id === 'string' && envio.archivo_drive_id !== '';
  // Si el envío falló o Meta no devolvió el id, el archivo se clasifica igualmente, sin responder a la confirmación
  if (!esConfirmacion || !idValido(wamid)) return { json: { guardar: false, envio_error }, pairedItem: { item: i } };
  return {
    json: {
      guardar: true,
      envio_error,
      url: `${config.supabase_url}/rest/v1/archivos?drive_file_id=eq.${encodeURIComponent(envio.archivo_drive_id)}`,
      cuerpo: { respuesta_wa_id: wamid },
    },
    pairedItem: { item: i },
  };
});
