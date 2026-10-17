// Nodo "Mensaje de eco": con lo que se entendió de cada audio construye el mensaje «🎙️ Entendí: «…»». Se manda en cuanto el audio transcrito
// entra en la cola (después de «En cola», que descarta los reenvíos de Meta) y ANTES de procesar nada: así es lo primero que llega a WhatsApp
// y no sale repetido si Meta entrega el mismo audio dos veces. Un item de entrada, uno de salida: { cuerpo }.

/*__COMUN__*/

// --- Pegamento con n8n ---
const para = soloDigitos($env.WHATSAPP_NUMERO_PERMITIDO);
if (!para) throw new Error('Mensaje de eco: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

return $input.all().map((item, i) => ({ json: { cuerpo: cuerpoEco({ para, texto: item.json.texto_original ?? item.json.mensaje }) }, pairedItem: { item: i } }));
