// Pruebas del cambio de hora (domingo 25 de octubre de 2026: a las 03:00 CEST pasan a ser las 02:00 CET, +02:00 → +01:00; el día dura 25 horas).
// Usan el código REAL de las funciones de fecha de planificar.js (se extraen del archivo, no se copian), con instantes fijos. Sin red.
const fs = require('fs');
const path = require('path');

const fuente = fs.readFileSync(path.join(__dirname, 'flujo', 'planificar.js'), 'utf8');

// Texto de una función (con sus llaves equilibradas) o de una línea que empieza por un prefijo
function funcion(nombre) {
  const i = fuente.indexOf(`function ${nombre}(`);
  if (i < 0) throw new Error(`no encuentro la función ${nombre}`);
  let nivel = 0;
  for (let j = fuente.indexOf('{', i); j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    if (fuente[j] === '}' && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`llaves sin cerrar en ${nombre}`);
}
function linea(prefijo) {
  const i = fuente.indexOf(prefijo);
  if (i < 0) throw new Error(`no encuentro la línea «${prefijo}»`);
  return fuente.slice(i, fuente.indexOf('\n', i));
}

const codigo = [
  funcion('offsetMadridMin'),
  funcion('madridAUtc'),
  linea('const diaMadrid ='),
  linea('const fmtPartesMadrid ='),
  linea('const ISO_DIA ='),
  funcion('partesMadrid'),
  linea('const HORA_FIN_ALARMAS ='),
  funcion('limiteAlarmas'),
  'return { offsetMadridMin, madridAUtc, diaMadrid, partesMadrid, limiteAlarmas };',
].join('\n');
const { offsetMadridMin, madridAUtc, diaMadrid, partesMadrid, limiteAlarmas } = new Function(codigo)();

let correctas = 0;
let fallos = 0;
function afirmar(nombre, ok, detalle = '') {
  if (ok) correctas++;
  else {
    fallos++;
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const H = 3600000;

console.log('Desfase de Madrid alrededor del cambio de hora');
afirmar('antes del cambio (24 oct, mediodía): +02:00', offsetMadridMin(Date.parse('2026-10-24T12:00:00Z')) === 120);
afirmar('el último segundo en horario de verano (00:59:59Z): +02:00', offsetMadridMin(Date.parse('2026-10-25T00:59:59Z')) === 120);
afirmar('el primer segundo en horario de invierno (01:00:00Z): +01:00', offsetMadridMin(Date.parse('2026-10-25T01:00:00Z')) === 60);
afirmar('después del cambio (25 oct, mediodía): +01:00', offsetMadridMin(Date.parse('2026-10-25T12:00:00Z')) === 60);

console.log('Hora local de Madrid → instante UTC');
afirmar('00:00 del domingo 25 (aún +02:00) = sábado 22:00Z', iso(madridAUtc(2026, 10, 25, 0, 0)) === '2026-10-24T22:00:00.000Z', iso(madridAUtc(2026, 10, 25, 0, 0)));
afirmar('12:00 del domingo 25 (ya +01:00) = 11:00Z', iso(madridAUtc(2026, 10, 25, 12, 0)) === '2026-10-25T11:00:00.000Z', iso(madridAUtc(2026, 10, 25, 12, 0)));
afirmar('00:00 del lunes 26 = domingo 23:00Z', iso(madridAUtc(2026, 10, 26, 0, 0)) === '2026-10-25T23:00:00.000Z', iso(madridAUtc(2026, 10, 26, 0, 0)));
afirmar('el domingo 25 dura 25 horas', madridAUtc(2026, 10, 26, 0, 0) - madridAUtc(2026, 10, 25, 0, 0) === 25 * H);
afirmar('el sábado 24 y el lunes 26 duran 24 horas', madridAUtc(2026, 10, 25, 0, 0) - madridAUtc(2026, 10, 24, 0, 0) === 24 * H && madridAUtc(2026, 10, 27, 0, 0) - madridAUtc(2026, 10, 26, 0, 0) === 24 * H);
afirmar('el día del cambio de marzo de 2027 (28) dura 23 horas', madridAUtc(2027, 3, 29, 0, 0) - madridAUtc(2027, 3, 28, 0, 0) === 23 * H);
const ambigua = madridAUtc(2026, 10, 25, 2, 30);
afirmar('02:30 del domingo 25 (ocurre dos veces) da una de las dos, siempre la misma', [Date.parse('2026-10-25T00:30:00Z'), Date.parse('2026-10-25T01:30:00Z')].includes(ambigua.getTime()) && ambigua.getTime() === madridAUtc(2026, 10, 25, 2, 30).getTime(), iso(ambigua));
afirmar('03:30 del domingo 25 (ya sin ambigüedad) = 02:30Z', iso(madridAUtc(2026, 10, 25, 3, 30)) === '2026-10-25T02:30:00.000Z', iso(madridAUtc(2026, 10, 25, 3, 30)));

console.log('Día natural de Madrid (lo que usan el resumen de las 7:00 y «hoy»)');
afirmar('sábado 22:00Z ya es domingo 25 en Madrid', diaMadrid(Date.parse('2026-10-24T22:00:00Z')) === '2026-10-25');
afirmar('domingo 22:59:59Z sigue siendo domingo 25', diaMadrid(Date.parse('2026-10-25T22:59:59Z')) === '2026-10-25');
afirmar('domingo 23:00:00Z ya es lunes 26', diaMadrid(Date.parse('2026-10-25T23:00:00Z')) === '2026-10-26');
afirmar('las 7:00 del lunes 26 (06:00Z) caen en el 26', diaMadrid(Date.parse('2026-10-26T06:00:00Z')) === '2026-10-26');
afirmar('las 7:00 del domingo 25 (06:00Z, ya en invierno) caen en el 25', diaMadrid(Date.parse('2026-10-25T06:00:00Z')) === '2026-10-25');
const p1 = partesMadrid(Date.parse('2026-10-25T22:30:00Z'));
const p2 = partesMadrid(Date.parse('2026-10-25T23:30:00Z'));
afirmar('domingo 23:30 → día 7 (domingo), minuto 1410', p1.dia === 7 && p1.min === 23 * 60 + 30, JSON.stringify(p1));
afirmar('lunes 00:30 → día 1 (lunes), minuto 30', p2.dia === 1 && p2.min === 30, JSON.stringify(p2));

console.log('Límite entre alarma y cita: las 02:00 de mañana');
afirmar('el sábado 24 a las 22:00: el límite es las 02:00 del domingo 25 (una de las dos 02:00)', [Date.parse('2026-10-25T00:00:00Z'), Date.parse('2026-10-25T01:00:00Z')].includes(limiteAlarmas(new Date('2026-10-24T20:00:00Z'))), iso(limiteAlarmas(new Date('2026-10-24T20:00:00Z'))));
afirmar('el domingo 25 a las 10:00: el límite es las 02:00 CET del lunes 26 (01:00Z)', iso(limiteAlarmas(new Date('2026-10-25T09:00:00Z'))) === '2026-10-26T01:00:00.000Z', iso(limiteAlarmas(new Date('2026-10-25T09:00:00Z'))));
afirmar('el domingo 25 a las 00:30 (aún en horario de verano): el límite sigue siendo las 02:00 del lunes 26', iso(limiteAlarmas(new Date('2026-10-24T22:30:00Z'))) === '2026-10-26T01:00:00.000Z', iso(limiteAlarmas(new Date('2026-10-24T22:30:00Z'))));
afirmar('el lunes 26 a las 08:00: el límite es las 02:00 del martes 27 (01:00Z)', iso(limiteAlarmas(new Date('2026-10-26T07:00:00Z'))) === '2026-10-27T01:00:00.000Z', iso(limiteAlarmas(new Date('2026-10-26T07:00:00Z'))));

console.log(fallos === 0 ? `${correctas} comprobaciones correctas, 0 con fallo.` : `${correctas} correctas, ${fallos} con fallo.`);
process.exit(fallos === 0 ? 0 : 1);
