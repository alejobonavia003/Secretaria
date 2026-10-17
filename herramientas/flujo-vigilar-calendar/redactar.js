// Nodo "Redactar aviso": construye UN mensaje de WhatsApp con los cambios del calendario que aún no se han avisado (registro_calendar con
// notificado_at nulo) y el cuerpo exacto de la petición a Meta, más los ids para marcarlos como avisados después (solo si Meta acepta).
//
// - Solo como texto libre y solo si la ventana de 24 h de Meta sigue abierta (el último mensaje TUYO es de hace menos de VENTANA_HORAS).
//   Si está cerrada devuelve [] y no se envía nada: no hay plantillas. Los cambios quedan anotados y se avisan cuando vuelvas a escribir.
// - Se redacta con código, nunca con el modelo. Máximo MAX_LINEAS líneas; el resto sale en la pasada siguiente.

const config = $('Configuración').first().json.config;
const LIMITE_MENSAJE = 3800;
const ZONA = 'Europe/Madrid';
const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
const fmtDia = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, weekday: 'short', day: 'numeric', month: 'short' });
const fmtHora = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dia = (iso) => fmtDia.format(new Date(iso)).replace(/[.,]/g, '');
const hora = (iso) => fmtHora.format(new Date(iso));
const cuando = (iso) => `${dia(iso)}, ${hora(iso)}`;
const tramo = (ini, fin) => `${dia(ini)}, de ${hora(ini)} a ${hora(fin)}`;

const filas = $('Leer sin avisar')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string' && typeof r.tipo === 'string' && typeof r.titulo === 'string')
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
if (filas.length === 0) return [];

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

// " ⚠️ Choca con «X» (10:30-11:30)." — con qué otros eventos se pisa el nuevo horario (solo se avisa; no se impide nada)
function aviso(choca) {
  if (!Array.isArray(choca) || choca.length === 0) return '';
  const lista = choca.map((c) => `«${limpiar(c.titulo)}» (${hora(c.inicio)}-${hora(c.fin)})`).join(' y ');
  return ` ⚠️ Choca con ${lista}.`;
}

function linea(r) {
  const d = r.detalle ?? {};
  const t = limpiar(r.titulo);
  switch (r.tipo) {
    case 'evento_creado':
      return `📅 Veo un evento nuevo en tu calendario: «${t}», ${tramo(d.inicio, d.fin)}. Lo he añadido a tus citas.${aviso(d.choca)}`;
    case 'evento_eliminado':
      return `🗑️ Borraste de tu calendario «${t}» (${cuando(d.inicio)}). Lo he cancelado también aquí.`;
    case 'evento_movido':
      return `🕒 Moviste «${limpiar(d.titulo_antes ?? t)}» de ${cuando(d.inicio_antes)} a ${cuando(d.inicio_despues)}${d.renombrado ? ` y lo renombraste a «${limpiar(d.titulo_despues)}»` : ''}.${aviso(d.choca)}`;
    case 'evento_renombrado':
      return `✏️ Renombraste el evento «${limpiar(d.titulo_antes ?? t)}» a «${limpiar(d.titulo_despues)}» (${cuando(d.inicio_antes)}).`;
    default:
      return `Cambio en tu calendario: «${t}».`;
  }
}

const incluidas = filas.slice(0, config.max_lineas);
const lineas = incluidas.map(linea);
let texto;
if (lineas.length === 1) {
  texto = `${lineas[0]} Lo he anotado.`;
} else {
  texto = `*Cambios en tu calendario*\n${lineas.map((l) => `• ${l}`).join('\n')}\nLos he anotado todos.`;
}
const sobran = filas.length - incluidas.length;
if (sobran > 0) texto += `\n… y ${sobran} más (te los digo en el próximo aviso).`;
if (texto.length > LIMITE_MENSAJE) texto = `${texto.slice(0, LIMITE_MENSAJE - 1).trimEnd()}…`;

return [
  {
    json: {
      cuerpo: { messaging_product: 'whatsapp', recipient_type: 'individual', to: para, type: 'text', text: { preview_url: false, body: texto } },
      texto,
      ids: incluidas.map((r) => r.id),
      marca: { notificado_at: ahora.toISOString() },
    },
  },
];
