// Nodo "Mensaje de eco": con lo que se entendió de cada audio construye el mensaje «🎙️ Entendí: «…»». Sale cuando al audio le toca su
// turno (al reclamarlo, justo antes de procesarlo): así respeta el orden de llegada y sale una sola vez aunque Meta entregue
// el mismo audio dos veces. Entra lo que devolvió «Juntar mensajes» (campo «ecos», uno por audio del grupo); sale un { cuerpo } por audio.
// Sin audios no devuelve nada (la rama termina aquí). No cita el audio: sale justo antes de su respuesta.

/*__COMUN__*/

// --- Pegamento con n8n ---
const para = soloDigitos($env.WHATSAPP_NUMERO_PERMITIDO);
if (!para) throw new Error('Mensaje de eco: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const salida = [];
$input.all().forEach((item, i) => {
  const ecos = Array.isArray(item.json?.ecos) ? item.json.ecos : [];
  for (const texto of ecos) salida.push({ json: { cuerpo: cuerpoEco({ para, texto }) }, pairedItem: { item: i } });
});
return salida;
