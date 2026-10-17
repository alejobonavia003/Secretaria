// Nodo "Resumen": deja el resultado en la ejecución. Puede ejecutarse más de una vez (una por rama); la última tiene el recuento completo.
//   Drive: 200 = a la papelera. Calendar: 2xx = borrado; 404/410 = ya no existía (el mismo resultado). Otro estado = fallo (se ve aquí).

const lee = (nombre) => {
  try {
    return $(nombre).all().map((i) => i.json);
  } catch (e) {
    return [];
  }
};
const reunido = lee('Reunir y decidir');
const primero = reunido[0] ?? {};

if (primero.modo === 'ensayo' || primero.modo === 'nada') {
  return [{ json: { ...primero, aviso: primero.modo === 'ensayo' ? 'ENSAYO: no se ha borrado nada. Para borrar de verdad escribe BORRAR TODO en CONFIRMAR (nodo Configuración) y ejecuta de nuevo.' : 'No había nada que borrar.' } }];
}

const operaciones = reunido.filter((r) => r.modo === 'real');
const drive = operaciones.filter((o) => o.tipo === 'drive');
const calendar = operaciones.filter((o) => o.tipo === 'calendar');
const respDrive = lee('Mandar a la papelera de Drive');
const respCalendar = lee('Borrar evento de Calendar');

const bien = (tipo, r) => {
  const s = r?.statusCode;
  return tipo === 'drive' ? s >= 200 && s < 300 : (s >= 200 && s < 300) || s === 404 || s === 410;
};
const fallos = [];
drive.forEach((o, i) => bien('drive', respDrive[i]) || fallos.push(`Drive · ${o.nombre}: ${respDrive[i]?.statusCode ?? 'sin respuesta'}`));
calendar.forEach((o, i) => bien('calendar', respCalendar[i]) || fallos.push(`Calendar · ${o.nombre}: ${respCalendar[i]?.statusCode ?? 'sin respuesta'}`));

return [
  {
    json: {
      modo: 'real',
      drive_a_la_papelera: drive.length - fallos.filter((f) => f.startsWith('Drive')).length,
      eventos_borrados: calendar.length - fallos.filter((f) => f.startsWith('Calendar')).length,
      fallos: fallos.slice(0, 50),
      incompleto: Boolean(primero.incompleto),
      nota: primero.incompleto ? primero.nota : fallos.length > 0 ? 'Hubo fallos: vuelve a ejecutar el flujo (lo ya borrado no se repite).' : 'Hecho. Ahora ejecuta el SQL de vaciar la base de datos si aún no lo has hecho.',
    },
  },
];
