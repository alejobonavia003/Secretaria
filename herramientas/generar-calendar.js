// Genera flujos/sincronizar-calendar.json (el flujo que lleva los eventos de Supabase a Google Calendar) a partir de:
//   - herramientas/flujo-calendar/*.js   código de los nodos Code (y comun.js, que se inserta donde aparece /*__COMUN__*/)
// Uso: node herramientas/generar-calendar.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'sincronizar-calendar.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Sincronizar Calendar';
const MARCADOR_COMUN = '/*__COMUN__*/';

const fallar = (msg) => {
  throw new Error(`generar-calendar: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

// split/join y no String.replace: el texto sustituido puede contener "$&" o "$1"
function sustituir(codigo, marcador, valor, nodo) {
  const trozos = codigo.split(marcador);
  if (trozos.length !== 2) fallar(`el marcador ${marcador} debe aparecer exactamente una vez en ${nodo} (aparece ${trozos.length - 1})`);
  return trozos.join(valor);
}

// Los nodos usan "return" al nivel superior y variables de n8n: se comprueba que compilan
function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', 'DateTime', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `5ec7e7a2-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240;

function nodoCode(n, nombre, posicion, archivo, { conComun = false } = {}) {
  let codigo = leer(ruta('herramientas', 'flujo-calendar', archivo));
  if (conComun) codigo = sustituir(codigo, MARCADOR_COMUN, leer(ruta('herramientas', 'flujo-calendar', 'comun.js')).trimEnd(), nombre);
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };

function construirFlujoBase() {
  // Posiciones: la rama de Google arriba y la de omitidos abajo (con la ejecución "v1" se recorre de arriba abajo)
  const ARRIBA = -120;
  const ABAJO = 160;
  // La rama de borrados va en su propia fila, con la nota ④ encima y sin tapar «Planificar omitidos» (fila de ABAJO)
  const FILA_BORRADOS = ABAJO * 3 + 40;

  const nodos = [
    {
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
      id: id(1),
      name: 'Programación',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, ARRIBA],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, ABAJO] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    // Con nada pendiente devuelve cero items y el flujo se para: Always Output Data lo evita
    nodoHttp(
      4,
      'Leer pendientes',
      [PASO * 2, 0],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/items?select=id,tipo,titulo,contenido,estado,fecha_inicio,fecha_fin,calendar_event_id,updated_at&calendar_pendiente=eq.true&order=updated_at.asc&limit={{ ${CFG}.lote }}`,
        ...supabase,
      },
      { alwaysOutputData: true },
    ),

    // Rama de Google
    nodoCode(5, 'Planificar sincronización', [PASO * 3, ARRIBA], 'planificar-sincronizacion.js', { conComun: true }),
    // Solo POST y PATCH, siempre con cuerpo. Devuelve la respuesta completa y no falla ante un error HTTP: así "Registrar"
    // ve el código de estado (409 al duplicar, 404 si el evento ya no existe).
    nodoHttp(
      6,
      'Google Calendar',
      [PASO * 4, ARRIBA],
      {
        method: '={{ $json.metodo }}',
        url: '={{ $json.url }}',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'googleCalendarOAuth2Api',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
        options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
      },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(7, 'Registrar', [PASO * 5, ARRIBA], 'registrar.js', { conComun: true }),

    // Rama de omitidos
    nodoCode(8, 'Planificar omitidos', [PASO * 3, ABAJO], 'planificar-omitidos.js', { conComun: true }),

    // Rama de borrados: el evento de un item ARCHIVADO (cancelado por el usuario) se borra de Calendar. Es la única excepción
    // a que este sistema no borra eventos. Nodo propio: el de arriba solo envía POST y PATCH con cuerpo; un DELETE no lleva.
    nodoCode(10, 'Planificar borrados', [PASO * 3, FILA_BORRADOS], 'planificar-borrados.js', { conComun: true }),
    nodoHttp(
      11,
      'Borrar en Google Calendar',
      [PASO * 4, FILA_BORRADOS],
      {
        method: 'DELETE',
        url: '={{ $json.url }}',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'googleCalendarOAuth2Api',
        options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
      },
      { onError: 'continueRegularOutput' },
    ),
    nodoCode(12, 'Registrar borrados', [PASO * 5, FILA_BORRADOS], 'registrar-borrados.js'),

    // Las dos ramas escriben aquí. Un fallo no corta el flujo: queda en el item.
    nodoHttp(
      9,
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
      },
      { onError: 'continueRegularOutput' },
    ),

    nota(101, -40, -420, PASO * 2 - 20, 200, 4, '## ① Disparo y configuración\nSe ejecuta **cada minuto** (Programación) o a mano (Disparador manual).\n**Configuración**: el único sitio con valores a mano (URL de Supabase, ID del calendario, minutos de aviso).'),
    nota(102, PASO * 2 - 40, -420, PASO, 200, 5, '## ② Pendientes\nLee los eventos marcados `calendar_pendiente` (lo marca un trigger de la base de datos al crear o cambiar un evento).'),
    nota(103, PASO * 3 - 40, -420, PASO * 3, 200, 6, '## ③ Google Calendar\n**Planificar** decide crear o actualizar. Google devuelve el código de estado; **Registrar** lo interpreta (409: ya existía; 404: ya no existe), limpia la marca con una condición sobre `updated_at` y calcula el aviso urgente por WhatsApp.'),
    nota(104, PASO * 3 - 40, FILA_BORRADOS - 60 - 180, PASO * 3, 180, 3, '## ④ Omitidos y borrados\n**Omitidos**: items que ya no se sincronizan (dejaron de ser evento, completados o sin fecha): solo se limpia la marca. **Borrados**: el evento de un item **archivado** (cancelado por el usuario) se borra de Calendar; es la única excepción a que este sistema no borra eventos.'),
    nota(105, PASO * 6 - 40, -420, PASO, 200, 7, '## ⑤ Escritura\nLas dos ramas terminan aquí: actualizan `items` en Supabase.'),
    nota(
      106,
      -40,
      340,
      PASO * 2,
      300,
      2,
      '## Antes de ejecutar\n1. Elige la credencial **Google Calendar OAuth2 API** en *Google Calendar* y en *Borrar en Google Calendar*, y la **Supabase API** en *Leer pendientes* y *Escribir en Supabase*.\n2. Identificadores: `SUPABASE_URL` y `GOOGLE_CALENDAR_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. Publica el flujo para que se ejecute cada minuto.',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const conexiones = {
    Programación: { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
    Configuración: { main: [[a('Leer pendientes')]] },
    // Misma salida a las dos ramas: la de Google (arriba) se ejecuta primero
    'Leer pendientes': { main: [[a('Planificar sincronización'), a('Planificar omitidos'), a('Planificar borrados')]] },
    'Planificar sincronización': { main: [[a('Google Calendar')]] },
    'Google Calendar': { main: [[a('Registrar')]] },
    Registrar: { main: [[a('Escribir en Supabase')]] },
    'Planificar omitidos': { main: [[a('Escribir en Supabase')]] },
    'Planificar borrados': { main: [[a('Borrar en Google Calendar')]] },
    'Borrar en Google Calendar': { main: [[a('Registrar borrados')]] },
    'Registrar borrados': { main: [[a('Escribir en Supabase')]] },
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
