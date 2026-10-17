// Nodo "Planificar archivado": convierte los eventos antiguos que devolvió Supabase en UNA petición que los archiva.
//
// Doble comprobación: la consulta ya filtra por fecha, pero aquí se vuelve a comprobar cada fila (tipo evento, estado pendiente u hecho,
// id válido y fecha realmente anterior al límite) antes de archivar nada. Así un filtro mal construido nunca puede archivar un evento
// de hoy o futuro. Si no queda ninguno devuelve [] y el flujo termina.
// El PATCH repite las condiciones de tipo y estado: un item que cambió entre la lectura y la escritura no se toca.

const config = $('Configuración').first().json.config;
const limite = Date.parse($('Calcular límite').first().json.limite);
if (Number.isNaN(limite)) throw new Error('Planificar archivado: el límite de fecha no es válido');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const antes = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && Date.parse(s) < limite;

const filas = $input
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string' && ID.test(r.id) && ['pendiente', 'hecho'].includes(r.estado) && (r.fecha_fin != null ? antes(r.fecha_fin) : antes(r.fecha_inicio)));

if (filas.length === 0) return [];

return [
  {
    json: {
      etiqueta: `archivar ${filas.length} evento(s) pasado(s)`,
      url: `${config.supabase_url}/rest/v1/items?id=in.(${filas.map((f) => f.id).join(',')})&tipo=eq.evento&estado=in.(pendiente,hecho)&select=id,titulo`,
      cuerpo: { estado: 'archivado' },
      planificados: filas.length,
    },
  },
];
