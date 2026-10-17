// Nodo "Calcular límite": fija la fecha límite (ahora menos DIAS_RETENCION días) y construye la URL de la consulta de eventos antiguos.
// Un evento es antiguo si su FIN pasó antes del límite; si no tiene fin, cuenta su inicio. Solo eventos en estado pendiente o hecho
// (los archivados ya los trata el flujo de Calendar). Los más antiguos primero, y como mucho LOTE.

const config = $('Configuración').first().json.config;
const limite = new Date(Date.now() - config.dias_retencion * 86400000).toISOString();

const filtroFecha = `(fecha_fin.lt."${limite}",and(fecha_fin.is.null,fecha_inicio.lt."${limite}"))`;
const url = `${config.supabase_url}/rest/v1/items?select=id,titulo,fecha_inicio,fecha_fin,estado&tipo=eq.evento&estado=in.(pendiente,hecho)&or=${encodeURIComponent(filtroFecha)}&order=fecha_inicio.asc&limit=${config.lote}`;

return [{ json: { limite, url_lectura: url } }];
