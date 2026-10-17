// Pruebas sin red ni coste del flujo "Latido" (flujos/latido.json).
// Ejecuta el código real de herramientas/flujo-latido/*.js con entradas simuladas.
// Uso: node herramientas/probar-latido.js

const fs = require('fs');
const path = require('path');
const { construirFlujo } = require('./generar-latido.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const nodo = (f) => leer('flujo-latido', f);

let pasan = 0;
const fallan = [];
function afirmar(nombre, condicion, detalle) {
  if (condicion) pasan += 1;
  else {
    fallan.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}
async function lanza(nombre, promesa, trozo) {
  try {
    await promesa;
    afirmar(nombre, false, 'debía lanzar un error y no lo hizo');
  } catch (e) {
    afirmar(nombre, String(e.message).includes(trozo), `error recibido: ${e.message}`);
  }
}

const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012', graph_version: 'v26.0', ventana_horas: 23, alerta_cada_horas: 6, alerta_min_minutos: 30, desfase_reloj_min: 5 };

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }), all: () => [{ json: { config: nodos.config ?? CONFIG } }] };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { nodos = {}, env = {} } = {}) {
  const fn = new AsyncFunction('$input', '$', '$env', codigo);
  const salida = await fn({ all: () => [], first: () => undefined }, simular(nodos), env);
  return salida.map((x) => x.json);
}

// --- Datos de prueba ---
const H = 3600000;
const hace = (ms) => new Date(Date.now() - ms).toISOString();
const SANO = () => ({ ahora: new Date().toISOString(), calendar_atascados: 0, drive_atascados: 0, mensajes_sin_procesar: 0, recordatorios_vencidos: 0, ultimo_mensaje: hace(H) });
const ENV = { WHATSAPP_NUMERO_PERMITIDO: '34600111222', HEALTHCHECK_URL_N8N: 'https://hc-ping.com/abc-123' };
const evaluar = async (salud, { previo = [{}], ultimo = [{ created_at: hace(2 * H) }], env = ENV, config } = {}) =>
  (await correr(nodo('evaluar.js'), { nodos: { 'Leer salud': [salud], 'Leer estado de alertas': previo, 'Leer último mensaje': ultimo, ...(config ? { config } : {}) }, env }))[0];
const previoCon = (firma, haceMs) => [{ valor: { firma, ultima_alerta: hace(haceMs) } }];

