// Nodo "Resultado archivo": el texto que se le contesta al usuario cuando acaba de guardar un archivo.
// Llega la respuesta de Supabase al insertar en `archivos`: si trae la fila (drive_file_id) todo fue bien; si no, el archivo
// está en Drive pero no consta en la base de datos, y se dice tal cual.

/*__COMUN__*/

// --- Pegamento con n8n ---
const salida = [];
$input.all().forEach((item, i) => {
  const preparado = $('¿Subido?').itemMatching(i).json;
  const registrado = item.json && typeof item.json.drive_file_id === 'string';
  const texto = registrado ? MENSAJE_ARCHIVO_GUARDADO(preparado.nombre, preparado.tiene_pie) : MENSAJE_ARCHIVO_SIN_REGISTRO;
  // Con el id del archivo, "Preparar envío" lo asocia al mensaje de confirmación que se envía
  const json = { mensajes: [texto], responde_a: preparado.mensaje?.wa_message_id ?? null, ...(registrado ? { archivo_drive_id: item.json.drive_file_id } : {}) };
  salida.push({ json, pairedItem: { item: i } });
});

return salida;
