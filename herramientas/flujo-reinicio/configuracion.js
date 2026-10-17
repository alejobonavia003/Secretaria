// Nodo "Configuración" del flujo "Secretaria · Reiniciar todo": lo que se toca a mano está aquí.
// Este flujo SOLO se lanza a mano (Disparador manual). No lo publiques con ningún disparador automático.

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
// ID del calendario "Secretaria" (Google Calendar > Configuración del calendario > Integrar el calendario > ID). Termina en @group.calendar.google.com.
// Se borran TODOS sus eventos (el calendario en sí se queda).
const CALENDAR_ID = delEntorno('GOOGLE_CALENDAR_ID', 'TU-CALENDARIO@group.calendar.google.com');
// ID de la carpeta "Secretaria" de Drive (el mismo CARPETA_RAIZ_ID del flujo "Sincronizar Drive"). Solo se toca lo que cuelga de ella.
const CARPETA_RAIZ_ID = delEntorno('DRIVE_CARPETA_RAIZ_ID', 'TU-CARPETA-RAIZ');
// Carpetas de la raíz que se conservan (vaciadas por dentro). Todo lo demás de la raíz va a la papelera de Drive.
const CONSERVAR = ['Entrada', 'Notas'];
// SEGURO: mientras esto esté vacío el flujo solo ENSAYA (lista lo que borraría y no toca nada). Para borrar de verdad, escribe exactamente
// BORRAR TODO, ejecuta una vez, y vuelve a dejarlo vacío.
const CONFIRMAR = '';
// ==================================

if (!/^[^@\s/]+@[^@\s/]+$/.test(CALENDAR_ID) || CALENDAR_ID.includes('TU-CALENDARIO')) {
  throw new Error('Configuración: pon el ID del calendario "Secretaria" en CALENDAR_ID (termina en @group.calendar.google.com). Va en el .env del servidor (GOOGLE_CALENDAR_ID=…, y después docker compose up -d)');
}
if (!/^[A-Za-z0-9_-]{10,}$/.test(CARPETA_RAIZ_ID) || CARPETA_RAIZ_ID.includes('TU-CARPETA')) {
  throw new Error('Configuración: pon el ID de la carpeta "Secretaria" de Drive en CARPETA_RAIZ_ID (solo letras, números, guion y guion bajo). Va en el .env del servidor (DRIVE_CARPETA_RAIZ_ID=…, y después docker compose up -d)');
}
if (!Array.isArray(CONSERVAR) || CONSERVAR.some((n) => typeof n !== 'string' || n.trim() === '')) {
  throw new Error('Configuración: CONSERVAR debe ser una lista de nombres de carpeta');
}

return [
  {
    json: {
      config: {
        calendar_id: CALENDAR_ID,
        carpeta_raiz_id: CARPETA_RAIZ_ID,
        conservar: CONSERVAR.map((n) => n.trim()),
        real: CONFIRMAR === 'BORRAR TODO',
      },
    },
  },
];
