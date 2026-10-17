// Nodo "Registrar": convierte la respuesta de Google de cada evento en la actualización que hay que
// hacer en Supabase. La respuesta llega completa (statusCode, body) porque el nodo de Google no falla ante errores HTTP.
//
// Cada escritura lleva una condición sobre updated_at (el valor que leyó "Leer pendientes"): si el item cambió
// mientras se sincronizaba, esa actualización no afecta a ninguna fila y el item sigue pendiente.

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const base = `${config.supabase_url}/rest/v1`;
const plan = $('Planificar sincronización').all().map((i) => i.json);
const respuestas = $input.all().map((i) => i.json);

const resumen = (cuerpo) => String(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo ?? '')).slice(0, 200);

const escrituras = [];
const fallos = [];

respuestas.forEach((r, i) => {
  const p = plan[i];
  const estado = r.statusCode;
  const parche = (etiqueta, cuerpo) =>
    escrituras.push({
      json: {
        etiqueta,
        metodo: 'PATCH',
        url: `${base}/items?id=eq.${encodeURIComponent(p.item_id)}&updated_at=eq.${encodeURIComponent(p.updated_at)}`,
        cuerpo,
        prefer: 'return=minimal',
      },
    });

  if (estado >= 200 && estado < 300) {
    const idEvento = typeof r.body?.id === 'string' ? r.body.id : p.id_evento;
    const aviso = calcularAviso({ fecha_inicio: p.fecha_inicio, referencia: p.updated_at, aviso_min: config.aviso_min });
    parche(`${p.accion}: ${p.item_id}`, { calendar_event_id: idEvento, calendar_pendiente: false, aviso_whatsapp_en: aviso, aviso_whatsapp_enviado_at: null });
  } else if (p.accion === 'crear' && estado === 409) {
    // El evento ya existía (una creación anterior funcionó pero no se pudo anotar): se anota su id y
    // el item sigue pendiente, así que la próxima vez se actualiza con los datos actuales
    parche(`ya existía: ${p.item_id}`, { calendar_event_id: p.id_evento });
  } else if (p.accion === 'actualizar' && estado === 404) {
    // El evento ya no está en Calendar (se borró allí): se olvida su id y el item sigue pendiente,
    // así que la próxima vez se vuelve a crear
    parche(`desaparecido de Calendar: ${p.item_id}`, { calendar_event_id: null });
  } else {
    const motivo = r.error ? String(r.error.message ?? r.error) : `HTTP ${estado} ${resumen(r.body)}`;
    fallos.push(`${p.accion} ${p.item_id}: ${motivo}`);
  }
});

// Un fallo aislado se reintenta al minuto siguiente. Si no se ha podido hacer NADA (credencial caducada,
// calendario inexistente, Google caído…) se avisa con un error para que la ejecución salga en rojo.
if (fallos.length > 0 && escrituras.length === 0) {
  throw new Error(`Sincronizar Calendar: ${fallos.length} fallo(s) y ningún evento sincronizado. ${fallos.slice(0, 3).join(' | ')}`);
}

return escrituras;
