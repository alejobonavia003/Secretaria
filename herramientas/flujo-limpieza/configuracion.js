// Nodo "Configuración" del flujo "Secretaria · Limpieza de eventos": lo que se toca a mano está aquí.
// Los demás nodos leen estos valores con $('Configuración').first().json.config

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
// Días que pasan, desde que TERMINA un evento, antes de archivarlo. Al archivarlo, el flujo "Sincronizar Calendar" borra su evento de
// Google Calendar (Google lo conserva unos 30 días en su papelera). El item queda en la base de datos como "archivado".
const DIAS_RETENCION = 7;
// Máximo de eventos que se archivan en cada pasada (una al día). Si hay más (la primera vez, con eventos antiguos acumulados), el resto
// sigue en las pasadas siguientes.
const LOTE = 50;
// ==================================

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL) || SUPABASE_URL.includes('TU-PROYECTO')) {
  throw new Error('Configuración: pon tu Project URL de Supabase en SUPABASE_URL (https://<ref>.supabase.co, sin /rest/v1). Va en el .env del servidor (SUPABASE_URL=…, y después docker compose up -d)');
}
if (!Number.isFinite(DIAS_RETENCION) || DIAS_RETENCION < 1 || DIAS_RETENCION > 365) {
  throw new Error('Configuración: DIAS_RETENCION debe estar entre 1 y 365');
}
if (!Number.isInteger(LOTE) || LOTE < 1 || LOTE > 200) {
  throw new Error('Configuración: LOTE debe estar entre 1 y 200');
}

return [{ json: { config: { supabase_url: SUPABASE_URL.replace(/\/+$/, ''), dias_retencion: DIAS_RETENCION, lote: LOTE } } }];
