// Genera flujos/vigilar-calendar.json (detecta lo que se hace A MANO en Google Calendar: borrar, mover, renombrar o crear un evento; lo anota en la
// base de datos y avisa por WhatsApp) a partir de:
//   - herramientas/flujo-vigilar-calendar/*.js   código de los nodos Code
// Uso: node herramientas/generar-vigilar-calendar.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// El flujo NUNCA escribe, mueve ni borra nada en Google Calendar: solo lee. Las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'vigilar-calendar.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Vigilar Calendar';

const fallar = (msg) => {
  throw new Error(`generar-vigilar-calendar: ${msg}`);
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

const id = (n) => `7e5e7e20-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const PASO = 240;
const CFG = "$('Configuración').first().json.config";
const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };
const calendar = { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleCalendarOAuth2Api' };
// Las escrituras van de una en una y en orden (el HTTP Request lanza todas a la vez si no se le dice otra cosa): el estado, el último.
const UNO_A_UNO = { batching: { batch: { batchSize: 1, batchInterval: 100 } } };
const CAMPOS_EVENTOS = encodeURIComponent('nextPageToken,items(id,status,summary,description,start,end,updated,recurrence,recurringEventId,extendedProperties/private)');

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-vigilar-calendar', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

// Desde cuándo se pregunta a Google: la hora de la última pasada menos un margen. La primera vez (sin estado) vale "ahora": no se importa nada.
const updatedMin = `new Date((Date.parse($('Leer estado').first().json.valor?.ultima) || Date.now()) - ${CFG}.margen_min * 60000).toISOString()`;
const urlEventos = `={{ 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(${CFG}.calendar_id) + '/events?maxResults=2500&showDeleted=true&updatedMin=' + encodeURIComponent(${updatedMin}) + '&fields=${CAMPOS_EVENTOS}' }}`;

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
    // Las lecturas pueden devolver varias filas (o ninguna): executeOnce y alwaysOutputData. Si una lectura FALLA el flujo se detiene con
    // error (no se usa continueRegularOutput): con datos a medias no se debe decidir nada.
    nodoHttp(4, 'Leer estado', [PASO * 2, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/vigilantes_estado?select=valor&clave=eq.calendar`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    nodoHttp(
      5,
      'Leer eventos de la base',
      [PASO * 3, 0],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/items?select=id,titulo,contenido,estado,fecha_inicio,fecha_fin,calendar_event_id,calendar_pendiente,updated_at&tipo=eq.evento&estado=in.(pendiente,hecho)&or=(fecha_inicio.gte."{{ new Date(Date.now() - 30 * 86400000).toISOString() }}",fecha_inicio.is.null)&limit=1000`,
        ...supabase,
      },
      { executeOnce: true, alwaysOutputData: true },
    ),
    // Solo lectura. Devuelve lo cambiado desde la última pasada, incluidos los eventos borrados (status "cancelled")
    nodoHttp(6, 'Leer eventos de Calendar', [PASO * 4, 0], { method: 'GET', url: urlEventos, ...calendar }, { executeOnce: true }),
    nodoCode(7, 'Comparar', [PASO * 5, 0], 'comparar.js'),
    // Sin onError: si una escritura falla la ejecución queda en rojo y las siguientes (el estado, la última) no se hacen
    nodoHttp(
      8,
      'Escribir en Supabase',
      [PASO * 6, 0],
      {
        method: '={{ $json.metodo }}',
        url: '={{ $json.url }}',
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: '={{ $json.prefer }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
        options: UNO_A_UNO,
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),
    // Los cambios sin avisar (también los de pasadas anteriores si la ventana de 24 h estaba cerrada)
    nodoHttp(
      9,
      'Leer sin avisar',
      [PASO * 7, 0],
      { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/registro_calendar?select=id,created_at,tipo,titulo,detalle&notificado_at=is.null&order=created_at.asc&limit=100`, ...supabase },
      { executeOnce: true, alwaysOutputData: true },
    ),
    // Último mensaje que has ESCRITO tú (los ids de WhatsApp empiezan por "wamid."): decide si la ventana de 24 h sigue abierta
    nodoHttp(10, 'Leer último mensaje', [PASO * 8, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=created_at&wa_message_id=like.wamid.*&order=created_at.desc&limit=1`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    nodoCode(11, 'Redactar aviso', [PASO * 9, 0], 'redactar.js'),
    // Sin onError: si Meta rechaza el envío la ejecución queda en rojo y "Marcar avisados" NO se ejecuta (se reintenta en 5 minutos)
    nodoHttp(
      12,
      'Enviar WhatsApp',
      [PASO * 10, 0],
      {
        method: 'POST',
        url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/messages`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),
    nodoHttp(
      13,
      'Marcar avisados',
      [PASO * 11, 0],
      {
        method: 'PATCH',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/registro_calendar?id=in.({{ $('Redactar aviso').first().json.ids.join(',') }})&notificado_at=is.null`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=minimal' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify($('Redactar aviso').first().json.marca) }}",
      },
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 },
    ),

    nota(101, -40, -420, PASO * 3, 240, 4, '## ① Disparo y lecturas\nCada **5 minutos** o a mano. Lee la hora de la **última pasada** y los eventos pendientes o hechos de la base de datos. La primera vez, solo guarda la hora: **no importa ni avisa de nada**.'),
    nota(102, PASO * 4 - 40, -420, PASO * 3 - 20, 240, 5, '## ② Qué cambió en Calendar\n*Leer eventos de Calendar* pide a Google solo lo **modificado desde la última pasada** (incluidos los borrados). Solo lectura: este flujo nunca escribe en Google Calendar. *Comparar* decide qué es obra del usuario y qué de la propia secretaria.'),
    nota(103, PASO * 7 - 40, -420, PASO * 5, 240, 6, '## ③ Registro y aviso\n*Escribir en Supabase* anota todo (de una en una; **el estado, el último**): archiva lo borrado, mueve o renombra lo cambiado e importa lo creado a mano; el flujo **Sincronizar Calendar** deja después el evento al día. Luego envía **un** WhatsApp con el detalle si escribiste hace menos de 23 h (sin plantillas); si no, los cambios esperan. Se marcan avisados solo si Meta acepta.'),
    nota(
      104,
      -40,
      300,
      PASO * 5,
      340,
      2,
      '## Antes de publicar\n1. **Base de datos** instalada en Supabase (`supabase/instalar.sql`).\n2. Credenciales: **Google Calendar OAuth2** en *Leer eventos de Calendar*; **Supabase API** en las lecturas, *Escribir en Supabase* y *Marcar avisados*; **Header Auth de WhatsApp** en *Enviar WhatsApp*.\n3. Identificadores: `SUPABASE_URL`, `WHATSAPP_PHONE_NUMBER_ID` y `GOOGLE_CALENDAR_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n4. Pruébalo con *Disparador manual* (la primera ejecución solo guarda la hora: `select * from vigilantes_estado`).\n5. Publica. **Prueba real**: crea, mueve, renombra y borra un evento a mano en el calendario «Secretaria» y ejecuta el flujo tras cada paso.\n6. *Options > Settings > Error workflow* → «Secretaria · Aviso de fallos».',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const cadena = ['Configuración', 'Leer estado', 'Leer eventos de la base', 'Leer eventos de Calendar', 'Comparar', 'Escribir en Supabase', 'Leer sin avisar', 'Leer último mensaje', 'Redactar aviso', 'Enviar WhatsApp', 'Marcar avisados'];
  const conexiones = {
    'Cada 5 minutos': { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
  };
  for (let i = 0; i < cadena.length - 1; i++) conexiones[cadena[i]] = { main: [[a(cadena[i + 1])]] };

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
