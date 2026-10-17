// Genera flujos/procesar-mensaje.json (el flujo real) a partir de:
//   - herramientas/flujo/*.js   código de los nodos Code
//   - prompts/clasificador.md   prompt de trabajo
// Uso: node herramientas/generar-flujo.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'procesar-mensaje.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Procesar mensaje';

const fallar = (msg) => {
  throw new Error(`generar-flujo: ${msg}`);
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

// Los comandos y frases fijas (/help, «cómo te llamas», «qué tengo hoy»…) los reconoce "Planificar" sin el modelo. Para no pagar la
// espera de Gemini en esos mensajes, "Construir petición" tiene que saberlo ANTES de llamar al modelo: se le inyecta la MISMA sección
// de planificar.js (de «// --- Comandos y ayuda» a «// --- Alarmas y citas»), dentro de una función con sus tres dependencias, para
// que los dos nodos decidan siempre igual. Lo usan también las pruebas.
function codigoComandos(planificar = leer(ruta('herramientas', 'flujo', 'planificar.js'))) {
  const lineas = planificar.split('\n');
  const ini = lineas.findIndex((l) => l.startsWith('// --- Comandos y ayuda'));
  const fin = lineas.findIndex((l) => l.startsWith('// --- Alarmas y citas'));
  if (ini < 0 || fin <= ini) fallar('no se encuentra la sección de comandos en planificar.js');
  // Una constante de nivel superior, desde «const X =» hasta la primera línea que acaba en «;»
  const constante = (nombre) => {
    const i = lineas.findIndex((l) => l.startsWith(`const ${nombre} =`));
    if (i < 0) fallar(`no se encuentra «const ${nombre}» en planificar.js`);
    const j = lineas.findIndex((l, k) => k >= i && l.trimEnd().endsWith(';'));
    return lineas.slice(i, j + 1).join('\n');
  };
  return [
    '(() => {',
    constante('sinAcentos'),
    constante('diaMadrid'),
    constante('NOMBRE_TERMINO'),
    lineas.slice(ini, fin).join('\n'),
    'return { interpretarComando, interpretarAplazamiento, pideListarRepetidos, elegirPregunta, siNoSinPregunta, pideBorrarTodo, seccionElegida, respuestaConfirmacion };',
    '})()',
  ].join('\n');
}

const id = (n) => `5ec7e7a1-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240; // separación horizontal entre nodos

function nodoCode(n, nombre, x, archivo, sustituciones = []) {
  let codigo = leer(ruta('herramientas', 'flujo', archivo));
  for (const [marcador, valor] of sustituciones) codigo = sustituir(codigo, marcador, valor, nombre);
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 0] };
}

function nodoHttp(n, nombre, x, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [x, 0], ...extra };
}

const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };
const driveAuth = { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api' };
// Respuesta completa (statusCode, body) sin fallar ante un HTTP de error: lo interpreta el código de "Resultado"
const RESPUESTA_COMPLETA = { response: { response: { fullResponse: true, neverError: true } } };
const FILA_CARPETAS = 300; // la rama de la lista de carpetas va en una fila propia, debajo del flujo principal

// Carpetas hijas de una o varias carpetas (solo carpetas, sin papelera) en una sola consulta: ('a' in parents or 'b' in parents).
// Es la misma consulta que usa "Sincronizar Drive". Se pide nextPageToken: si Drive pagina, "Resultado" se detiene en vez de
// enseñar un árbol incompleto.
const urlNivel = (expresionIds) =>
  `={{ 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&fields=' + encodeURIComponent('nextPageToken,files(id,name,parents)') + '&q=' + encodeURIComponent("mimeType = 'application/vnd.google-apps.folder' and trashed = false and (" + ((${expresionIds}).map((id) => "'" + id + "' in parents").join(' or ') || ("'" + ${CFG}.carpeta_raiz_id + "' in parents and name = 'a' and name != 'a'")) + ")") }}`;
const idsDe = (nodo) => `($('${nodo}').first().json.body?.files || []).map((f) => f.id)`;

function nota(n, x, ancho, color, contenido, y = -300, alto = 240) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

// Orden de los nodos de trabajo: la posición horizontal de cada uno sale de aquí
const ORDEN = [
  'Disparador manual',
  'Configuración',
  'Entrada',
  'Guardar mensaje',
  'Leer memoria',
  'Leer items pendientes',
  'Leer pregunta pendiente',
  'Leer archivos',
  'Leer proyectos',
  'Leer avisos',
  'Construir petición',
  '¿Hace falta el modelo?',
  'Modelo',
  'Planificar',
  'Escribir en Supabase',
  'Leer consulta',
  '¿Listar carpetas?',
  'Resultado',
  '¿Anotar fallo?',
  'Anotar fallo',
  'Entregar',
];
const x = (nombre) => ORDEN.indexOf(nombre) * PASO;

function construirFlujoBase() {
  const prompt = leer(ruta('prompts', 'clasificador.md')).trimEnd();

  const nodos = [
    { parameters: {}, id: id(1), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [x('Disparador manual'), 0] },
    // Lo llama el flujo "Secretaria · WhatsApp" con { mensaje, wa_message_id, tipo_entrada }. "Entrada" lo lee por este nombre.
    // Acepta todos los datos: la validación está en "Entrada", que es la frontera.
    { parameters: { inputSource: 'passthrough' }, id: id(14), name: 'Al ser llamado', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [x('Disparador manual'), 200] },
    nodoCode(2, 'Configuración', x('Configuración'), 'configuracion.js'),
    nodoCode(3, 'Entrada', x('Entrada'), 'entrada.js'),
    // Upsert por wa_message_id: un mensaje de WhatsApp ya está guardado (lo metió en la cola el flujo de WhatsApp, que es quien junta
    // los mensajes seguidos y da el turno); aquí se completa su fila con el texto que se procesa (los mensajes juntados) y se recupera
    // su id. Una prueba manual (wa_message_id «manual-…») crea la fila.
    nodoHttp(4, 'Guardar mensaje', x('Guardar mensaje'), {
      method: 'POST',
      url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?on_conflict=wa_message_id`,
      ...supabase,
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Prefer', value: 'resolution=merge-duplicates,return=representation' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ wa_message_id: $json.wa_message_id, tipo_entrada: $json.tipo_entrada, texto_original: $json.mensaje, contexto_wa_id: $json.contexto_id || null }) }}',
    }),
    // Con la tabla vacía devuelve cero items y el flujo se pararía: Always Output Data lo evita
    nodoHttp(
      5,
      'Leer memoria',
      x('Leer memoria'),
      { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/memoria?select=termino,significado&order=termino.asc`, ...supabase },
      { alwaysOutputData: true },
    ),
    // Todos los items pendientes (tope de 200), para que el modelo pueda referirse a cualquiera al corregir o completar
    nodoHttp(
      11,
      'Leer items pendientes',
      x('Leer items pendientes'),
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/items?select=id,tipo,titulo,contenido,lista,estado,fecha_inicio,fecha_fin,fecha_limite,recordar_en,proyecto&estado=eq.pendiente&order=created_at.desc&limit=200`,
        ...supabase,
      },
      { alwaysOutputData: true },
    ),
    // ¿Hay una pregunta de la secretaria esperando respuesta? Solo cuenta si es reciente (caducidad_min, 30 por defecto):
    // la hora límite se calcula aquí, en la propia URL. Casi siempre no hay ninguna, de ahí Always Output Data.
    nodoHttp(
      13,
      'Leer pregunta pendiente',
      x('Leer pregunta pendiente'),
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=id,pregunta,hilo&pregunta_pendiente=eq.true&created_at=gte.{{ new Date(Date.now() - ${CFG}.caducidad_min * 60000).toISOString() }}&order=created_at.desc&limit=3`,
        ...supabase,
      },
      { alwaysOutputData: true },
    ),
    // Los 60 archivos recibidos más recientes (pendientes o no), con el mensaje del que vienen: de ahí salen los pendientes de
    // clasificar que ve el modelo y el archivo al que se refiere el usuario cuando responde a una foto o a su confirmación.
    nodoHttp(
      15,
      'Leer archivos',
      x('Leer archivos'),
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/archivos?select=id,nombre,estado,carpeta_destino,respuesta_wa_id,created_at,drive_url,mensajes(wa_message_id,texto_original)&eliminado_at=is.null&order=created_at.desc&limit=60`,
        ...supabase,
      },
      { alwaysOutputData: true },
    ),
    // Los proyectos que existen, con su estado y lo pendiente de cada uno (función resumen_proyectos). Si falla, el flujo
    // sigue sin proyectos conocidos.
    nodoHttp(
      32,
      'Leer proyectos',
      x('Leer proyectos'),
      { method: 'POST', url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/resumen_proyectos`, ...supabase, sendBody: true, specifyBody: 'json', jsonBody: '{}' },
      { alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    // El aviso de WhatsApp al que responde el usuario (si responde a uno) y las alarmas que sonaron hace poco (función contexto_avisos):
    // para «10 minutos más» o «muévela a las 12» respondiendo a un aviso. Si falla, el flujo
    // sigue sin ese contexto.
    nodoHttp(
      26,
      'Leer avisos',
      x('Leer avisos'),
      {
        method: 'POST',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/rpc/contexto_avisos`,
        ...supabase,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ p_wa_message_id: $('Entrada').first().json.contexto_id || '' }) }}",
      },
      { alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    nodoCode(6, 'Construir petición', x('Construir petición'), 'construir-peticion.js', [
      ['__PROMPT__', JSON.stringify(prompt)],
      ['__COMANDOS__', codigoComandos()],
    ]),
    // Un comando, una frase fija («cómo te llamas», «qué tengo hoy») o la primera pregunta del nombre los resuelve "Planificar" sin el
    // modelo: no se llama a Gemini (se ahorran su espera, que puede pasar de 30 s, y su coste). "Planificar" recibe entonces la salida
    // de "Construir petición" con saltar_modelo.
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { id: 'a1b2c3d4-0025-4000-8000-000000000001', leftValue: "={{ $json.saltar_modelo === true ? 'no' : 'si' }}", rightValue: 'si', operator: { type: 'string', operation: 'equals' } },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: id(25),
      name: '¿Hace falta el modelo?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [x('¿Hace falta el modelo?'), 0],
    },
    // Tres intentos con 5 s de espera. Un error no detiene el flujo: llega a "Planificar" como { error }
    nodoHttp(
      7,
      'Modelo',
      x('Modelo'),
      {
        method: 'POST',
        url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ $json.modelo }}:generateContent',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
        options: { timeout: 120000 },
      },
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' },
    ),
    nodoCode(8, 'Planificar', x('Planificar'), 'planificar.js'),
    // Un item por petición. Un fallo no corta el flujo: queda en el item y lo recoge "Resultado".
    // Solo escribe (POST y PATCH): "Send Body" no admite expresiones, así que los GET van en "Leer consulta".
    // IMPORTANTE: el nodo lanza TODAS las peticiones a la vez y no espera a ninguna para lanzar la siguiente. El Batching no lo
    // cambia (solo retrasa el arranque de cada tanda; se comprobó leyendo su implementación). Por eso ninguna petición puede
    // depender de otra: lo que sí depende (crear un item y colgarle archivos) va en UNA petición, a la función de la base de datos
    // guardar_con_archivos.
    nodoHttp(
      9,
      'Escribir en Supabase',
      x('Escribir en Supabase'),
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
    // Se ejecuta una vez por mensaje. Con intención "consultar" lee la lista pedida; con las demás,
    // una lectura inocua del mensaje recién guardado (así no hace falta un nodo IF ni un Merge).
    nodoHttp(
      12,
      'Leer consulta',
      x('Leer consulta'),
      { method: 'GET', url: "={{ $('Planificar').first().json.meta.consulta_url }}", ...supabase },
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
    // Solo con la intención "carpetas": lee el árbol de Secretaria/ en Drive (tres niveles, un listado por nivel) y cuenta los
    // archivos de cada carpeta. En el resto, el flujo pasa directo a "Resultado".
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { id: 'a1b2c3d4-0016-4000-8000-000000000001', leftValue: "={{ $('Planificar').first().json.meta.carpetas ? 'si' : 'no' }}", rightValue: 'si', operator: { type: 'string', operation: 'equals' } },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: id(16),
      name: '¿Listar carpetas?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [x('¿Listar carpetas?'), 0],
    },
    nodoHttp(17, 'Listar nivel 1', x('¿Listar carpetas?') + PASO, { method: 'GET', url: urlNivel(`[${CFG}.carpeta_raiz_id]`), ...driveAuth, options: RESPUESTA_COMPLETA }, { onError: 'continueRegularOutput', executeOnce: true, position: [x('¿Listar carpetas?') + PASO, FILA_CARPETAS] }),
    nodoHttp(18, 'Listar nivel 2', x('¿Listar carpetas?') + PASO * 2, { method: 'GET', url: urlNivel(idsDe('Listar nivel 1')), ...driveAuth, options: RESPUESTA_COMPLETA }, { onError: 'continueRegularOutput', executeOnce: true, position: [x('¿Listar carpetas?') + PASO * 2, FILA_CARPETAS] }),
    nodoHttp(19, 'Listar nivel 3', x('¿Listar carpetas?') + PASO * 3, { method: 'GET', url: urlNivel(idsDe('Listar nivel 2')), ...driveAuth, options: RESPUESTA_COMPLETA }, { onError: 'continueRegularOutput', executeOnce: true, position: [x('¿Listar carpetas?') + PASO * 3, FILA_CARPETAS] }),
    nodoHttp(20, 'Contar archivos', x('¿Listar carpetas?') + PASO * 4, { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/archivos?select=carpeta_id,estado&eliminado_at=is.null&limit=5000`, ...supabase }, { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput', position: [x('¿Listar carpetas?') + PASO * 4, FILA_CARPETAS] }),
    nodoCode(10, 'Resultado', x('Resultado'), 'resultado.js'),
    // Constancia del fallo (bloque A de la fase de cierre): si Resultado detectó un error DESPUÉS de Planificar (una escritura o
    // una lectura que falló), lo anota en mensajes.error; sin esto el mensaje quedaba como procesado y sin motivo. Un fallo de
    // Planificar o del modelo ya lo deja Planificar en la misma fila.
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { id: 'a1b2c3d4-0022-4000-8000-000000000001', leftValue: "={{ $json.anotacion ? 'si' : 'no' }}", rightValue: 'si', operator: { type: 'string', operation: 'equals' } },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: id(22),
      name: '¿Anotar fallo?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [x('¿Anotar fallo?'), 0],
    },
    nodoHttp(
      23,
      'Anotar fallo',
      x('Anotar fallo'),
      {
        method: 'PATCH',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?id=eq.{{ $('Guardar mensaje').first().json.id }}`,
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=minimal' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.anotacion) }}',
      },
      { onError: 'continueRegularOutput', executeOnce: true, position: [x('Anotar fallo'), -180] },
    ),
    nodoCode(24, 'Entregar', x('Entregar'), 'entregar.js'),

    // Notas de sección: cada una cubre las columnas de sus nodos
    nota(101, x('Configuración') - 40, PASO * 2, 4, '## ① Entrada y configuración\n**Configuración**: el único sitio con valores a mano (modelo, URL de Supabase, espera de archivo).\n**Entrada**: contrato con el núcleo (`mensaje`, `fecha_actual`, `wa_message_id`, `tipo_entrada`). Lee la llamada del flujo de WhatsApp (nodo **Al ser llamado**) o, en una prueba manual, la constante `MENSAJE`.'),
    nota(102, x('Guardar mensaje') - 40, PASO * 3, 5, '## ② Contexto\nEl mensaje se guarda **antes** de nada (si viene de WhatsApp ya estaba en la cola: se completa su fila): si algo falla después, no se pierde.\nLuego se leen la memoria (términos que el usuario ha enseñado), los archivos recibidos (a1, a2… y, si el usuario respondió a una foto o a su confirmación, cuál es), todos los items pendientes (el modelo se refiere a ellos con `i1`, `i2`… al corregir o completar) y la **pregunta pendiente** reciente, si la hay: su hilo se devuelve al modelo para que entienda la respuesta.'),
    nota(103, x('Construir petición') - 40, PASO * 2, 6, '## ③ Modelo\nPrompt de `prompts/clasificador.md`, temperatura 0, salida JSON.\nLos comandos y frases fijas (/help, «cómo te llamas», «qué tengo hoy») se saltan el modelo (**¿Hace falta el modelo?**).\n3 intentos con 5 s de espera. Un error no detiene el flujo: llega a Planificar como `{ error }`.'),
    nota(104, x('Planificar') - 40, PASO * 2, 3, '## ④ Decisión y escritura\n**Planificar** valida (tolerante) y decide qué escribir. Las referencias que cita el modelo deben ser de items pendientes.\n**Escribir en Supabase** ejecuta las escrituras en orden.\nSi algo falla, el mensaje queda con `procesado = false` y el motivo en `error`.'),
    nota(105, x('Leer consulta') - 40, PASO * 2, 7, '## ⑤ Respuesta\n**Leer consulta** solo trae datos si la intención es consultar.\n**¿Listar carpetas?**: solo con la intención carpetas lee el árbol de Drive (3 niveles) y cuenta los archivos. **Resultado** redacta la lista (solo lo pendiente), el árbol de carpetas o un mensaje honesto si algo falló. Una entrada de `mensajes` por mensaje de WhatsApp.'),
    nota(
      106,
      0,
      900,
      2,
      '## Antes de ejecutar\n1. Elige la credencial en **Modelo** (Header Auth de Gemini) y en **Guardar mensaje**, **Leer memoria**, **Leer items pendientes**, **Leer pregunta pendiente**, **Leer archivos**, **Leer proyectos**, **Leer avisos**, **Escribir en Supabase**, **Leer consulta** y **Contar archivos** (Supabase API), y la de **Google Drive OAuth2** en **Listar nivel 1**, **Listar nivel 2** y **Listar nivel 3**.\n2. Identificadores: `SUPABASE_URL` y `DRIVE_CARPETA_RAIZ_ID` en el `.env` del servidor (no hace falta tocar **Configuración**). En **Entrada**, el `MENSAJE` de prueba.\n3. Requiere la base de datos instalada (`supabase/instalar.sql`). La cola de mensajes seguidos y el turno viven en el flujo de WhatsApp: este flujo no espera nunca.\n\nLas filas de prueba tienen `wa_message_id` que empieza por `manual-`.',
      // debajo de «Al ser llamado» (y = 200), sin taparlo
      360,
      260,
    ),
  ];

  const conexiones = {};
  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  // Cadena lineal hasta "¿Listar carpetas?"; de ahí sale la rama de carpetas
  ORDEN.slice(0, ORDEN.indexOf('¿Listar carpetas?')).forEach((nombre, i) => {
    conexiones[nombre] = { main: [[a(ORDEN[i + 1])]] };
  });
  // Sin modelo (comandos y frases fijas): de la pregunta directamente a Planificar
  conexiones['¿Hace falta el modelo?'] = { main: [[a('Modelo')], [a('Planificar')]] };
  // Con la intención "carpetas": árbol de Drive y recuento de archivos; con las demás, directo al resultado
  conexiones['¿Listar carpetas?'] = { main: [[a('Listar nivel 1')], [a('Resultado')]] };
  conexiones['Listar nivel 1'] = { main: [[a('Listar nivel 2')]] };
  conexiones['Listar nivel 2'] = { main: [[a('Listar nivel 3')]] };
  conexiones['Listar nivel 3'] = { main: [[a('Contar archivos')]] };
  conexiones['Contar archivos'] = { main: [[a('Resultado')]] };
  // Tras Resultado: anotar el fallo si lo hubo y entregar siempre la misma salida
  conexiones['Resultado'] = { main: [[a('¿Anotar fallo?')]] };
  conexiones['¿Anotar fallo?'] = { main: [[a('Anotar fallo')], [a('Entregar')]] };
  conexiones['Anotar fallo'] = { main: [[a('Entregar')]] };
  // Segundo disparador: entra en la misma cadena, por Configuración
  conexiones['Al ser llamado'] = { main: [[{ node: 'Configuración', type: 'main', index: 0 }]] };

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

module.exports = { construirFlujo, generar, codigoComandos };

if (require.main === module) generar();
