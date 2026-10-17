// Nodo "Configuración" del flujo "Secretaria · Aviso de fallos": lo que se toca a mano está aquí.
// Los demás nodos leen estos valores con $('Configuración').first().json.config
// Los SECRETOS no están aquí: el número de destino se lee del entorno de n8n (WHATSAPP_NUMERO_PERMITIDO, definido en el .env)
// y el token de envío va en una credencial de n8n (Header Auth), no aquí.

// Los identificadores (no son secretos) se leen del .env del servidor, así se ponen UNA vez para todos los flujos.
// Si una variable no está en el .env, vale lo que esté escrito aquí abajo.
const delEntorno = (clave, porDefecto) => {
  try {
    return String($env[clave] ?? '').trim() || porDefecto;
  } catch (e) {
    return porDefecto;
  }
};

// === Valores fáciles de cambiar ===
// Identificador del número de WhatsApp desde el que se envía (WhatsApp > API Setup > Phone number ID). No es un secreto.
const PHONE_NUMBER_ID = delEntorno('WHATSAPP_PHONE_NUMBER_ID', 'TU-PHONE-NUMBER-ID');
// Versión de la API Graph de Meta (la misma que en el flujo "Secretaria · WhatsApp")
const GRAPH_VERSION = 'v26.0';
// Un fallo que se repite cada minuto (Calendar o Drive caídos) no debe mandarte un mensaje por minuto:
// como mucho un aviso por flujo cada ENFRIAMIENTO_MIN minutos y MAX_AVISOS_DIA en total al día.
const ENFRIAMIENTO_MIN = 60;
const MAX_AVISOS_DIA = 10;
// ==================================

if (!/^\d{8,20}$/.test(PHONE_NUMBER_ID)) {
  throw new Error('Configuración: pon el Phone number ID de WhatsApp en PHONE_NUMBER_ID (solo dígitos). Va en el .env del servidor (WHATSAPP_PHONE_NUMBER_ID=…, y después docker compose up -d)');
}
if (!/^v\d+\.\d+$/.test(GRAPH_VERSION)) {
  throw new Error('Configuración: GRAPH_VERSION debe tener la forma v26.0');
}
if (!Number.isFinite(ENFRIAMIENTO_MIN) || ENFRIAMIENTO_MIN < 1 || ENFRIAMIENTO_MIN > 1440) {
  throw new Error('Configuración: ENFRIAMIENTO_MIN debe estar entre 1 y 1440');
}
if (!Number.isInteger(MAX_AVISOS_DIA) || MAX_AVISOS_DIA < 1 || MAX_AVISOS_DIA > 100) {
  throw new Error('Configuración: MAX_AVISOS_DIA debe estar entre 1 y 100');
}

return [
  {
    json: {
      config: {
        phone_number_id: PHONE_NUMBER_ID,
        graph_version: GRAPH_VERSION,
        enfriamiento_min: ENFRIAMIENTO_MIN,
        max_avisos_dia: MAX_AVISOS_DIA,
      },
    },
  },
];
