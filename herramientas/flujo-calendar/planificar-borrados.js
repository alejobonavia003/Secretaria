// Nodo "Planificar borrados": prepara el DELETE a Google Calendar de los eventos de items ARCHIVADOS, es decir, cancelados por
// el usuario ("quita la cita de mañana"). Es la única excepción a "este sistema nunca borra eventos": solo se borra el evento
// cuyo id guardó este sistema en el item archivado (calendar_event_id), nunca otro, y nunca por haberse completado.
// El nodo HTTP de Google no puede mezclar métodos con y sin cuerpo, así que los borrados tienen su propio nodo.
// Si no hay nada que borrar no emite items y la rama no se ejecuta.

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const API = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar_id)}/events`;

return $('Leer pendientes')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string')
  .filter((it) => clasificar(it).accion === 'borrar')
  .map((it) => ({
    json: {
      accion: 'borrar',
      metodo: 'DELETE',
      url: `${API}/${encodeURIComponent(it.calendar_event_id)}`,
      item_id: it.id,
      updated_at: it.updated_at,
      id_evento: it.calendar_event_id,
    },
  }));
