// Pruebas de la distribución de los flujos generados (flujos/*.json): que se lean bien al importarlos en n8n.
//   - ninguna nota tapa un nodo (las notas van encima de su fila, no debajo de los nodos);
//   - dos nodos no quedan casi pegados (n8n dibuja el nodo en unos 100 x 100 px y su nombre debajo);
//   - dos notas no se montan una sobre otra.
// Solo mira posiciones: nodos, conexiones y código no cambian por esto. Uso: node herramientas/probar-distribucion.js
'use strict';

const fs = require('fs');
const path = require('path');

const CARPETA = path.join(__dirname, '..', 'flujos');
const NODO = 100; // lado aproximado de un nodo en el lienzo de n8n
const MIN_X = 180; // separación mínima entre nodos en horizontal…
const MIN_Y = 150; // …o en vertical (basta con cumplir una de las dos)

let correctas = 0;
const fallos = [];
function afirmar(nombre, cond, detalle = '') {
  if (cond) correctas++;
  else {
    fallos.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}

const esNota = (n) => n.type === 'n8n-nodes-base.stickyNote';
const titulo = (s) => String(s.parameters.content ?? '').split('\n')[0].slice(0, 40);
const seCruzan = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const archivo of fs.readdirSync(CARPETA).filter((f) => f.endsWith('.json')).sort()) {
  console.log(archivo);
  const flujo = JSON.parse(fs.readFileSync(path.join(CARPETA, archivo), 'utf8'));
  const nodos = flujo.nodes.filter((n) => !esNota(n));
  const notas = flujo.nodes.filter(esNota).map((s) => ({ s, x: s.position[0], y: s.position[1], w: s.parameters.width ?? 240, h: s.parameters.height ?? 160 }));

  const tapados = [];
  for (const nota of notas) {
    for (const n of nodos) {
      if (seCruzan(nota, { x: n.position[0], y: n.position[1], w: NODO, h: NODO })) tapados.push(`«${titulo(nota.s)}» tapa «${n.name}»`);
    }
  }
  afirmar(`${archivo}: ninguna nota tapa un nodo`, tapados.length === 0, tapados.join('; '));

  const pegados = [];
  for (let i = 0; i < nodos.length; i++) {
    for (let j = i + 1; j < nodos.length; j++) {
      const [x1, y1] = nodos[i].position;
      const [x2, y2] = nodos[j].position;
      if (Math.abs(x1 - x2) < MIN_X && Math.abs(y1 - y2) < MIN_Y) pegados.push(`«${nodos[i].name}» y «${nodos[j].name}»`);
    }
  }
  afirmar(`${archivo}: no hay nodos casi pegados`, pegados.length === 0, pegados.join('; '));

  const montadas = [];
  for (let i = 0; i < notas.length; i++) {
    for (let j = i + 1; j < notas.length; j++) if (seCruzan(notas[i], notas[j])) montadas.push(`«${titulo(notas[i].s)}» y «${titulo(notas[j].s)}»`);
  }
  afirmar(`${archivo}: las notas no se montan unas sobre otras`, montadas.length === 0, montadas.join('; '));
}

console.log(`\n${correctas} comprobaciones correctas, ${fallos.length} con fallo.`);
if (fallos.length) {
  console.log('Fallan:\n' + fallos.map((f) => `- ${f}`).join('\n'));
  process.exit(1);
}
