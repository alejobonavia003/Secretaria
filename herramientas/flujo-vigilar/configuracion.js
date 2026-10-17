// Nodo "Configuración" del flujo "Secretaria · Vigilar Drive": lo que se toca a mano está aquí.
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
// ID de la carpeta "Secretaria" de Drive (el mismo CARPETA_RAIZ_ID del flujo "Sincronizar Drive"). Solo se vigila lo que cuelga de ella.
const CARPETA_RAIZ_ID = delEntorno('DRIVE_CARPETA_RAIZ_ID', 'TU-CARPETA-RAIZ');
// Horas desde el último mensaje tuyo durante las que Meta admite texto libre (Meta admite 24 h: margen para no rozar el límite).
// Fuera de ese plazo NO se envía nada (sin plantillas): los cambios quedan anotados y se avisan cuando vuelvas a escribir.
const VENTANA_HORAS = 23;
// Cuántos elementos que han desaparecido del árbol se confirman con Drive en cada pasada (uno de cada carpeta borrada, no uno por archivo).
const LOTE_CONFIRMAR = 40;
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
if (!/^[A-Za-z0-9_-]{10,}$/.test(CARPETA_RAIZ_ID) || CARPETA_RAIZ_ID.includes('TU-CARPETA')) {
  throw new Error('Configuración: pon el ID de la carpeta "Secretaria" de Drive en CARPETA_RAIZ_ID (solo letras, números, guion y guion bajo). Va en el .env del servidor (DRIVE_CARPETA_RAIZ_ID=…, y después docker compose up -d)');
}
if (!Number.isFinite(VENTANA_HORAS) || VENTANA_HORAS < 1 || VENTANA_HORAS > 24) {
  throw new Error('Configuración: VENTANA_HORAS debe estar entre 1 y 24');
}
if (!Number.isInteger(LOTE_CONFIRMAR) || LOTE_CONFIRMAR < 1 || LOTE_CONFIRMAR > 200) {
  throw new Error('Configuración: LOTE_CONFIRMAR debe estar entre 1 y 200');
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
        carpeta_raiz_id: CARPETA_RAIZ_ID,
        ventana_horas: VENTANA_HORAS,
        lote_confirmar: LOTE_CONFIRMAR,
        max_lineas: MAX_LINEAS,
      },
    },
  },
];
