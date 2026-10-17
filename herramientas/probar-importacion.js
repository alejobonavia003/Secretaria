// Pruebas sin red de lo que hace importables los flujos sin tocarlos a mano (herramientas/comun/importacion.js):
// credenciales por nombre en cada nodo que las necesita, sin cruzar Gemini y WhatsApp, ids fijos, subflujo y Error workflow.
const fs = require('fs');
const path = require('path');
const { credencialDe, credencialesSoloPorNombre, CREDENCIALES, IDS } = require('./comun/importacion');

const RAIZ = path.resolve(__dirname, '..');
const DIR = path.join(RAIZ, 'flujos');

let pasan = 0;
const fallan = [];
function afirmar(nombre, condicion, detalle) {
  if (condicion) pasan += 1;
  else {
    fallan.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}

const archivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const flujos = Object.fromEntries(archivos.map((f) => [f, JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))]));

console.log('Ids y ajustes');
{
  afirmar('hay un id fijo para cada flujo de flujos/ y ningún id sobrante', archivos.length === Object.keys(IDS).length && archivos.every((f) => IDS[f]));
  const ids = archivos.map((f) => flujos[f].id);
  afirmar('cada flujo lleva su id fijo', archivos.every((f) => flujos[f].id === IDS[f]), JSON.stringify(ids));
  afirmar('los ids no se repiten', new Set(ids).size === ids.length);
  afirmar('los ids tienen la forma de los de n8n (16 caracteres alfanuméricos)', ids.every((id) => /^[A-Za-z0-9]{16}$/.test(id)));
  afirmar('todos menos «Aviso de fallos» lo tienen como Error workflow', archivos.every((f) => (f === 'aviso-fallos.json' ? !flujos[f].settings.errorWorkflow : flujos[f].settings.errorWorkflow === IDS['aviso-fallos.json'])));
  afirmar('la zona horaria sigue siendo Europe/Madrid', archivos.every((f) => flujos[f].settings.timezone === 'Europe/Madrid'));
  const llamadas = archivos.flatMap((f) => flujos[f].nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow').map((n) => ({ f, n })));
  afirmar('el único subflujo es «Procesar mensaje», llamado desde WhatsApp', llamadas.length === 1 && llamadas[0].f === 'whatsapp.json');
  afirmar('el subflujo apunta al id fijo del flujo principal', llamadas[0] && llamadas[0].n.parameters.workflowId.value === flujos['procesar-mensaje.json'].id);
}

console.log('Credenciales');
{
  let conCredencial = 0;
  for (const f of archivos) {
    const flujo = flujos[f];
    afirmar(`${f}: las credenciales solo se referencian por nombre`, credencialesSoloPorNombre(flujo));
    for (const n of flujo.nodes) {
      const c = credencialDe(n);
      if (!c) {
        afirmar(`${f} / ${n.name}: sin credencial si no la necesita`, !n.credentials);
        continue;
      }
      conCredencial += 1;
      const valores = Object.values(n.credentials || {});
      afirmar(`${f} / ${n.name}: tiene exactamente una credencial`, valores.length === 1);
      const nombre = valores[0] && valores[0].name;
      const url = JSON.stringify((n.parameters || {}).url || '');
      if (nombre === CREDENCIALES.gemini) afirmar(`${f} / ${n.name}: la clave de Gemini solo va a Google`, /generativelanguage\.googleapis\.com/.test(url), url);
      if (nombre === CREDENCIALES.whatsapp) afirmar(`${f} / ${n.name}: el token de WhatsApp nunca va a Google`, !/googleapis\.com/.test(url), url);
    }
  }
  afirmar('se han comprobado todos los nodos con credencial (más de 80)', conCredencial > 80, String(conCredencial));
  const nombresUsados = new Set(archivos.flatMap((f) => flujos[f].nodes.flatMap((n) => Object.values(n.credentials || {}).map((c) => c.name))));
  afirmar('se usan las cinco credenciales y ninguna más', nombresUsados.size === 5 && Object.values(CREDENCIALES).every((c) => nombresUsados.has(c)), [...nombresUsados].join(', '));
  const gemini = archivos.flatMap((f) => flujos[f].nodes.filter((n) => Object.values(n.credentials || {}).some((c) => c.name === CREDENCIALES.gemini)).map((n) => `${f}/${n.name}`));
  afirmar('Gemini solo en «Modelo» (principal) y «Transcribir audio» (WhatsApp)', gemini.sort().join() === 'procesar-mensaje.json/Modelo,whatsapp.json/Transcribir audio', gemini.join());
}

console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} con fallo.`);
process.exit(fallan.length ? 1 : 0);