async function main() {
  console.log('Configuración');
  {
    const base = nodo('configuracion.js');
    await lanza('sin poner Supabase, lanza', correr(base), 'SUPABASE_URL');
    const s = base.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co');
    await lanza('sin el Phone number ID, lanza', correr(s), 'PHONE_NUMBER_ID');
    const [c] = await correr(s.replace('TU-PHONE-NUMBER-ID', '123456789012'));
    afirmar('con todo puesto devuelve la configuración con los valores por defecto', c.config.ventana_horas === 23 && c.config.alerta_cada_horas === 6 && c.config.alerta_min_minutos === 30 && c.config.desfase_reloj_min === 5);
    const [e] = await correr(base, { env: { SUPABASE_URL: 'https://xyz.supabase.co', WHATSAPP_PHONE_NUMBER_ID: '987654321098' } });
    afirmar('con el .env relleno, el nodo sin editar funciona', e.config.supabase_url === 'https://xyz.supabase.co' && e.config.phone_number_id === '987654321098');
    await lanza('un Phone number ID inválido en el .env se rechaza igual', correr(base, { env: { SUPABASE_URL: 'https://xyz.supabase.co', WHATSAPP_PHONE_NUMBER_ID: '12ab' } }), 'PHONE_NUMBER_ID');
  }

  console.log('Evaluar: la respuesta de la base de datos');
  {
    await lanza('una respuesta sin los contadores lanza un error (no se manda latido)', evaluar({ ahora: new Date().toISOString() }), 'no tiene la forma esperada');
    await lanza('una respuesta que no es un objeto lanza un error', evaluar(null), 'no tiene la forma esperada');
    await lanza('un contador no numérico lanza un error', evaluar({ ...SANO(), drive_atascados: 'mucho' }), 'no tiene la forma esperada');
    const r = await evaluar(SANO());
    afirmar('todo bien: ok, sin problemas y sin WhatsApp', r.ok === true && r.problemas.length === 0 && r.enviar_whatsapp === false && r.cuerpo === null && r.estado_nuevo === null);
  }

  console.log('Evaluar: monitor externo');
  {
    const bien = await evaluar(SANO());
    afirmar('todo bien: avisa a la dirección del monitor (latido)', bien.ping_url === 'https://hc-ping.com/abc-123');
    const barra = await evaluar(SANO(), { env: { ...ENV, HEALTHCHECK_URL_N8N: 'https://hc-ping.com/abc-123/' } });
    afirmar('una barra final no se duplica', barra.ping_url === 'https://hc-ping.com/abc-123');
    const mal = await evaluar({ ...SANO(), calendar_atascados: 2 });
    afirmar('con un problema avisa a la dirección + /fail', mal.ping_url === 'https://hc-ping.com/abc-123/fail');
    const sin = await evaluar(SANO(), { env: { WHATSAPP_NUMERO_PERMITIDO: '34600111222' } });
    afirmar('sin la variable no avisa a ningún monitor (pero el flujo sigue)', sin.ping_url === null && sin.ok === true);
    await lanza('una dirección que no es https se rechaza', evaluar(SANO(), { env: { ...ENV, HEALTHCHECK_URL_N8N: 'http://hc-ping.com/x' } }), 'no es una dirección https válida');
    await lanza('una dirección con espacios se rechaza', evaluar(SANO(), { env: { ...ENV, HEALTHCHECK_URL_N8N: 'https://a b' } }), 'no es una dirección https válida');
  }

  console.log('Evaluar: qué cuenta como problema');
  {
    const una = await evaluar({ ...SANO(), calendar_atascados: 1 });
    afirmar('un evento sin sincronizar (singular)', una.problemas[0] === '1 evento sin sincronizar con Google Calendar desde hace más de 15 minutos' && una.firma === 'calendar');
    const varias = await evaluar({ ...SANO(), calendar_atascados: 3, drive_atascados: 2, mensajes_sin_procesar: 1, recordatorios_vencidos: 4 });
    afirmar('todos a la vez, en plural y en orden', varias.problemas.length === 4 && varias.problemas[0].startsWith('3 eventos sin sincronizar') && varias.problemas[1] === '2 archivos o carpetas sin mover o crear en Drive desde hace más de 30 minutos' && varias.problemas[2] === '1 mensaje tuyo no se procesó (últimas 2 horas)' && varias.problemas[3] === '4 recordatorios sin avisar a su hora' && varias.firma === 'calendar|drive|mensajes|recordatorios');
    const reloj = await evaluar({ ...SANO(), ahora: hace(12 * 60000) });
    afirmar('un reloj desfasado 12 minutos respecto a la base de datos es un problema', reloj.ok === false && reloj.problemas[0].includes('el reloj del servidor difiere 12 minutos') && reloj.firma === 'reloj');
    const tolerado = await evaluar({ ...SANO(), ahora: hace(2 * 60000) });
    afirmar('un desfase pequeño (2 minutos) se tolera', tolerado.ok === true);
    const sinHora = await evaluar({ ...SANO(), ahora: undefined });
    afirmar('si la respuesta no trae la hora, no se inventa un problema de reloj', sinHora.ok === true);
  }

  console.log('Evaluar: cuándo escribe por WhatsApp');
  {
    const mal = { ...SANO(), calendar_atascados: 2, drive_atascados: 1 };
    const nuevo = await evaluar(mal);
    afirmar('un problema nuevo con la ventana abierta: avisa', nuevo.enviar_whatsapp === true && nuevo.texto.startsWith('⚠️ La secretaria detecta que algo no avanza:\n• 2 eventos sin sincronizar') && nuevo.texto.includes('mira el historial de ejecuciones de n8n'));
    afirmar('el cuerpo va a su número como texto libre', nuevo.cuerpo.to === '34600111222' && nuevo.cuerpo.type === 'text' && nuevo.cuerpo.text.body === nuevo.texto);
    afirmar('guarda el estado con la firma y la hora del aviso', nuevo.estado_nuevo.clave === 'latido' && nuevo.estado_nuevo.valor.firma === 'calendar|drive' && Math.abs(Date.parse(nuevo.estado_nuevo.valor.ultima_alerta) - Date.now()) < 5000);
    const cerrada = await evaluar(mal, { ultimo: [{ created_at: hace(30 * H) }] });
    afirmar('con la ventana de 24 h cerrada no escribe (el monitor sí recibe el /fail)', cerrada.enviar_whatsapp === false && cerrada.estado_nuevo === null && cerrada.ping_url.endsWith('/fail'));
    const sinMensajes = await evaluar(mal, { ultimo: [{}] });
    afirmar('sin ningún mensaje tuyo tampoco', sinMensajes.enviar_whatsapp === false);
    const igualPronto = await evaluar(mal, { previo: previoCon('calendar|drive', 2 * H) });
    afirmar('el mismo problema que ya se avisó hace 2 h no se repite', igualPronto.enviar_whatsapp === false);
    const igualTarde = await evaluar(mal, { previo: previoCon('calendar|drive', 7 * H) });
    afirmar('el mismo problema se repite pasadas 6 h', igualTarde.enviar_whatsapp === true);
    const distintoPronto = await evaluar(mal, { previo: previoCon('calendar', 10 * 60000) });
    afirmar('un problema distinto antes de 30 minutos desde el último aviso espera (sin ráfagas)', distintoPronto.enviar_whatsapp === false);
    const distintoTarde = await evaluar(mal, { previo: previoCon('calendar', 45 * 60000) });
    afirmar('un problema distinto pasados 30 minutos se avisa', distintoTarde.enviar_whatsapp === true);
    const recuperado = await evaluar(SANO(), { previo: previoCon('calendar|drive', 2 * H) });
    afirmar('al arreglarse, un solo «Ya está todo en orden» y se limpia la firma', recuperado.enviar_whatsapp === true && recuperado.texto === '✅ Ya está todo en orden otra vez.' && recuperado.estado_nuevo.valor.firma === '' && recuperado.ping_url === 'https://hc-ping.com/abc-123');
    const sanoYa = await evaluar(SANO(), { previo: previoCon('', 2 * H) });
    afirmar('si ya estaba todo en orden no repite nada', sanoYa.enviar_whatsapp === false);
    const recuperadoCerrada = await evaluar(SANO(), { previo: previoCon('calendar', 2 * H), ultimo: [{ created_at: hace(30 * H) }] });
    afirmar('si se arregla con la ventana cerrada no escribe y conserva la firma (avisará de la recuperación al volver a escribir)', recuperadoCerrada.enviar_whatsapp === false && recuperadoCerrada.estado_nuevo === null);
    await lanza('sin el número de destino en el entorno, lanza si hay que escribir', evaluar(mal, { env: { HEALTHCHECK_URL_N8N: 'https://hc-ping.com/abc-123' } }), 'WHATSAPP_NUMERO_PERMITIDO');
    const sinNumeroPeroNada = await evaluar(SANO(), { env: { HEALTHCHECK_URL_N8N: 'https://hc-ping.com/abc-123' } });
    afirmar('pero sin nada que escribir no hace falta el número', sinNumeroPeroNada.ok === true);
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const nodos = flujo.nodes.filter((n) => !n.type.includes('stickyNote'));
    const por = (nombre) => nodos.find((n) => n.name === nombre);
    afirmar('hay 12 nodos de trabajo y dos disparadores (cada 5 minutos y a mano)', nodos.length === 12 && por('Cada 5 minutos').parameters.rule.interval[0].minutesInterval === 5 && por('Disparador manual'));
    const bd = nodos.filter((n) => n.parameters.nodeCredentialType === 'supabaseApi');
    afirmar('solo lee la base de datos, salvo guardar su propio estado de avisos', bd.length === 4 && bd.filter((n) => n.parameters.method !== 'GET').map((n) => n.name).sort().join() === 'Guardar estado,Leer salud');
    afirmar('«Leer salud» llama a la función salud_sistema, que solo lee', por('Leer salud').parameters.url.includes('/rest/v1/rpc/salud_sistema') && por('Leer salud').parameters.method === 'POST');
    afirmar('si la base de datos no responde, el flujo se detiene (no manda latido: el monitor externo avisa)', !por('Leer salud').onError && !por('Leer estado de alertas').onError && !por('Leer último mensaje').onError);
    afirmar('un fallo del monitor externo no rompe el flujo, pero Meta rechazando el envío sí lo deja en rojo', por('Avisar al monitor').onError === 'continueRegularOutput' && !por('Enviar WhatsApp').onError);
    afirmar('«Guardar estado» va después de «Enviar WhatsApp»: solo se guarda si Meta aceptó', flujo.connections['Enviar WhatsApp'].main[0][0].node === 'Guardar estado');
    afirmar('con monitor: avisa al monitor y luego decide lo de WhatsApp; sin monitor: pasa directamente', flujo.connections['¿Avisar al monitor?'].main[0][0].node === 'Avisar al monitor' && flujo.connections['¿Avisar al monitor?'].main[1][0].node === '¿Enviar WhatsApp?' && flujo.connections['Avisar al monitor'].main[0][0].node === '¿Enviar WhatsApp?');
    afirmar('si no hay que escribir, el flujo termina', flujo.connections['¿Enviar WhatsApp?'].main[1].length === 0);
    afirmar('la dirección del monitor NO está en el flujo (vive en el .env)', !JSON.stringify(flujo).includes('hc-ping') && !JSON.stringify(flujo).includes('healthchecks.io'));
    afirmar('las dos lecturas con posibles varias filas se ejecutan una vez', por('Leer estado de alertas').executeOnce === true && por('Leer último mensaje').executeOnce === true);
    const ids = flujo.nodes.map((n) => n.id);
    afirmar('ids únicos y de su propia serie', new Set(ids).size === ids.length && ids.every((i) => i.startsWith('7e5e7e30-')));
    afirmar('los dos IF tienen ids de condición bien formados', nodos.filter((n) => n.type === 'n8n-nodes-base.if').every((n) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(n.parameters.conditions.conditions[0].id)));
  }

  console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} con fallo.`);
  if (fallan.length) {
    console.log('Fallan:');
    fallan.forEach((n) => console.log(`- ${n}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
