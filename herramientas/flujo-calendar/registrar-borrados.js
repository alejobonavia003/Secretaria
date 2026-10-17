// Nodo "Registrar borrados": convierte la respuesta de Google a cada DELETE en la actualización que hay que hacer en
// Supabase. La respuesta llega completa (statusCode, body) porque el nodo de Google no falla ante errores HTTP.
//   2xx (204)  borrado
//   404 / 410  el evento ya no existía (se borró a mano en Calendar): el resultado es el mismo
//   otro       fallo: no se anota nada y se reintenta al minuto siguiente
// Al terminar el item se olvida del evento (calendar_event_id nulo, sin aviso pendiente), con la misma condición sobre
// updated_at que el resto de escrituras: si el item cambió mientras tanto, sigue pendiente.

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const base = `${config.supabase_url}/rest/v1`;
const plan = $('Planificar borrados').all().map((i) => i.json);
const respuestas = $input.all().map((i) => i.json);

const resumen = (cuerpo) => String(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo ?? '')).slice(0, 200);

const escrituras = [];
const fallos = [];

respuestas.forEach((r, i) => {
  const p = plan[i];
  const estado = r.statusCode;
  if ((estado >= 200 && estado < 300) || estado === 404 || estado === 410) {
    escrituras.push({
      json: {
        etiqueta: `${estado >= 200 && estado < 300 ? 'borrado' : 'ya no existía'}: ${p.item_id}`,
        metodo: 'PATCH',
        url: `${base}/items?id=eq.${encodeURIComponent(p.item_id)}&updated_at=eq.${encodeURIComponent(p.updated_at)}`,
        cuerpo: { calendar_event_id: null, calendar_pendiente: false, aviso_whatsapp_en: null, aviso_whatsapp_enviado_at: null },
        prefer: 'return=minimal',
      },
    });
  } else {
    const motivo = r.error ? String(r.error.message ?? r.error) : `HTTP ${estado} ${resumen(r.body)}`;
    fallos.push(`borrar ${p.item_id}: ${motivo}`);
  }
});

// Un fallo aislado se reintenta al minuto siguiente. Si no se ha podido hacer NADA se avisa con un error.
if (fallos.length > 0 && escrituras.length === 0) {
  throw new Error(`Sincronizar Calendar: ${fallos.length} fallo(s) y ningún evento borrado. ${fallos.slice(0, 3).join(' | ')}`);
}

return escrituras;
