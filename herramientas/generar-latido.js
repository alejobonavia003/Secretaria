// Genera flujos/latido.json (cada 5 minutos comprueba si hay algo atascado, avisa a un monitor externo de que sigue vivo o de que hay un problema, y
// escribe por WhatsApp si la ventana lo permite) a partir de:
//   - herramientas/flujo-latido/*.js   código de los nodos Code
// Uso: node herramientas/generar-latido.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// El flujo SOLO LEE de la base de datos (la función salud_sistema); lo único que escribe es su propio estado de avisos. Las credenciales se eligen a
// mano al importar; la dirección del monitor externo vive en el .env (HEALTHCHECK_URL_N8N), nunca en el flujo.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'latido.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Latido';

const fallar = (msg) => {
  throw new Error(`generar-latido: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', '$env', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `7e5e7e30-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const PASO = 240;
const CFG = "$('Configuración').first().json.config";
const EV = "$('Evaluar').first().json";
const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-latido', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nodoIf(n, nombre, posicion, condicion) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: `a1b2c3d4-${String(n).padStart(4, '0')}-4000-8000-000000000001`, ...condicion }],
        combinator: 'and',
      },
      options: {},
    },
    id: id(n),
    name: nombre,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: posicion,
  };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

function construirFlujoBase() {
  const nodos = [
    {
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } },
      id: id(1),
      name: 'Cada 5 minutos',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, -120],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 120] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    // Si la base de datos no responde, este nodo falla y el flujo se detiene: no se manda latido y el monitor externo avisa (es lo que se busca)
    nodoHttp(
      4,
      'Leer salud',
      [PASO * 2, 0],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/salud_sistema`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={}',
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),
    nodoHttp(5, 'Leer estado de alertas', [PASO * 3, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/vigilantes_estado?select=valor&clave=eq.latido`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    // Último mensaje que has ESCRITO tú (los ids de WhatsApp empiezan por "wamid."): decide si la ventana de 24 h sigue abierta
    nodoHttp(6, 'Leer último mensaje', [PASO * 4, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=created_at&wa_message_id=like.wamid.*&order=created_at.desc&limit=1`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    nodoCode(7, 'Evaluar', [PASO * 5, 0], 'evaluar.js'),
    nodoIf(8, '¿Avisar al monitor?', [PASO * 6, 0], { leftValue: '={{ $json.ping_url }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } }),
    // Un fallo del monitor externo no debe romper el flujo (lo que se pierde es el latido: el monitor ya lo notará por su lado)
    nodoHttp(9, 'Avisar al monitor', [PASO * 7, -120], { method: 'GET', url: '={{ $json.ping_url }}', options: { timeout: 10000 } }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput' }),
    nodoIf(10, '¿Enviar WhatsApp?', [PASO * 8, 0], { leftValue: `={{ ${EV}.enviar_whatsapp ? 'si' : 'no' }}`, rightValue: 'si', operator: { type: 'string', operation: 'equals' } }),
    // Sin onError: si Meta rechaza el envío la ejecución queda en rojo y "Guardar estado" NO se ejecuta (se reintenta en 5 minutos)
    nodoHttp(
      11,
      'Enviar WhatsApp',
      [PASO * 9, -120],
      {
        method: 'POST',
        url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/messages`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify(${EV}.cuerpo) }}`,
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),
    nodoHttp(
      12,
      'Guardar estado',
      [PASO * 10, -120],
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/vigilantes_estado?on_conflict=clave`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'resolution=merge-duplicates,return=minimal' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify(${EV}.estado_nuevo) }}`,
      },
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 },
    ),

    nota(101, -40, -420, PASO * 4, 240, 4, '## ① Qué comprueba\nCada **5 minutos** (o a mano) pregunta a la base de datos si hay algo **atascado**: eventos sin sincronizar con Calendar (+15 min), archivos o carpetas sin mover en Drive (+30 min), mensajes tuyos sin procesar y recordatorios que no avisaron a su hora. También compara el reloj del servidor con el de la base de datos.'),
    nota(102, PASO * 5 - 40, -420, PASO * 3 - 20, 240, 5, '## ② Aviso al monitor externo\nSi todo va bien, avisa a **HEALTHCHECK_URL_N8N** de que sigue vivo; si hay un problema, avisa a esa dirección + `/fail`. **Si este flujo, n8n o el servidor dejan de ejecutarse, el monitor deja de recibir latidos y te avisa él** (por correo): es la única forma de enterarte de que ha caído el propio sistema. Sin la variable, no avisa a nadie.'),
    nota(103, PASO * 8 - 40, -420, PASO * 3, 240, 6, '## ③ Aviso por WhatsApp\nSolo con la ventana de 24 h abierta (sin plantillas). Un problema nuevo avisa (con 30 min de margen entre avisos); el mismo problema se repite cada 6 h; al arreglarse manda un solo «Ya está todo en orden». El estado se guarda solo cuando se envía.'),
    nota(
      104,
      -40,
      300,
      PASO * 5,
      340,
      2,
      '## Antes de publicar\n1. **Base de datos** instalada en Supabase (`supabase/instalar.sql`).\n2. **Supabase API** en *Leer salud*, *Leer estado de alertas*, *Leer último mensaje* y *Guardar estado*; **Header Auth de WhatsApp** en *Enviar WhatsApp*.\n3. Identificadores: `SUPABASE_URL` y `WHATSAPP_PHONE_NUMBER_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n4. En el `.env` del servidor: `HEALTHCHECK_URL_N8N=` con la dirección de latido de tu monitor (la creas tú en su web) y `docker compose up -d` (no `restart`).\n5. Pruébalo con *Disparador manual*. Publica. *Options > Settings > Error workflow* → «Secretaria · Aviso de fallos».',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const conexiones = {
    'Cada 5 minutos': { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
    Configuración: { main: [[a('Leer salud')]] },
    'Leer salud': { main: [[a('Leer estado de alertas')]] },
    'Leer estado de alertas': { main: [[a('Leer último mensaje')]] },
    'Leer último mensaje': { main: [[a('Evaluar')]] },
    Evaluar: { main: [[a('¿Avisar al monitor?')]] },
    '¿Avisar al monitor?': { main: [[a('Avisar al monitor')], [a('¿Enviar WhatsApp?')]] },
    'Avisar al monitor': { main: [[a('¿Enviar WhatsApp?')]] },
    '¿Enviar WhatsApp?': { main: [[a('Enviar WhatsApp')], []] },
    'Enviar WhatsApp': { main: [[a('Guardar estado')]] },
  };

  return { name: NOMBRE_FLUJO, nodes: nodos, connections: conexiones, pinData: {}, settings: { executionOrder: 'v1', timezone: 'Europe/Madrid' } };
}

function generar() {
  const flujo = construirFlujo();
  fs.writeFileSync(SALIDA, JSON.stringify(flujo, null, 2) + '\n', 'utf8');
  console.log(`Escrito ${path.relative(RAIZ, SALIDA)}: ${flujo.nodes.length} nodos.`);
}

// Ids fijos, credenciales por nombre, subflujo y Error workflow ya elegidos (herramientas/comun/importacion.js)
function construirFlujo() {
  return prepararImportacion(construirFlujoBase(), SALIDA);
}

module.exports = { construirFlujo, generar };

if (require.main === module) generar();
