// Pruebas sin red ni coste del flujo "Recordatorio de archivos" (flujos/recordatorio-archivos.json).
// Ejecuta el código real de herramientas/flujo-archivos/*.js con entradas simuladas y un reloj fijo.
// Uso: node herramientas/probar-archivos.js

const fs = require('fs');
const { credencialesSoloPorNombre } = require('./comun/importacion');
const path = require('path');
const { construirFlujo } = require('./generar-archivos.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leer = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
const CODIGO_CONFIG = leer('flujo-archivos', 'configuracion.js');
const CODIGO_FILTRAR = leer('flujo-archivos', 'filtrar.js');
const CODIGO_REDACTAR = leer('flujo-archivos', 'redactar.js');

let pasan = 0;
const fallan = [];
function afirmar(nombre, condicion, detalle) {
  if (condicion) pasan += 1;
  else {
    fallan.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}

// Reloj fijo: solo cambia "new Date()" sin argumentos y Date.now()
const RealDate = Date;
async function conHora(iso, fn) {
  const fijo = new RealDate(iso).getTime();
  class Fija extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(fijo);
      else super(...a);
    }
    static now() {
      return fijo;
    }
  }
  globalThis.Date = Fija;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

const CONFIG = { supabase_url: 'https://abc.supabase.co', phone_number_id: '123456789012345', graph_version: 'v26.0', horas_espera: 24, ventana_horas: 23, max_lista: 10 };

function simular(nodos) {
  return (nombre) => {
    if (nombre === 'Configuración') return { first: () => ({ json: { config: nodos.config ?? CONFIG } }) };
    if (!(nombre in nodos)) throw new Error(`Node "${nombre}" hasn't been executed`);
    const items = nodos[nombre].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
}
async function correr(codigo, { input = [], nodos = {}, env = { WHATSAPP_NUMERO_PERMITIDO: '34600111222' } } = {}) {
  const items = input.map((json) => ({ json }));
  const fn = new AsyncFunction('$input', '$', '$env', codigo);
  const salida = await fn({ all: () => items, first: () => items[0] }, simular(nodos), env);
  return salida.map((x) => x.json);
}
async function lanza(nombre, promesa, trozo) {
  try {
    await promesa;
    afirmar(nombre, false, 'debía lanzar un error y no lo hizo');
  } catch (e) {
    afirmar(nombre, String(e.message).includes(trozo), `error recibido: ${e.message}`);
  }
}

// "Ahora": lunes 12 de octubre de 2026, 19:00 en Madrid (+02:00)
const AHORA = '2026-10-12T17:00:00.000Z';
const arch = (o) => ({ id: 'a', nombre: '2026-10-10 18.30 · WhatsApp.jpg', estado: 'pendiente', created_at: '2026-10-10T16:30:00+00:00', ...o });
const filtrar = (filas, config = CONFIG) => conHora(AHORA, () => correr(CODIGO_FILTRAR, { input: filas, nodos: { config } }));
const redactar = (archivos, ultimo, extra = {}) =>
  conHora(AHORA, () => correr(CODIGO_REDACTAR, { nodos: { 'Filtrar archivos': [{ archivos }], 'Leer último mensaje': ultimo }, env: extra.env }));

const RECIENTE = [{ created_at: '2026-10-12T09:00:00+00:00' }]; // hace 8 h
const ANTIGUO = [{ created_at: '2026-10-10T20:00:00+00:00' }]; // hace más de 24 h
const uno = [{ nombre: 'Factura.pdf', created_at: '2026-10-10T16:30:00+00:00' }];

async function main() {
  console.log('Configuración');
  {
    const ok = (c = CODIGO_CONFIG) => correr(c.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co').replace('TU-PHONE-NUMBER-ID', '123456789012345'));
    const [r] = await ok();
    afirmar('con la URL y el número puestos devuelve la configuración', r.config.supabase_url === 'https://abc.supabase.co' && r.config.phone_number_id === '123456789012345' && r.config.horas_espera === 24 && r.config.ventana_horas === 23 && r.config.max_lista === 10);
    await lanza('sin poner la URL de Supabase, lanza un error', correr(CODIGO_CONFIG), 'SUPABASE_URL');
    await lanza('sin poner el Phone number ID, lanza un error', correr(CODIGO_CONFIG.replace('https://TU-PROYECTO.supabase.co', 'https://abc.supabase.co')), 'PHONE_NUMBER_ID');
    await lanza('una espera absurda se rechaza', ok(CODIGO_CONFIG.replace('HORAS_ESPERA = 24', 'HORAS_ESPERA = 0')), 'HORAS_ESPERA');
  }

  console.log('Filtrar archivos');
  {
    const [r] = await filtrar([arch()]);
    afirmar('un archivo pendiente de hace más de 24 h pasa', r.archivos.length === 1 && r.archivos[0].nombre.endsWith('WhatsApp.jpg'));
    afirmar('sin filas no queda nada (el flujo termina)', (await filtrar([{}])).length === 0 && (await filtrar([])).length === 0);
    afirmar('un archivo recién mandado no pasa', (await filtrar([arch({ created_at: '2026-10-12T10:00:00+00:00' })])).length === 0);
    afirmar('justo en el límite de la espera pasa', (await filtrar([arch({ created_at: '2026-10-11T17:00:00+00:00' })])).length === 1);
    afirmar('un archivo ya clasificado no pasa', (await filtrar([arch({ estado: 'clasificado' })])).length === 0);
    afirmar('sin nombre o sin fecha válida no pasa', (await filtrar([arch({ nombre: ' ' }), arch({ created_at: 'ayer' }), arch({ created_at: null })])).length === 0);
    const v = await filtrar([arch({ nombre: 'B', created_at: '2026-10-10T18:00:00+00:00' }), arch({ nombre: 'A', created_at: '2026-10-09T18:00:00+00:00' })]);
    afirmar('salen del más antiguo al más reciente', v[0].archivos.map((a) => a.nombre).join() === 'A,B');
    afirmar('la espera se lee de la configuración', (await filtrar([arch({ created_at: '2026-10-12T10:00:00+00:00' })], { ...CONFIG, horas_espera: 1 })).length === 1);
  }

  console.log('Redactar recordatorio');
  {
    const [r] = await redactar(uno, RECIENTE);
    const c = r.cuerpo;
    afirmar('con la ventana abierta, texto libre al número permitido', c.type === 'text' && c.messaging_product === 'whatsapp' && c.to === '34600111222' && c.text.preview_url === false, JSON.stringify(c));
    afirmar('un archivo: singular, con su nombre y fecha de Madrid, y cómo clasificarlo', r.texto === '📎 Tienes *1 archivo* sin clasificar desde hace más de un día:\n• Factura.pdf (10 oct 18:30)\n\nRespóndeme, por ejemplo, «la última es la factura de la luz» o «guárdala en Fotos».', r.texto);
    const tres = Array.from({ length: 3 }, (_, i) => ({ nombre: `foto-${i}.jpg`, created_at: '2026-10-10T16:30:00+00:00' }));
    const [t] = await redactar(tres, RECIENTE);
    afirmar('varios archivos: plural, uno por línea y «las 3 últimas»', t.texto.includes('*3 archivos*') && t.texto.includes('• foto-0.jpg') && t.texto.includes('• foto-2.jpg') && t.texto.includes('«las 3 últimas son la factura'), t.texto);
    const doce = Array.from({ length: 12 }, (_, i) => ({ nombre: `f${i}.jpg`, created_at: '2026-10-10T16:30:00+00:00' }));
    const [d] = await redactar(doce, RECIENTE);
    afirmar('más de 10: nombra 10 y resume el resto', d.texto.includes('*12 archivos*') && d.texto.includes('• f9.jpg') && !d.texto.includes('• f10.jpg') && d.texto.includes('• y 2 más') && d.total === 12, d.texto);
    const [l] = await redactar([{ nombre: '*raro* _nombre_.pdf', created_at: '2026-10-10T16:30:00+00:00' }], RECIENTE);
    afirmar('los caracteres de formato del nombre no rompen el mensaje', l.texto.includes('• raro nombre.pdf'), l.texto);
    afirmar('con la ventana cerrada no se envía nada', (await redactar(uno, ANTIGUO)).length === 0);
    afirmar('sin ningún mensaje tuyo guardado tampoco se envía', (await redactar(uno, [{}])).length === 0);
    await lanza('sin el número permitido en el entorno, lanza un error', redactar(uno, RECIENTE, { env: {} }), 'WHATSAPP_NUMERO_PERMITIDO');
    const largo = await redactar(Array.from({ length: 30 }, () => ({ nombre: 'x'.repeat(400), created_at: '2026-10-10T16:30:00+00:00' })), RECIENTE);
    afirmar('el mensaje nunca supera el límite de WhatsApp', largo[0].texto.length <= 3800);
  }

  console.log('Flujo generado');
  {
    const flujo = construirFlujo();
    const texto = JSON.stringify(flujo);
    const nombres = flujo.nodes.map((n) => n.name);
    const por = (n) => flujo.nodes.find((x) => x.name === n);
    afirmar('8 nodos de trabajo y 4 notas', flujo.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length === 8 && flujo.nodes.length === 12, String(flujo.nodes.length));
    afirmar('nombres e ids únicos', new Set(nombres).size === nombres.length && new Set(flujo.nodes.map((n) => n.id)).size === flujo.nodes.length);
    afirmar('las conexiones solo nombran nodos existentes', Object.entries(flujo.connections).every(([o, c]) => nombres.includes(o) && c.main[0].every((d) => nombres.includes(d.node))));
    afirmar('sin claves dentro: las credenciales solo se referencian por nombre', credencialesSoloPorNombre(flujo) && !/sb_secret_|AIza|EAA/.test(texto));
    afirmar('zona horaria de Madrid', flujo.settings.timezone === 'Europe/Madrid');
    afirmar('el JSON sobrevive a un ida y vuelta', JSON.stringify(JSON.parse(texto)) === texto);
    const sch = por('Cada día a las 19:00');
    afirmar('se dispara cada día a las 19:00', sch.type === 'n8n-nodes-base.scheduleTrigger' && sch.parameters.rule.interval[0].field === 'days' && sch.parameters.rule.interval[0].triggerAtHour === 19 && sch.parameters.rule.interval[0].triggerAtMinute === 0);
    const cadena = ['Configuración', 'Leer archivos antiguos', 'Filtrar archivos', 'Leer último mensaje', 'Redactar recordatorio', 'Enviar WhatsApp'];
    afirmar('cadena: Configuración, lectura, filtro, último mensaje, redacción y envío', cadena.slice(0, -1).every((n, i) => flujo.connections[n].main[0][0].node === cadena[i + 1]));
    afirmar('los dos disparadores entran por Configuración', flujo.connections['Cada día a las 19:00'].main[0][0].node === 'Configuración' && flujo.connections['Disparador manual'].main[0][0].node === 'Configuración');
    const leerAr = por('Leer archivos antiguos');
    afirmar('Leer archivos antiguos: solo pendientes y anteriores a la espera, siempre con salida', leerAr.parameters.url.includes('estado=eq.pendiente') && leerAr.parameters.url.includes('created_at=lte.') && leerAr.parameters.url.includes('horas_espera') && leerAr.alwaysOutputData === true && leerAr.parameters.method === 'GET');
    const envio = por('Enviar WhatsApp');
    afirmar('Enviar WhatsApp: sin onError (si Meta rechaza queda en rojo) y credencial de cabecera', envio.onError === undefined && envio.parameters.genericAuthType === 'httpHeaderAuth' && envio.parameters.method === 'POST');
    afirmar('nodos Supabase con credencial predefinida', ['Leer archivos antiguos', 'Leer último mensaje'].every((n) => por(n).parameters.nodeCredentialType === 'supabaseApi'));
    afirmar('Configuración conserva los marcadores que hay que editar', por('Configuración').parameters.jsCode.includes('TU-PROYECTO') && por('Configuración').parameters.jsCode.includes('TU-PHONE-NUMBER-ID'));
  }

  console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} con fallo.`);
  if (fallan.length) {
    console.log('Fallan:\n- ' + fallan.join('\n- '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
