// Nodo "Preparar marcas": tras enviar el aviso, una petición por recordatorio para anotar los avisos ya enviados.
// Si era el aviso «a la hora» el recordatorio se da por hecho (ya cumplió su función). Cada petición repite las condiciones de lo que se
// leyó (misma hora de recordatorio, tarea, pendiente): si el usuario cambió la hora o lo completó mientras tanto, no se toca.

const config = $('Configuración').first().json.config;
const marcas = $('Redactar recordatorio').first().json.marcas;

return marcas.map((m) => ({
  json: {
    url: `${config.supabase_url}/rest/v1/items?id=eq.${encodeURIComponent(m.id)}&tipo=eq.tarea&estado=eq.pendiente&recordar_en=eq.${encodeURIComponent(m.recordar_en)}`,
    cuerpo: { recordatorio_avisos: m.avisos, ...(m.hecho ? { estado: 'hecho' } : {}) },
  },
}));
