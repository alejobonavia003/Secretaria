// Nodo "Configuración" del flujo "Secretaria · Latido": lo que se toca a mano está aquí.
// Los demás nodos leen estos valores con $('Configuración').first().json.config
// Los SECRETOS no están aquí: el número de destino y la dirección del monitor externo se leen del entorno de n8n
// (WHATSAPP_NUMERO_PERMITIDO y HEALTHCHECK_URL_N8N, definidos en el .env) y el token de envío va en una credencial de n8n (Header Auth).

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
// Horas desde el último mensaje tuyo durante las que Meta admite texto libre (Meta admite 24 h: margen para no rozar el límite).
// Fuera de ese plazo NO se envía nada (sin plantillas): el monitor externo sí recibe el aviso, WhatsApp no.
const VENTANA_HORAS = 23;
// Mientras el mismo problema siga ahí, se repite el aviso por WhatsApp cada tantas horas (el monitor externo avisa a su manera)
const ALERTA_CADA_HORAS = 6;
// Si el problema CAMBIA (aparece otro), se avisa de nuevo, pero nunca antes de tantos minutos desde el último aviso (evita avisos en ráfaga)
const ALERTA_MIN_MINUTOS = 30;
// Diferencia máxima, en minutos, entre el reloj del servidor y el de la base de datos antes de considerarlo un problema
const DESFASE_RELOJ_MIN = 5;
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
if (!Number.isFinite(ALERTA_CADA_HORAS) || ALERTA_CADA_HORAS < 1 || ALERTA_CADA_HORAS > 72) {
  throw new Error('Configuración: ALERTA_CADA_HORAS debe estar entre 1 y 72');
}
if (!Number.isInteger(ALERTA_MIN_MINUTOS) || ALERTA_MIN_MINUTOS < 5 || ALERTA_MIN_MINUTOS > 720) {
  throw new Error('Configuración: ALERTA_MIN_MINUTOS debe estar entre 5 y 720');
}
if (!Number.isInteger(DESFASE_RELOJ_MIN) || DESFASE_RELOJ_MIN < 1 || DESFASE_RELOJ_MIN > 120) {
  throw new Error('Configuración: DESFASE_RELOJ_MIN debe estar entre 1 y 120');
}

return [
  {
    json: {
      config: {
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        phone_number_id: PHONE_NUMBER_ID,
        graph_version: GRAPH_VERSION,
        ventana_horas: VENTANA_HORAS,
        alerta_cada_horas: ALERTA_CADA_HORAS,
        alerta_min_minutos: ALERTA_MIN_MINUTOS,
        desfase_reloj_min: DESFASE_RELOJ_MIN,
      },
    },
  },
];
