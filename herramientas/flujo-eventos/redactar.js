// Nodo "Redactar aviso": construye UN mensaje de WhatsApp con los eventos que están a punto de empezar y el cuerpo exacto de la
// petición a Meta, más lo necesario para marcarlos como avisados después (solo si Meta acepta el envío).
//
// - Solo se envía como texto libre y solo si la ventana de 24 h de Meta sigue abierta (el último mensaje TUYO es de hace menos de
//   VENTANA_HORAS). Si está cerrada devuelve [] y no se envía nada: no existe plantilla para este aviso, y el aviso queda sin
//   marcar (si vuelves a escribir antes de que el evento empiece, se envía entonces; si no, caduca solo).
// - Se redacta con código, nunca con el modelo.

const config = $('Configuración').first().json.config;
const LIMITE_MENSAJE = 3800;
const ZONA = 'Europe/Madrid';

const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
const fmtHora = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hora = (iso) => fmtHora.format(new Date(iso));

function faltan(inicioMs, ahoraMs) {
  const min = Math.max(1, Math.ceil((inicioMs - ahoraMs) / 60000));
  if (min < 90) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `en ${h} h` : `en ${h} h ${m} min`;
}

const eventos = $('Filtrar avisos').first().json.eventos;
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
if (!para) throw new Error('Redactar aviso: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const linea = (e) => `${hora(e.fecha_inicio)} ${limpiar(e.titulo)} (${faltan(Date.parse(e.fecha_inicio), ahora.getTime())})`;
let texto;
if (eventos.length === 1) {
  const e = eventos[0];
  texto = `⏰ *${limpiar(e.titulo)}* empieza a las ${hora(e.fecha_inicio)} (${faltan(Date.parse(e.fecha_inicio), ahora.getTime())}).`;
} else {
  texto = `⏰ *Estos eventos van a empezar*\n${eventos.map((e) => `• ${linea(e)}`).join('\n')}`;
}
if (texto.length > LIMITE_MENSAJE) texto = `${texto.slice(0, LIMITE_MENSAJE - 1).trimEnd()}…`;

const ids = eventos.map((e) => e.id);
return [
  {
    json: {
      cuerpo: { messaging_product: 'whatsapp', recipient_type: 'individual', to: para, type: 'text', text: { preview_url: false, body: texto } },
      texto,
      ids,
      marca: { aviso_whatsapp_enviado_at: ahora.toISOString() },
    },
  },
];
