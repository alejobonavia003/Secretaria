// Nodo "Configuración" del flujo "Sincronizar Calendar": todo lo que se toca a mano está aquí.
// Los demás nodos leen estos valores con $('Configuración').first().json.config
// (Es otro flujo de n8n y por eso repite SUPABASE_URL: hay que ponerla en los dos.)

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
// ID del calendario "Secretaria" (acaba en @group.calendar.google.com). No uses "primary": sería tu calendario principal.
const CALENDAR_ID = delEntorno('GOOGLE_CALENDAR_ID', 'TU-CALENDARIO@group.calendar.google.com');
// Minutos antes del evento para el aviso del propio calendario (popup)
const AVISO_MIN = 30;
// Duración de un evento que no indica fecha_fin
const DURACION_MIN = 60;
// Máximo de eventos que se sincronizan en cada ejecución (cada minuto)
const LOTE = 20;
// ==================================

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL) || SUPABASE_URL.includes('TU-PROYECTO')) {
  throw new Error('Configuración: pon tu Project URL de Supabase en SUPABASE_URL (https://<ref>.supabase.co, sin /rest/v1). Va en el .env del servidor (SUPABASE_URL=…, y después docker compose up -d)');
}
if (!/^[^@\s/]+@[^@\s/]+$/.test(CALENDAR_ID) || CALENDAR_ID.includes('TU-CALENDARIO')) {
  throw new Error('Configuración: pon el ID del calendario "Secretaria" en CALENDAR_ID (termina en @group.calendar.google.com). Va en el .env del servidor (GOOGLE_CALENDAR_ID=…, y después docker compose up -d)');
}
for (const [nombre, valor] of [['AVISO_MIN', AVISO_MIN], ['DURACION_MIN', DURACION_MIN], ['LOTE', LOTE]]) {
  if (!Number.isInteger(valor) || valor <= 0) throw new Error(`Configuración: ${nombre} debe ser un entero positivo`);
}
if (AVISO_MIN > 40320) throw new Error('Configuración: AVISO_MIN no puede pasar de 40320 minutos (4 semanas), el máximo de Google');

return [
  {
    json: {
      config: {
        supabase_url: SUPABASE_URL.replace(/\/+$/, ''),
        calendar_id: CALENDAR_ID,
        aviso_min: AVISO_MIN,
        duracion_min: DURACION_MIN,
        lote: LOTE,
        zona: 'Europe/Madrid',
      },
    },
  },
];
