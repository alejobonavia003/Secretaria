// Ejecuta en serie todas las baterías de pruebas (probar-*.js) o todos los generadores de flujos (generar-*.js).
// Uso:   node herramientas/ejecutar.js probar      (npm test)
//        node herramientas/ejecutar.js generar     (npm run generar)
// Termina con código distinto de 0 si alguno falla, y muestra al final un resumen.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const modo = process.argv[2];
if (modo !== 'probar' && modo !== 'generar') {
  console.error('Uso: node herramientas/ejecutar.js <probar|generar>');
  process.exit(2);
}

const carpeta = __dirname;
const raiz = path.resolve(carpeta, '..');
const archivos = fs
  .readdirSync(carpeta)
  .filter((f) => f.startsWith(`${modo}-`) && f.endsWith('.js'))
  .sort();

const resultados = [];
for (const archivo of archivos) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(carpeta, archivo)], { cwd: raiz, encoding: 'utf8' });
  const ok = r.status === 0;
  resultados.push({ archivo, ok, segundos: ((Date.now() - t0) / 1000).toFixed(1) });
  if (!ok) {
    console.error(`\n--- ${archivo} FALLÓ (código ${r.status}) ---`);
    console.error((r.stdout || '').split('\n').slice(-25).join('\n'));
    console.error(r.stderr || '');
  }
}

console.log('');
for (const r of resultados) console.log(`${r.ok ? 'OK   ' : 'FALLO'}  ${r.archivo}  (${r.segundos} s)`);
const fallos = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallos} de ${resultados.length} correctos.`);
process.exit(fallos ? 1 : 0);
