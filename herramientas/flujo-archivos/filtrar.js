// Nodo "Filtrar archivos": de lo que devolvió Supabase se queda con los archivos que llevan sin clasificar más de HORAS_ESPERA.
//
// La consulta ya filtra, pero cada fila se revalida aquí (pendiente, nombre, fecha válida y de hace más de la espera): así un
// archivo recién mandado nunca provoca una pregunta. Si no queda ninguno devuelve [] y el flujo termina sin leer nada más.

const config = $('Configuración').first().json.config;
const ahora = Date.now();
const limite = ahora - config.horas_espera * 3600 * 1000;

const archivos = $input
  .all()
  .map((i) => i.json)
  .filter((r) => r && r.estado === 'pendiente' && typeof r.nombre === 'string' && r.nombre.trim() !== '' && typeof r.created_at === 'string' && Date.parse(r.created_at) <= limite)
  .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  .map((r) => ({ nombre: r.nombre, created_at: r.created_at }));

if (archivos.length === 0) return [];
return [{ json: { archivos } }];
