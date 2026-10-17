// Nodo "Mensaje de cabecera": convierte un item "cabecera" (nombre de la carpeta y número de archivos) en el mensaje de texto que
// se manda antes de sus archivos, con el nombre en negrita: *Fotos/Viajes* (3). Un item de entrada, uno de salida: { cuerpo }.
// Dentro del bucle "Recorrer envíos" cada iteración debe devolver SIEMPRE un item, o el bucle se corta.

/*__COMUN__*/

// --- Pegamento con n8n ---
const para = soloDigitos($env.WHATSAPP_NUMERO_PERMITIDO);
if (!para) throw new Error('Mensaje de cabecera: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

return $input.all().map((item, i) => ({
  json: { cuerpo: cuerpoCabeceraCarpeta({ para, ruta: item.json.ruta, total: item.json.total }) },
  pairedItem: { item: i },
}));
