// Nodo "Redactar recordatorio": UN mensaje de WhatsApp con los archivos que llevan días sin clasificar, y el cuerpo exacto de la
// petición a Meta.
//
// - Solo se envía como texto libre y solo si la ventana de 24 h de Meta sigue abierta (el último mensaje TUYO es de hace menos de
//   VENTANA_HORAS). Si está cerrada devuelve [] y no se envía nada: el resumen de las 7:00 ya los lista.
// - El mensaje explica cómo clasificarlos: no hace falta estado nuevo, la respuesta pasa por la intención «archivar» del flujo
//   principal (órdenes en bloque: «las N últimas son de …», «todas en …»).
// - Se redacta con código, nunca con el modelo.

const config = $('Configuración').first().json.config;
const LIMITE_MENSAJE = 3800;
const ZONA = 'Europe/Madrid';

const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
const fmtFecha = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fecha = (iso) => fmtFecha.format(new Date(iso)).replace(/\./g, '').replace(',', '');

const archivos = $('Filtrar archivos').first().json.archivos;
const ultimo = $('Leer último mensaje')
  .all()
  .map((x) => x.json)
  .filter((r) => r && typeof r.created_at === 'string')
  .map((r) => new Date(r.created_at))
  .filter((d) => !Number.isNaN(d.getTime()))[0];

const ahora = new Date();
const ventanaAbierta = Boolean(ultimo) && ahora.getTime() - ultimo.getTime() < config.ventana_horas * 3600 * 1000;
if (!ventanaAbierta) return [];

const para = String($env.WHATSAPP_NUMERO_PERMITIDO ?? '').replace(/\D/g, '');
if (!para) throw new Error('Redactar recordatorio: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const n = archivos.length;
const cabecera = n === 1 ? '📎 Tienes *1 archivo* sin clasificar desde hace más de un día:' : `📎 Tienes *${n} archivos* sin clasificar desde hace más de un día:`;
const mostrados = archivos.slice(0, config.max_lista);
const lista = mostrados.map((a) => `• ${limpiar(a.nombre)} (${fecha(a.created_at)})`).join('\n');
const resto = n > mostrados.length ? `\n• y ${n - mostrados.length} más` : '';
const pie = `¿Qué ${n > 1 ? 'son' : 'es'} o en qué carpeta ${n > 1 ? 'los' : 'lo'} guardo? Por ejemplo: «${n > 1 ? 'todas en Fotos' : 'guárdala en Fotos'}».`;

let texto = `${cabecera}\n${lista}${resto}\n\n${pie}`;
if (texto.length > LIMITE_MENSAJE) texto = `${texto.slice(0, LIMITE_MENSAJE - 1).trimEnd()}…`;

return [
  {
    json: {
      cuerpo: { messaging_product: 'whatsapp', recipient_type: 'individual', to: para, type: 'text', text: { preview_url: false, body: texto } },
      texto,
      total: n,
    },
  },
];
