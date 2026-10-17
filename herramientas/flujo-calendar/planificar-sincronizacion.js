// Nodo "Planificar sincronización": prepara la petición a Google Calendar de cada evento pendiente.
// Solo emite POST (crear) y PATCH (actualizar), siempre con cuerpo: el nodo HTTP de Google no admite
// expresiones en "Send Body", así que no puede mezclar métodos con y sin cuerpo.
// Si no hay nada que enviar no emite items y la rama no se ejecuta.

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const API = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar_id)}/events`;

const pendientes = $('Leer pendientes')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string');

return pendientes
  .filter((it) => clasificar(it).accion === 'sincronizar')
  .map((it) => {
    // Si ya tiene evento en Calendar se actualiza; si no, se crea con un identificador derivado del item
    const existe = typeof it.calendar_event_id === 'string' && it.calendar_event_id !== '';
    const idEvento = existe ? it.calendar_event_id : idEventoDe(it.id);
    const cuerpo = cuerpoEvento(it, config);
    const comun = { item_id: it.id, updated_at: it.updated_at, id_evento: idEvento, fecha_inicio: it.fecha_inicio };
    return {
      json: existe
        ? { accion: 'actualizar', metodo: 'PATCH', url: `${API}/${encodeURIComponent(idEvento)}`, cuerpo, ...comun }
        : { accion: 'crear', metodo: 'POST', url: API, cuerpo: { id: idEvento, ...cuerpo }, ...comun },
    };
  });
