// Nodo "Configuración" del flujo "Secretaria · Vigilar Calendar": lo que se toca a mano está aquí.
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
// ID del calendario "Secretaria" (el mismo CALENDAR_ID del flujo "Sincronizar Calendar"; termina en @group.calendar.google.com)
const CALENDAR_ID = delEntorno('GOOGLE_CALENDAR_ID', 'TU-CALENDARIO@group.calendar.google.com');
// Horas desde el último mensaje tuyo durante las que Meta admite texto libre (Meta admite 24 h: margen para no rozar el límite).
// Fuera de ese plazo NO se envía nada (sin plantillas): los cambios quedan anotados y se avisan cuando vuelvas a escribir.
const VENTANA_HORAS = 23;
// Duración que se supone a un evento sin hora de fin (la misma que usa «Sincronizar Calendar»)
const DURACION_MIN = 60;
// Minutos que se retrocede respecto a la última pasada al preguntar a Google qué cambió (cubre el retraso entre la lectura y el guardado)
const MARGEN_MIN = 5;
// Líneas máximas de un aviso (lo que sobre se avisa en la pasada siguiente)
const MAX_LINEAS = 15;
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
if (!/^[^@\s/]+@[^@\s/]+$/.test(CALENDAR_ID) || CALENDAR_ID.includes('TU-CALENDARIO')) {
  throw new Error('Configuración: pon el ID del calendario "Secretaria" en CALENDAR_ID (termina en @group.calendar.google.com). Va en el .env del servidor (GOOGLE_CALENDAR_ID=…, y después docker compose up -d)');
}
if (!Number.isFinite(VENTANA_HORAS) || VENTANA_HORAS < 1 || VENTANA_HORAS > 24) {
  throw new Error('Configuración: VENTANA_HORAS debe estar entre 1 y 24');
}
if (!Number.isInteger(DURACION_MIN) || DURACION_MIN < 1 || DURACION_MIN > 1440) {
  throw new Error('Configuración: DURACION_MIN debe estar entre 1 y 1440');
}
if (!Number.isInteger(MARGEN_MIN) || MARGEN_MIN < 0 || MARGEN_MIN > 120) {
  throw new Error('Configuración: MARGEN_MIN debe estar entre 0 y 120');
}
if (!Number.isInteger(MAX_LINEAS) || MAX_LINEAS < 1 || MAX_LINEAS > 40) {
  throw new Error('Configuración: MAX_LINEAS debe estar entre 1 y 40');
}

return [
  {
    json: {
      config: {
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        phone_number_id: PHONE_NUMBER_ID,
        graph_version: GRAPH_VERSION,
        calendar_id: CALENDAR_ID,
        ventana_horas: VENTANA_HORAS,
        duracion_min: DURACION_MIN,
        margen_min: MARGEN_MIN,
        max_lineas: MAX_LINEAS,
      },
    },
  },
];
