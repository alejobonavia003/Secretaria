// Nodo "Verificar": primera línea de defensa del webhook público.
//   GET  -> saludo de Meta (hub.challenge) si el verify token coincide.
//   POST -> firma X-Hub-Signature-256 sobre los bytes exactos del cuerpo, remitente permitido y extracción de mensajes.
// Siempre devuelve UN solo item { accion, codigo, cuerpo, mensajes, motivo }; el nodo "Responder" contesta con él.
// Los secretos se leen del entorno de n8n (.env del usuario): WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN,
// WHATSAPP_NUMERO_PERMITIDO. Nada de eso se registra ni se devuelve.

/*__COMUN__*/

// --- Pegamento con n8n ---
// Hay dos disparadores (GET para el saludo de Meta, POST para las notificaciones): solo ha corrido uno.
// Pedir los datos de un nodo que no se ejecutó lanza un error, de ahí el try/catch.
let entrada = null;
for (const nombre of ['Webhook POST', 'Webhook GET']) {
  try {
    entrada = $(nombre).first();
  } catch (e) {
    entrada = null;
  }
  if (entrada) break;
}
if (!entrada) throw new Error('Verificar: no hay datos de ningún Webhook (ni GET ni POST)');
const peticion = entrada.json || {};
const cabeceras = peticion.headers || {};
// Node convierte los nombres de cabecera a minúsculas
const metodo = peticion.query && typeof peticion.query['hub.mode'] === 'string' ? 'GET' : (entrada.binary ? 'POST' : 'GET');

let decision;
if (metodo === 'GET') {
  decision = { ...resolverSaludo(peticion.query, $env.WHATSAPP_VERIFY_TOKEN), mensajes: [] };
} else {
  // Con la opción Raw Body, n8n deja el cuerpo exacto como binario en la propiedad "data"
  let cuerpoBytes = null;
  const binario = entrada.binary && entrada.binary.data;
  if (binario) {
    if (binario.id) {
      // Modo de almacenamiento de binarios en disco: hay que pedirlo al ayudante de n8n
      cuerpoBytes = await this.helpers.getBinaryDataBuffer(0, 'data');
    } else if (typeof binario.data === 'string') {
      cuerpoBytes = Buffer.from(binario.data, 'base64');
    }
  }
  decision = resolverNotificacion({
    cuerpoBytes,
    cabeceraFirma: cabeceras['x-hub-signature-256'],
    secreto: $env.WHATSAPP_APP_SECRET,
    numeroPermitido: $env.WHATSAPP_NUMERO_PERMITIDO,
  });
}

return [{ json: decision }];
