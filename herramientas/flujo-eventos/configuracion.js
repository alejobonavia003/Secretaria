// Nodo "Configuración" del flujo "Secretaria · Avisos de eventos": lo que se toca a mano está aquí.
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
// Project URL de Supabase (Integrations > Data API), sin /rest/v1 al final. No es un secreto.
const SUPABASE_URL = delEntorno('SUPABASE_URL', 'https://TU-PROYECTO.supabase.co');
// Identificador del número de WhatsApp desde el que se envía (WhatsApp > API Setup > Phone number ID). No es un secreto.
const PHONE_NUMBER_ID = delEntorno('WHATSAPP_PHONE_NUMBER_ID', 'TU-PHONE-NUMBER-ID');
// Versión de la API Graph de Meta (la misma que en el flujo "Secretaria · WhatsApp")
const GRAPH_VERSION = 'v26.0';
// Horas desde el último mensaje tuyo durante las que Meta admite texto libre. Meta admite 24 h: margen para no rozar el límite.
// Fuera de ese plazo NO se envía nada (no hay plantilla de aviso de evento): el aviso queda sin enviar hasta que el evento empiece.
const VENTANA_HORAS = 23;
// Máximo de avisos por pasada (cada minuto). Más de los que caben en un mensaje se agrupan; el resto sale en la pasada siguiente.
const MAX_AVISOS = 10;
// ==================================

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL) || SUPABASE_URL.includes('TU-PROYECTO')) {
  throw new Error('Configuración: pon tu Project URL de Supabase en SUPABASE_URL (https://<ref>.supabase.co, sin /rest/v1). Va en el .env del servidor (SUPABASE_URL=…, y después docker compose up -d)');
}
if (!/^\d{8,20}$/.test(PHONE_NUMBER_ID)) {
  throw new Error('Configuración: pon el Phone number ID de WhatsApp en PHONE_NUMBER_ID (solo dígitos). Va en el .env del servidor (WHATSAPP_PHONE_NUMBER_ID=…, y después docker compose up -d)');
}
if (!/^v\d+\.\d+$/.test(GRAPH_VERSION)) {
  throw new Error('Configuración: GRAPH_VERSION debe tener la forma v26.0');
}
if (!Number.isFinite(VENTANA_HORAS) || VENTANA_HORAS < 1 || VENTANA_HORAS > 24) {
  throw new Error('Configuración: VENTANA_HORAS debe estar entre 1 y 24');
}
if (!Number.isInteger(MAX_AVISOS) || MAX_AVISOS < 1 || MAX_AVISOS > 50) {
  throw new Error('Configuración: MAX_AVISOS debe estar entre 1 y 50');
}

return [
  {
    json: {
      config: {
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        phone_number_id: PHONE_NUMBER_ID,
        graph_version: GRAPH_VERSION,
        ventana_horas: VENTANA_HORAS,
        max_avisos: MAX_AVISOS,
      },
    },
  },
];
