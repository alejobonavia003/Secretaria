// Genera flujos/vigilar-drive.json (detecta lo que se hace A MANO en Drive: borrar, mover, renombrar, crear carpetas y recuperar de la
// papelera; lo anota en la base de datos y avisa por WhatsApp) a partir de:
//   - herramientas/flujo-vigilar/*.js   código de los nodos Code
// Uso: node herramientas/generar-vigilar.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// El flujo NUNCA borra ni mueve nada en Drive: solo lee. Las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'vigilar-drive.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Vigilar Drive';

const fallar = (msg) => {
  throw new Error(`generar-vigilar: ${msg}`);
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

const id = (n) => `7e5e7e10-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const PASO = 240;
const CFG = "$('Configuración').first().json.config";
const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };
const drive = { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api' };
const CAMPOS_LISTA = encodeURIComponent('nextPageToken,files(id,name,mimeType,parents,appProperties)');
// Las escrituras van de una en una y en orden (el HTTP Request lanza todas a la vez si no se le dice otra cosa): la foto del árbol va la
// última y, si algo falla antes, no se escribe.
const UNO_A_UNO = { batching: { batch: { batchSize: 1, batchInterval: 100 } } };
// Confirmar con Drive: la respuesta llega completa (statusCode, body) porque un 404 es una respuesta válida ("borrado del todo")
const CONFIRMAR = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } }, batching: { batch: { batchSize: 5, batchInterval: 1000 } } };

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-vigilar', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

// Hijos (de cualquier tipo) de las carpetas del nivel anterior. Sin carpetas que consultar, una consulta válida que no puede devolver
// nada (Drive contesta 404 a un id inventado). Se pide nextPageToken: "Comparar" para si hay más de una página.
const urlNivel = (nodoAnterior) =>
  `={{ 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${CAMPOS_LISTA}&q=' + encodeURIComponent("trashed = false and (" + ((($('${nodoAnterior}').first().json.files || []).filter((f) => f.mimeType === 'application/vnd.google-apps.folder').map((f) => "'" + f.id + "' in parents").join(' or ')) || ("'" + ${CFG}.carpeta_raiz_id + "' in parents and name = 'a' and name != 'a'")) + ")") }}`;
const urlRaiz = `={{ 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${CAMPOS_LISTA}&q=' + encodeURIComponent("trashed = false and '" + ${CFG}.carpeta_raiz_id + "' in parents") }}`;

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
    // Las lecturas devuelven varias filas; executeOnce en cada nodo que las sigue evita repetirlo una vez por fila. Si una lectura FALLA el
    // flujo se detiene con error (no se usa continueRegularOutput): con datos a medias no se debe decidir nada.
    nodoHttp(
      4,
      'Leer foto del árbol',
      [PASO * 2, 0],
      { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/drive_arbol?select=drive_id,tipo,nombre,padre_id,ruta,origen,visto_at,eliminado_at,updated_at&limit=1000`, ...supabase },
      { executeOnce: true, alwaysOutputData: true },
    ),
    nodoHttp(
      5,
      'Leer archivos registrados',
      [PASO * 3, 0],
      { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/archivos?select=drive_file_id,nombre,carpeta_id,drive_pendiente,eliminado_at&limit=1000`, ...supabase },
      { executeOnce: true, alwaysOutputData: true },
    ),
    nodoHttp(6, 'Listar nivel 1', [PASO * 4, 0], { method: 'GET', url: urlRaiz, ...drive }, { executeOnce: true }),
    nodoHttp(7, 'Listar nivel 2', [PASO * 5, 0], { method: 'GET', url: urlNivel('Listar nivel 1'), ...drive }, { executeOnce: true }),
    nodoHttp(8, 'Listar nivel 3', [PASO * 6, 0], { method: 'GET', url: urlNivel('Listar nivel 2'), ...drive }, { executeOnce: true }),
    nodoHttp(9, 'Listar nivel 4', [PASO * 7, 0], { method: 'GET', url: urlNivel('Listar nivel 3'), ...drive }, { executeOnce: true }),
    nodoCode(10, 'Comparar', [PASO * 8, 0], 'comparar.js'),
    // Solo lecturas. Un 404 o un trashed es una respuesta (no un error); otros fallos los trata "Decidir" como "sin certeza".
    nodoHttp(11, 'Confirmar en Drive', [PASO * 9, 0], { method: 'GET', url: '={{ $json.url }}', ...drive, options: CONFIRMAR }, { onError: 'continueRegularOutput' }),
    nodoCode(12, 'Decidir', [PASO * 10, 0], 'decidir.js'),
    // Sin onError: si una escritura falla la ejecución queda en rojo y las siguientes (la foto, la última) no se hacen
    nodoHttp(
      13,
      'Escribir en Supabase',
      [PASO * 11, 0],
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
      14,
      'Leer sin avisar',
      [PASO * 12, 0],
      { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/registro_drive?select=id,created_at,tipo,nombre,ruta_antes,ruta_despues,detalle&notificado_at=is.null&order=created_at.asc&limit=100`, ...supabase },
      { executeOnce: true, alwaysOutputData: true },
    ),
    // Último mensaje que has ESCRITO tú (los ids de WhatsApp empiezan por "wamid."): decide si la ventana de 24 h sigue abierta
    nodoHttp(15, 'Leer último mensaje', [PASO * 13, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=created_at&wa_message_id=like.wamid.*&order=created_at.desc&limit=1`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    nodoCode(16, 'Redactar aviso', [PASO * 14, 0], 'redactar.js'),
    // Sin onError: si Meta rechaza el envío la ejecución queda en rojo y "Marcar avisados" NO se ejecuta (se reintenta en 5 minutos)
    nodoHttp(
      17,
      'Enviar WhatsApp',
      [PASO * 15, 0],
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
      18,
      'Marcar avisados',
      [PASO * 16, 0],
      {
        method: 'PATCH',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/registro_drive?id=in.({{ $('Redactar aviso').first().json.ids.join(',') }})&notificado_at=is.null`,
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

    nota(101, -40, -420, PASO * 3, 240, 4, '## ① Disparo y lecturas\nCada **5 minutos** o a mano. Lee la **foto del árbol** que guardó la última vez y los archivos que la secretaria tiene registrados. La primera vez, la foto está vacía: se guarda **sin avisar de nada**.'),
    nota(102, PASO * 4 - 40, -420, PASO * 4, 240, 5, '## ② Drive ahora\nLista cuatro niveles bajo la carpeta *Secretaria* (carpetas, subcarpetas y archivos). Si Drive devuelve más de una página, el flujo **se para sin tocar nada**.'),
    nota(103, PASO * 8 - 40, -420, PASO * 3 - 20, 240, 6, '## ③ Comparar y decidir\n*Comparar* detecta carpetas creadas, movidas, renombradas, recuperadas y lo que **desapareció**. Lo que desapareció se confirma con Drive (*Confirmar en Drive*, solo lectura): papelera, borrado del todo o solo fuera de lo vigilado. *Decidir* arma las escrituras.'),
    nota(104, PASO * 11 - 40, -420, PASO * 6, 240, 7, '## ④ Registro y aviso\n*Escribir en Supabase* anota todo (de una en una; **la foto, la última**). Luego envía **un** WhatsApp con el detalle si escribiste hace menos de 23 h (sin plantillas); si no, los cambios esperan y se avisan cuando vuelvas a escribir. Se marcan como avisados solo si Meta acepta.'),
    nota(
      105,
      -40,
      300,
      PASO * 5,
      340,
      2,
      '## Antes de publicar\n1. **Base de datos** instalada en Supabase (`supabase/instalar.sql`).\n2. Credenciales: **Google Drive OAuth2** en *Listar nivel 1 a 4* y *Confirmar en Drive*; **Supabase API** en las lecturas, *Escribir en Supabase* y *Marcar avisados*; **Header Auth de WhatsApp** en *Enviar WhatsApp*.\n3. Identificadores: `SUPABASE_URL`, `WHATSAPP_PHONE_NUMBER_ID` y `DRIVE_CARPETA_RAIZ_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n4. Pruébalo con *Disparador manual* (la primera ejecución solo guarda la foto). Comprueba `select count(*) from drive_arbol`.\n5. Publica. Para la **prueba real**: crea una carpeta a mano en Drive, ejecuta de nuevo y mira el WhatsApp.\n6. *Options > Settings > Error workflow* → «Secretaria · Aviso de fallos».',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const cadena = ['Configuración', 'Leer foto del árbol', 'Leer archivos registrados', 'Listar nivel 1', 'Listar nivel 2', 'Listar nivel 3', 'Listar nivel 4', 'Comparar', 'Confirmar en Drive', 'Decidir', 'Escribir en Supabase', 'Leer sin avisar', 'Leer último mensaje', 'Redactar aviso', 'Enviar WhatsApp', 'Marcar avisados'];
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
