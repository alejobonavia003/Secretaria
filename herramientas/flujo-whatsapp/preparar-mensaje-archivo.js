// Nodo "Preparar mensaje de archivo": tras subir el archivo a Meta, construye el mensaje que lo manda (imagen o documento con el
// media id que devolvió Meta). Si la subida falló (o no devolvió id), se manda el enlace de Drive en vez del archivo: el usuario
// nunca se queda sin respuesta. Un item de entrada, uno de salida SIEMPRE: { cuerpo }.

/*__COMUN__*/

// --- Pegamento con n8n ---
const para = soloDigitos($env.WHATSAPP_NUMERO_PERMITIDO);
if (!para) throw new Error('Preparar mensaje de archivo: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

return $input.all().map((item, i) => {
  // La respuesta de Meta ha sustituido al item: lo que decidió "Decidir envío de archivo" se recupera por posición
  const plan = $('Decidir envío de archivo').itemMatching(i).json;
  const mediaId = typeof item.json?.id === 'string' && /^[0-9A-Za-z_-]{1,100}$/.test(item.json.id) ? item.json.id : '';
  const cuerpo = mediaId
    ? cuerpoArchivoSubido({ para, categoria: plan.categoria, mediaId, nombre: plan.nombre })
    : cuerpoEnlaceArchivo({ para, id: plan.id, nombre: plan.nombre, razon: 'WhatsApp no ha aceptado el archivo' });
  return { json: { cuerpo }, pairedItem: { item: i } };
});
