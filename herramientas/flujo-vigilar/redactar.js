// Nodo "Redactar aviso": construye UN mensaje de WhatsApp con los cambios de Drive que aún no se han avisado (registro_drive con
// notificado_at nulo) y el cuerpo exacto de la petición a Meta, más los ids para marcarlos como avisados después (solo si Meta acepta).
//
// - Solo como texto libre y solo si la ventana de 24 h de Meta sigue abierta (el último mensaje TUYO es de hace menos de VENTANA_HORAS).
//   Si está cerrada devuelve [] y no se envía nada: no hay plantillas. Los cambios quedan anotados y se avisan cuando vuelvas a escribir.
// - Se redacta con código, nunca con el modelo. Máximo MAX_LINEAS líneas; el resto sale en la pasada siguiente.

const config = $('Configuración').first().json.config;
const LIMITE_MENSAJE = 3800;
const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
const ruta = (r) => limpiar(r) || '(raíz)';
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

const filas = $('Leer sin avisar')
  .all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.id === 'string' && typeof r.tipo === 'string' && typeof r.nombre === 'string')
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

function cuentas(d) {
  const partes = [];
  if (Number(d?.archivos) > 0) partes.push(plural(Number(d.archivos), 'archivo', 'archivos'));
  if (Number(d?.subcarpetas) > 0) partes.push(plural(Number(d.subcarpetas), 'subcarpeta', 'subcarpetas'));
  return partes.length > 0 ? ` (${partes.join(' y ')})` : '';
}

function linea(r) {
  const d = r.detalle ?? {};
  const antes = ruta(r.ruta_antes);
  const despues = ruta(r.ruta_despues);
  const nombre = limpiar(r.nombre);
  switch (r.tipo) {
    case 'carpeta_creada':
      return `📁 Creaste la carpeta «${despues}»${cuentas(d)}.`;
    case 'carpeta_eliminada':
      return `🗑️ Borraste la carpeta «${antes}»${cuentas(d)}${d.definitivo ? ', definitivamente' : ', está en la papelera'}.`;
    case 'carpeta_movida':
      if (d.fuera) return `📤 Sacaste la carpeta «${antes}» de la zona que vigilo${cuentas(d)}.`;
      return `↪️ Moviste la carpeta «${antes}» a «${despues}»${d.renombrada ? ` y la renombraste a «${nombre}»` : ''}.`;
    case 'carpeta_renombrada':
      return `✏️ Renombraste la carpeta «${antes}» a «${nombre}».`;
    case 'carpeta_restaurada':
      return `♻️ Recuperaste la carpeta «${despues}» de la papelera.`;
    case 'archivo_eliminado':
      return `🗑️ Borraste el archivo «${antes}»${d.definitivo ? ', definitivamente' : ', está en la papelera'}.`;
    case 'archivo_movido':
      if (d.fuera) return `📤 Sacaste el archivo «${antes}» de la zona que vigilo.`;
      return `↪️ Moviste el archivo «${antes}» a «${despues}»${d.renombrada ? ` y lo renombraste a «${nombre}»` : ''}.`;
    case 'archivo_renombrado':
      return `✏️ Renombraste el archivo «${antes}» a «${nombre}».`;
    case 'archivo_restaurado':
      return `♻️ Recuperaste el archivo «${despues}» de la papelera.`;
    default:
      return `Cambio en Drive: «${nombre}».`;
  }
}

const incluidas = filas.slice(0, config.max_lineas);
const lineas = incluidas.map(linea);
let texto;
if (lineas.length === 1) {
  texto = `${lineas[0]} Lo he anotado.`;
} else {
  texto = `*Cambios en Drive*\n${lineas.map((l) => `• ${l}`).join('\n')}\nLos he anotado todos.`;
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
