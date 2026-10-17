// Nodo "Configuración" del flujo "Secretaria · Recordatorios": lo que se toca a mano está aquí.
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
// Cuándo avisar, en minutos ANTES de la hora del recordatorio: 1 hora antes, 30 minutos antes y a la hora (0).
// Si cambias esta lista, cambia también AVISOS_RECORDATORIO_MIN en herramientas/flujo/resultado.js (lo que la confirmación promete).
const AVISOS_MIN = [60, 30, 0];
// Horas desde el último mensaje tuyo durante las que Meta admite texto libre. Fuera de ese plazo NO se envía nada y el aviso espera:
// en cuanto vuelvas a escribir, sale (como «atrasado» si la hora ya pasó).
const VENTANA_HORAS = 23;
// Si el aviso «a la hora» sale con más minutos de retraso que estos, se dice que es un recordatorio atrasado
const MARGEN_ATRASADO_MIN = 15;
// Recordatorios que se anuncian como máximo en un solo mensaje
const MAX_POR_MENSAJE = 10;
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
if (!Array.isArray(AVISOS_MIN) || AVISOS_MIN.length === 0 || !AVISOS_MIN.every((m) => Number.isInteger(m) && m >= 0 && m <= 1440) || !AVISOS_MIN.includes(0) || new Set(AVISOS_MIN).size !== AVISOS_MIN.length) {
  throw new Error('Configuración: AVISOS_MIN debe ser una lista de minutos distintos, entre 0 y 1440, que incluya el 0 (el aviso «a la hora»)');
}
if (!Number.isFinite(VENTANA_HORAS) || VENTANA_HORAS < 1 || VENTANA_HORAS > 24) {
  throw new Error('Configuración: VENTANA_HORAS debe estar entre 1 y 24');
}
if (!Number.isInteger(MARGEN_ATRASADO_MIN) || MARGEN_ATRASADO_MIN < 1 || MARGEN_ATRASADO_MIN > 720) {
  throw new Error('Configuración: MARGEN_ATRASADO_MIN debe estar entre 1 y 720');
}
if (!Number.isInteger(MAX_POR_MENSAJE) || MAX_POR_MENSAJE < 1 || MAX_POR_MENSAJE > 50) {
  throw new Error('Configuración: MAX_POR_MENSAJE debe estar entre 1 y 50');
}

return [
  {
    json: {
      config: {
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        phone_number_id: PHONE_NUMBER_ID,
        graph_version: GRAPH_VERSION,
        avisos_min: [...AVISOS_MIN].sort((a, b) => b - a),
        ventana_horas: VENTANA_HORAS,
        margen_atrasado_min: MARGEN_ATRASADO_MIN,
        max_por_mensaje: MAX_POR_MENSAJE,
      },
    },
  },
];
