// Genera flujos/reiniciar-todo.json (vacía Google Calendar y Drive para empezar de cero; la base de datos se vacía con SQL aparte) a partir de:
//   - herramientas/flujo-reinicio/*.js   código de los nodos Code
// Uso: node herramientas/generar-reinicio.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// SEGURIDAD: solo tiene Disparador manual (nada lo lanza solo); por defecto solo ENSAYA (CONFIRMAR vacío); a Drive lo manda a la
// PAPELERA (recuperable ~30 días), nunca borra definitivamente; solo toca lo que cuelga de la carpeta raíz y el calendario "Secretaria".
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'reiniciar-todo.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Reiniciar todo';

const fallar = (msg) => {
  throw new Error(`generar-reinicio: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `7e5e7e00-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const PASO = 240;
const CFG = "$('Configuración').first().json.config";
const drive = { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api' };
const calendar = { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleCalendarOAuth2Api' };
// La respuesta llega completa (statusCode) y un error HTTP no corta el flujo: Resumen cuenta los fallos. Se pide de 5 en 5 por segundo
// (Google limita las peticiones por segundo; el HTTP Request lanza todas a la vez si no se le dice otra cosa).
const BORRADO = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } }, batching: { batch: { batchSize: 5, batchInterval: 1000 } } };

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-reinicio', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nodoIf(n, nombre, posicion, izquierda, derecha) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: `a1b2c3d4-${String(n).padStart(4, "0")}-4000-8000-000000000001`, leftValue: izquierda, rightValue: derecha, operator: { type: 'string', operation: 'equals' } }],
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
  const urlRaiz =
    `={{ 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType)') + '&q=' + encodeURIComponent("'" + ${CFG}.carpeta_raiz_id + "' in parents and trashed=false") }}`;
  const urlEventos = `={{ 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(${CFG}.calendar_id) + '/events?maxResults=2500&showDeleted=false&fields=' + encodeURIComponent('nextPageToken,items(id,summary)') }}`;
  const urlBorrarEvento = `={{ 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(${CFG}.calendar_id) + '/events/' + encodeURIComponent($json.id) }}`;
  const urlPapelera = "={{ 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent($json.id) + '?supportsAllDrives=true' }}";

  const nodos = [
    { parameters: {}, id: id(1), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
    nodoCode(2, 'Configuración', [PASO, 0], 'configuracion.js'),
    nodoHttp(3, 'Leer raíz de Drive', [PASO * 2, 0], { method: 'GET', url: urlRaiz, ...drive }, { alwaysOutputData: true }),
    nodoCode(4, 'Planificar raíz', [PASO * 3, 0], 'planificar-raiz.js'),
    nodoHttp(5, 'Leer contenido de las carpetas', [PASO * 4, 0], { method: 'GET', url: '={{ $json.url }}', ...drive }, { alwaysOutputData: true }),
    nodoHttp(6, 'Leer eventos de Calendar', [PASO * 5, 0], { method: 'GET', url: urlEventos, ...calendar }, { executeOnce: true, alwaysOutputData: true }),
    nodoCode(7, 'Reunir y decidir', [PASO * 6, 0], 'reunir.js'),
    nodoIf(8, '¿Borrar de verdad?', [PASO * 7, 0], "={{ $json.modo }}", 'real'),
    nodoIf(9, '¿Es de Drive?', [PASO * 8, -120], "={{ $json.tipo }}", 'drive'),
    nodoHttp(
      10,
      'Mandar a la papelera de Drive',
      [PASO * 9, -240],
      { method: 'PATCH', url: urlPapelera, ...drive, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ trashed: true }) }}', options: BORRADO },
      { onError: 'continueRegularOutput' },
    ),
    nodoHttp(11, 'Borrar evento de Calendar', [PASO * 9, 0], { method: 'DELETE', url: urlBorrarEvento, ...calendar, options: BORRADO }, { onError: 'continueRegularOutput' }),
    nodoCode(12, 'Resumen', [PASO * 10, 0], 'resumen.js'),

    nota(101, -40, -580, PASO * 3, 280, 4, '## ① Configuración y lectura de Drive\n**Se lanza solo a mano.** En *Configuración* pon el ID del calendario y el de la carpeta raíz. **CONFIRMAR vacío = ENSAYO** (lista lo que borraría, no toca nada).\n*Leer raíz de Drive* y *Planificar raíz* deciden qué cuelga de la raíz y qué carpetas se conservan (`Entrada`, `Notas`).'),
    nota(102, PASO * 4 - 40, -580, PASO * 3, 280, 5, '## ② Lo que se borraría\n*Leer contenido de las carpetas* lista lo de dentro de las carpetas conservadas; *Leer eventos de Calendar*, todos los eventos del calendario. *Reunir y decidir* lo junta y, en ensayo, devuelve solo el informe.'),
    nota(103, PASO * 7 - 40, -580, PASO * 3, 280, 6, '## ③ Borrado\nSolo con `BORRAR TODO`. Drive: **a la papelera** (se recupera unos 30 días), nunca definitivo. Calendar: se borran los eventos (el calendario se queda). De 5 en 5 por segundo. *Resumen* cuenta lo hecho y los fallos.'),
    nota(
      104,
      -40,
      300,
      PASO * 4,
      300,
      2,
      '## Antes de ejecutar\n1. Credenciales: **Google Drive OAuth2** en *Leer raíz de Drive*, *Leer contenido de las carpetas* y *Mandar a la papelera de Drive*; **Google Calendar OAuth2** en *Leer eventos de Calendar* y *Borrar evento de Calendar*.\n2. Identificadores: `GOOGLE_CALENDAR_ID` y `DRIVE_CARPETA_RAIZ_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. **Orden**: antes de nada **desactiva «Vigilar Drive» y «Vigilar Calendar»** (si no, avisarían de que has «borrado» todo); primero vacía la base de datos con el SQL (`supabase/consultas/vaciar-datos.sql`); después ejecuta este flujo EN ENSAYO, revisa el *Resumen*, y solo entonces escribe `BORRAR TODO` y ejecútalo.\n4. Deja `CONFIRMAR` vacío al terminar. No lo publiques. Después vuelve a activar «Vigilar Drive» y «Vigilar Calendar».',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const conexiones = {
    'Disparador manual': { main: [[a('Configuración')]] },
    Configuración: { main: [[a('Leer raíz de Drive')]] },
    'Leer raíz de Drive': { main: [[a('Planificar raíz')]] },
    'Planificar raíz': { main: [[a('Leer contenido de las carpetas')]] },
    'Leer contenido de las carpetas': { main: [[a('Leer eventos de Calendar')]] },
    'Leer eventos de Calendar': { main: [[a('Reunir y decidir')]] },
    'Reunir y decidir': { main: [[a('¿Borrar de verdad?')]] },
    '¿Borrar de verdad?': { main: [[a('¿Es de Drive?')], [a('Resumen')]] },
    '¿Es de Drive?': { main: [[a('Mandar a la papelera de Drive')], [a('Borrar evento de Calendar')]] },
    'Mandar a la papelera de Drive': { main: [[a('Resumen')]] },
    'Borrar evento de Calendar': { main: [[a('Resumen')]] },
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
