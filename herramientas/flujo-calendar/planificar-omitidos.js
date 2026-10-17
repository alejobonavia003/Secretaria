// Nodo "Planificar omitidos": limpia la marca de los items pendientes que NO se sincronizan con Calendar
// (dejaron de ser eventos, se completaron o no tienen una fecha válida). Sin esto se reprocesarían cada minuto.
// Lo completado conserva su evento en Calendar como registro (la etiqueta lo indica). Una cita que se convirtió en alarma o tarea NO llega aquí: la atiende la rama de borrados.

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const base = `${config.supabase_url}/rest/v1`;

return $('Leer pendientes')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string')
  .map((it) => ({ it, c: clasificar(it) }))
  .filter(({ c }) => c.accion === 'omitir')
  .map(({ it, c }) => ({
    json: {
      etiqueta: `omitido: ${it.id} (${c.motivo}${it.calendar_event_id ? '; el evento sigue en Calendar' : ''})`,
      metodo: 'PATCH',
      url: `${base}/items?id=eq.${encodeURIComponent(it.id)}&updated_at=eq.${encodeURIComponent(it.updated_at)}`,
      cuerpo: { calendar_pendiente: false },
      prefer: 'return=minimal',
    },
  }));
