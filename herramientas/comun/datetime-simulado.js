// Sustituto mínimo de DateTime.fromISO de Luxon para las pruebas sin red.
// n8n aporta Luxon en los nodos Code; en este equipo no está instalado y no hace falta instalarlo:
// aquí solo se necesita validar una fecha ISO, leer su offset y calcular el instante.
// Limitación: no prueba Luxon en sí.

const DateTimeSimulado = {
  fromISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(String(s));
    if (!m) return { isValid: false };
    const [, y, mo, d, h = '00', mi = '00', se = '00', z] = m;
    const f = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
    const valido = +mo >= 1 && +mo <= 12 && f.getUTCMonth() === +mo - 1 && f.getUTCDate() === +d && +h < 24 && +mi < 60 && +se < 60;
    if (!valido) return { isValid: false };
    let offset = 0;
    if (z && z !== 'Z') offset = (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(4, 6));
    return { isValid: true, offset, toMillis: () => f.getTime() - offset * 60000 };
  },
};

module.exports = { DateTimeSimulado };
