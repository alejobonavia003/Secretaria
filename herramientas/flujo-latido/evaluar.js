// Nodo "Evaluar": decide con lo que respondió la base de datos (salud_sistema) si el sistema está bien, y qué hay que hacer:
//   - avisar al monitor externo (HEALTHCHECK_URL_N8N): si todo está bien se le avisa de que sigue vivo; si hay un problema, se le avisa de que ha fallado
//     (la dirección termina en /fail; es la convención de Healthchecks.io y de servicios equivalentes). Si la variable no está definida, no se avisa a nadie.
//     Si este flujo (o n8n, o el servidor) dejan de ejecutarse, el monitor deja de recibir latidos y avisa él: ese es el sentido de este flujo.
//   - avisar por WhatsApp, solo con la ventana de 24 h abierta (sin plantillas), con estos límites:
//       · un problema nuevo o distinto: se avisa, pero nunca antes de ALERTA_MIN_MINUTOS desde el último aviso;
//       · el mismo problema que sigue: se repite cada ALERTA_CADA_HORAS;
//       · cuando se arregla (había un aviso de problema): un solo «Ya está todo en orden».
// Se redacta con código, nunca con el modelo. Si la respuesta de la base de datos no tiene la forma esperada, lanza un error: así no se manda ningún
// latido y el monitor externo avisa.

const config = $('Configuración').first().json.config;
const salud = $('Leer salud').first().json;

const ahora = Date.now();
const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const campos = ['calendar_atascados', 'drive_atascados', 'mensajes_sin_procesar', 'recordatorios_vencidos'];
if (!salud || typeof salud !== 'object' || campos.some((c) => !Number.isFinite(numero(salud[c])))) {
  throw new Error('Evaluar: la respuesta de salud_sistema() no tiene la forma esperada (¿está instalada la base de datos? supabase/instalar.sql). No se manda latido.');
}

// --- Problemas ---
const problemas = [];
const claves = [];
const n = (c) => numero(salud[c]);
if (n('calendar_atascados') > 0) {
  claves.push('calendar');
  problemas.push(`${n('calendar_atascados')} ${n('calendar_atascados') === 1 ? 'evento sin sincronizar' : 'eventos sin sincronizar'} con Google Calendar desde hace más de 15 minutos`);
}
if (n('drive_atascados') > 0) {
  claves.push('drive');
  problemas.push(`${n('drive_atascados')} ${n('drive_atascados') === 1 ? 'archivo o carpeta sin mover o crear' : 'archivos o carpetas sin mover o crear'} en Drive desde hace más de 30 minutos`);
}
if (n('mensajes_sin_procesar') > 0) {
  claves.push('mensajes');
  problemas.push(`${n('mensajes_sin_procesar')} ${n('mensajes_sin_procesar') === 1 ? 'mensaje tuyo no se procesó' : 'mensajes tuyos no se procesaron'} (últimas 2 horas)`);
}
if (n('recordatorios_vencidos') > 0) {
  claves.push('recordatorios');
  problemas.push(`${n('recordatorios_vencidos')} ${n('recordatorios_vencidos') === 1 ? 'recordatorio sin avisar' : 'recordatorios sin avisar'} a su hora`);
}
const dbMs = Date.parse(salud.ahora);
if (Number.isFinite(dbMs)) {
  const desfase = Math.round(Math.abs(ahora - dbMs) / 60000);
  if (desfase >= config.desfase_reloj_min) {
    claves.push('reloj');
    problemas.push(`el reloj del servidor difiere ${desfase} minutos del de la base de datos (los avisos y los recordatorios dependen de la hora)`);
  }
}
const ok = problemas.length === 0;
const firma = claves.join('|');

// --- Monitor externo ---
const urlBase = String($env.HEALTHCHECK_URL_N8N ?? '').trim().replace(/\/+$/, '');
if (urlBase !== '' && !/^https:\/\/[^\s]+$/.test(urlBase)) {
  throw new Error('Evaluar: HEALTHCHECK_URL_N8N no es una dirección https válida');
}
const ping = urlBase === '' ? null : ok ? urlBase : `${urlBase}/fail`;

// --- WhatsApp ---
const previo = $('Leer estado de alertas')
  .all()
  .map((i) => i.json)
  .find((r) => r && r.valor && typeof r.valor === 'object')?.valor ?? {};
const firmaPrevia = typeof previo.firma === 'string' ? previo.firma : '';
const ultimaAlerta = Date.parse(previo.ultima_alerta);
const minDesdeAlerta = Number.isFinite(ultimaAlerta) ? (ahora - ultimaAlerta) / 60000 : Infinity;

const ultimoMensaje = $('Leer último mensaje')
  .all()
  .map((x) => x.json)
  .filter((r) => r && typeof r.created_at === 'string')
  .map((r) => Date.parse(r.created_at))
  .filter(Number.isFinite)[0];
const ventanaAbierta = Number.isFinite(ultimoMensaje) && ahora - ultimoMensaje < config.ventana_horas * 3600 * 1000;

let texto = null;
if (ventanaAbierta) {
  if (!ok) {
    const cambio = firma !== firmaPrevia;
    const repetir = !cambio && minDesdeAlerta >= config.alerta_cada_horas * 60;
    if ((cambio && minDesdeAlerta >= config.alerta_min_minutos) || repetir) {
      texto = `⚠️ La secretaria detecta que algo no avanza:\n${problemas.map((p) => `• ${p}`).join('\n')}\nSi se repite, mira el historial de ejecuciones de n8n.`;
    }
  } else if (firmaPrevia !== '') {
    texto = '✅ Ya está todo en orden otra vez.';
  }
}

let cuerpo = null;
if (texto !== null) {
  const para = String($env.WHATSAPP_NUMERO_PERMITIDO ?? '').replace(/\D/g, '');
  if (!para) throw new Error('Evaluar: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');
  cuerpo = { messaging_product: 'whatsapp', recipient_type: 'individual', to: para, type: 'text', text: { preview_url: false, body: texto } };
}

return [
  {
    json: {
      ok,
      problemas,
      firma,
      ping_url: ping,
      enviar_whatsapp: texto !== null,
      texto,
      cuerpo,
      // Solo se guarda cuando se manda un aviso
      estado_nuevo: texto === null ? null : { clave: 'latido', valor: { firma, ultima_alerta: new Date(ahora).toISOString() }, updated_at: new Date(ahora).toISOString() },
    },
  },
];
