// Pruebas sin servidor de los scripts de herramientas/servidor (vigilar-servidor.sh, copia-programada.sh, instalar-cron.sh, preparar-servidor.sh e importar-flujos.sh).
// Se ejecutan de verdad con bash, pero con las órdenes del sistema (docker, curl, tailscale, df) sustituidas por simulaciones que registran lo que
// se les pide. Así se comprueba la lógica (qué avisa, cuándo, con qué texto y sin ejecutar nada de la configuración) sin tocar ningún servidor.
// Uso: node herramientas/probar-servidor.js   (necesita bash: Git Bash en Windows, o cualquier Linux)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const SERV = path.join(RAIZ, 'herramientas', 'servidor');

let pasan = 0;
const fallan = [];
function afirmar(nombre, condicion, detalle) {
  if (condicion) pasan += 1;
  else {
    fallan.push(nombre);
    console.log(`  FALLA: ${nombre}${detalle ? `\n         ${detalle}` : ''}`);
  }
}

const bash = (() => {
  const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'ok';
})();
if (!bash) {
  console.log('No hay bash disponible: se omiten las pruebas de los scripts del servidor.');
  process.exit(0);
}

// Carpeta de trabajo con las órdenes simuladas
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'secretaria-prueba-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const stub = (nombre, cuerpo) => {
  const f = path.join(BIN, nombre);
  fs.writeFileSync(f, `#!/usr/bin/env bash\n${cuerpo}\n`, { mode: 0o755 });
  fs.chmodSync(f, 0o755);
};
// docker compose ps ... -> "n8n" si STUB_DOCKER=up
stub('docker', 'if [ "${STUB_DOCKER:-up}" = "up" ]; then echo n8n; fi\nexit 0');
// tailscale status -> código STUB_TS
stub('tailscale', 'exit "${STUB_TS:-0}"');
// df -P / -> uso STUB_DISCO %
stub('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/x 100 50 50 ${STUB_DISCO:-40}% /"');
// curl: registra TODO lo que se le pide en STUB_LOG; /healthz según STUB_HEALTHZ; la dirección pública devuelve STUB_CODE (con -w); los latidos funcionan siempre
stub(
  'curl',
  `echo "curl $*" >> "$STUB_LOG"
case "$*" in
  *healthz*) exit "\${STUB_HEALTHZ:-0}" ;;
  *"-w"*) printf '%s' "\${STUB_CODE:-403}"; exit 0 ;;
  *) exit 0 ;;
esac`,
);

function proyecto(nombre) {
  const d = path.join(TMP, nombre);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'docker-compose.yml'), 'services: {}\n');
  return d;
}
const aPosix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`);

function correr(script, { env = {}, config, args = [] } = {}) {
  const dir = proyecto(`p-${Math.random().toString(36).slice(2)}`);
  const log = path.join(dir, 'llamadas.log');
  const cfg = path.join(dir, 'monitor.conf');
  if (config !== undefined) fs.writeFileSync(cfg, config);
  const r = spawnSync('bash', [path.join(SERV, script), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${aPosix(BIN)}:${process.env.PATH}`,
      SECRETARIA_DIR: aPosix(dir),
      SECRETARIA_MONITOR_CONFIG: aPosix(cfg),
      SECRETARIA_MONITOR_LOG: aPosix(path.join(dir, 'monitor.log')),
      SECRETARIA_COPIA_LOG: aPosix(path.join(dir, 'copia.log')),
      STUB_LOG: aPosix(log),
      ...env,
    },
  });
  const llamadas = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const registro = fs.existsSync(path.join(dir, 'monitor.log')) ? fs.readFileSync(path.join(dir, 'monitor.log'), 'utf8') : '';
  return { ...r, dir, llamadas, registro };
}

const CONF = 'HEALTHCHECK_URL_SERVIDOR=https://hc-ping.com/servidor-123\nHEALTHCHECK_URL_COPIA=https://hc-ping.com/copia-456\nURL_PUBLICA=https://secretaria.ejemplo.ts.net\n';
const latidos = (r) => r.llamadas.filter((l) => l.includes('hc-ping.com'));

console.log('vigilar-servidor.sh');
{
  const bien = correr('vigilar-servidor.sh', { config: CONF });
  afirmar('todo bien: sale con 0 y manda UN latido de vida (sin /fail)', bien.status === 0 && latidos(bien).length === 1 && latidos(bien)[0].includes('hc-ping.com/servidor-123') && !latidos(bien)[0].includes('/fail'), JSON.stringify(bien.llamadas));
  afirmar('todo bien: no escribe nada en el registro de fallos', bien.registro === '');
  afirmar('comprueba la dirección pública con un token falso (nunca con uno real)', bien.llamadas.some((l) => l.includes('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=comprobacion')));

  const caido = correr('vigilar-servidor.sh', { config: CONF, env: { STUB_DOCKER: 'down' } });
  afirmar('contenedor parado: sale con 1 y avisa al monitor con /fail y el motivo', caido.status === 1 && latidos(caido).length === 1 && latidos(caido)[0].includes('servidor-123/fail') && latidos(caido)[0].includes('el contenedor de n8n no está en marcha'), JSON.stringify(latidos(caido)));
  afirmar('el fallo queda en el registro con la fecha', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d FALLO: el contenedor de n8n no está en marcha/.test(caido.registro), caido.registro);

  const sinHealthz = correr('vigilar-servidor.sh', { config: CONF, env: { STUB_HEALTHZ: '22' } });
  afirmar('n8n no responde en /healthz: fallo', sinHealthz.status === 1 && latidos(sinHealthz)[0].includes('n8n no responde'));

  const disco = correr('vigilar-servidor.sh', { config: CONF, env: { STUB_DISCO: '90' } });
  afirmar('disco al 90 %: fallo con el porcentaje', disco.status === 1 && latidos(disco)[0].includes('el disco está al 90% (límite 85%)'), JSON.stringify(latidos(disco)));
  afirmar('disco al 80 %: bien', correr('vigilar-servidor.sh', { config: CONF, env: { STUB_DISCO: '80' } }).status === 0);
  afirmar('el límite del disco se puede cambiar', correr('vigilar-servidor.sh', { config: CONF, env: { STUB_DISCO: '80', SECRETARIA_UMBRAL_DISCO: '70' } }).status === 1);

  afirmar('Tailscale caído: fallo', correr('vigilar-servidor.sh', { config: CONF, env: { STUB_TS: '1' } }).status === 1);

  for (const [codigo, esperado] of [['403', 0], ['200', 0], ['502', 1], ['000', 1], ['404', 1]]) {
    const r = correr('vigilar-servidor.sh', { config: CONF, env: { STUB_CODE: codigo } });
    afirmar(`dirección pública responde ${codigo}: ${esperado === 0 ? 'bien' : 'fallo'}`, r.status === esperado, JSON.stringify(r.llamadas));
  }
  const dos = correr('vigilar-servidor.sh', { config: CONF, env: { STUB_DOCKER: 'down', STUB_DISCO: '95' } });
  afirmar('varios fallos a la vez: un solo aviso con todos los motivos', latidos(dos).length === 1 && latidos(dos)[0].includes('contenedor') && latidos(dos)[0].includes('disco'));

  const sinConfig = correr('vigilar-servidor.sh', {});
  afirmar('sin archivo de configuración no avisa a nadie, pero sigue comprobando (sale con 0 si todo va bien)', sinConfig.status === 0 && latidos(sinConfig).length === 0);
  const sinConfigMal = correr('vigilar-servidor.sh', { env: { STUB_DOCKER: 'down' } });
  afirmar('sin configuración y con un fallo: sale con 1 y lo registra, sin llamar a ningún monitor', sinConfigMal.status === 1 && latidos(sinConfigMal).length === 0 && sinConfigMal.registro.includes('FALLO'));
  const sinUrlPublica = correr('vigilar-servidor.sh', { config: 'HEALTHCHECK_URL_SERVIDOR=https://hc-ping.com/servidor-123\n', env: { STUB_CODE: '502' } });
  afirmar('sin URL_PUBLICA no comprueba la dirección pública', sinUrlPublica.status === 0 && !sinUrlPublica.llamadas.some((l) => l.includes('/webhook/whatsapp')));

  // La configuración NUNCA se ejecuta
  const marca = path.join(TMP, 'marca-ejecutado');
  const inyeccion = correr('vigilar-servidor.sh', { config: `HEALTHCHECK_URL_SERVIDOR=https://hc-ping.com/x; touch ${aPosix(marca)}\n$(touch ${aPosix(marca)})\nURL_PUBLICA=\n` });
  afirmar('el archivo de configuración no se ejecuta (nada de "source")', !fs.existsSync(marca), `se creó ${marca}`);
  const comillas = correr('vigilar-servidor.sh', { config: 'HEALTHCHECK_URL_SERVIDOR="https://hc-ping.com/entre-comillas"\r\n' });
  afirmar('tolera comillas y finales de línea de Windows', latidos(comillas)[0]?.includes('hc-ping.com/entre-comillas') && !latidos(comillas)[0].includes('"') && !latidos(comillas)[0].includes('\r'), JSON.stringify(latidos(comillas)));
  afirmar('la dirección secreta del monitor nunca aparece en el registro de fallos', !caido.registro.includes('hc-ping.com'));

  // Registro acotado
  const dirLog = proyecto('con-registro');
  const logGrande = path.join(dirLog, 'monitor.log');
  fs.writeFileSync(logGrande, Array.from({ length: 600 }, (_, i) => `linea ${i}`).join('\n') + '\n');
  spawnSync('bash', [path.join(SERV, 'vigilar-servidor.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${aPosix(BIN)}:${process.env.PATH}`, SECRETARIA_DIR: aPosix(dirLog), SECRETARIA_MONITOR_CONFIG: aPosix(path.join(dirLog, 'nada.conf')), SECRETARIA_MONITOR_LOG: aPosix(logGrande), STUB_LOG: aPosix(path.join(dirLog, 'l.log')), STUB_DOCKER: 'down' } });
  afirmar('el registro no crece sin límite (se recorta pasadas 500 líneas)', fs.readFileSync(logGrande, 'utf8').split('\n').filter(Boolean).length <= 301);
}

console.log('copia-programada.sh');
{
  const preparar = (cuerpoCopia) => {
    const r = { dir: null };
    return (config, env = {}) => {
      const dir = proyecto(`c-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(path.join(dir, 'copia-completa.sh'), `#!/usr/bin/env bash\n${cuerpoCopia}\n`);
      const cfg = path.join(dir, 'monitor.conf');
      if (config !== undefined) fs.writeFileSync(cfg, config);
      const log = path.join(dir, 'llamadas.log');
      const res = spawnSync('bash', [path.join(SERV, 'copia-programada.sh')], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${aPosix(BIN)}:${process.env.PATH}`, SECRETARIA_DIR: aPosix(dir), SECRETARIA_MONITOR_CONFIG: aPosix(cfg), SECRETARIA_COPIA_LOG: aPosix(path.join(dir, 'copia.log')), STUB_LOG: aPosix(log), ...env },
      });
      return { ...res, dir, llamadas: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [], registro: fs.existsSync(path.join(dir, 'copia.log')) ? fs.readFileSync(path.join(dir, 'copia.log'), 'utf8') : '' };
    };
  };
  const crea = (tam) => `mkdir -p copias; head -c ${tam} /dev/zero > copias/secretaria_n8n_completa_prueba.tar.gz`;
  const hc = (r) => r.llamadas.filter((l) => l.includes('hc-ping.com'));

  const bien = preparar(crea(2 * 1024 * 1024))(CONF);
  afirmar('copia correcta: sale con 0, avisa al monitor de la copia (sin /fail) y lo deja en el registro', bien.status === 0 && hc(bien).length === 1 && hc(bien)[0].includes('copia-456') && !hc(bien)[0].includes('/fail') && bien.registro.includes('OK:'), JSON.stringify(bien.llamadas) + bien.registro);
  afirmar('usa el latido de la copia, no el del servidor', !hc(bien)[0].includes('servidor-123'));

  const falla = preparar('exit 3')(CONF);
  afirmar('si copia-completa.sh falla: sale con 1 y avisa con /fail', falla.status === 1 && hc(falla)[0].includes('copia-456/fail') && falla.registro.includes('FALLO'));
  const pequena = preparar(crea(1000))(CONF);
  afirmar('una copia de pocos bytes no vale: fallo', pequena.status === 1 && hc(pequena)[0].includes('/fail'));
  const nada = preparar('exit 0')(CONF);
  afirmar('si el script dice que fue bien pero no hay copia nueva: fallo', nada.status === 1 && hc(nada)[0].includes('/fail'));
  const vieja = preparar('mkdir -p copias; head -c 2097152 /dev/zero > copias/secretaria_n8n_completa_vieja.tar.gz; touch -d "3 days ago" copias/secretaria_n8n_completa_vieja.tar.gz')(CONF);
  afirmar('una copia antigua que ya existía no cuenta como copia nueva', vieja.status === 1);
  const sinConfig = preparar(crea(2 * 1024 * 1024))(undefined);
  afirmar('sin configuración hace la copia igualmente y no llama a ningún monitor', sinConfig.status === 0 && hc(sinConfig).length === 0);
}

console.log('instalar-cron.sh');
{
  const montar = () => {
    const dir = proyecto(`i-${Math.random().toString(36).slice(2)}`);
    for (const f of ['vigilar-servidor.sh', 'copia-programada.sh', 'copia-completa.sh']) fs.copyFileSync(path.join(SERV, f), path.join(dir, f));
    fs.copyFileSync(path.join(SERV, 'instalar-cron.sh'), path.join(dir, 'instalar-cron.sh'));
    return dir;
  };
  const ejecutar = (dir, extra = {}) => {
    const cron = path.join(dir, 'cron.d');
    const cfg = path.join(dir, 'monitor.conf');
    const r = spawnSync('bash', [path.join(dir, 'instalar-cron.sh')], { encoding: 'utf8', env: { ...process.env, SECRETARIA_CRON_DIR: aPosix(cron), SECRETARIA_MONITOR_CONFIG: aPosix(cfg), ...extra } });
    const f = path.join(cron, 'secretaria-monitor');
    return { ...r, cron: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', cfg: fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : null, cfgRuta: cfg };
  };
  const dir = montar();
  const r1 = ejecutar(dir);
  afirmar('instala la tarea de cada 5 minutos y la copia de los domingos a las 03:30', r1.status === 0 && /^\*\/5 \* \* \* \* root bash .*vigilar-servidor\.sh >\/dev\/null 2>&1$/m.test(r1.cron) && /^30 3 \* \* 0 root bash .*copia-programada\.sh >\/dev\/null 2>&1$/m.test(r1.cron), r1.cron + r1.stderr);
  afirmar('el cron lleva el SHELL, el PATH y la carpeta del proyecto', /^SHELL=\/bin\/bash$/m.test(r1.cron) && /^PATH=.*\/usr\/bin/m.test(r1.cron) && /^SECRETARIA_DIR=\S+$/m.test(r1.cron));
  afirmar('crea la configuración del monitor VACÍA (las direcciones las rellena el usuario)', r1.cfg !== null && /^HEALTHCHECK_URL_SERVIDOR=$/m.test(r1.cfg) && /^HEALTHCHECK_URL_COPIA=$/m.test(r1.cfg) && !/hc-ping/.test(r1.cfg));
  fs.writeFileSync(r1.cfgRuta, 'HEALTHCHECK_URL_SERVIDOR=https://hc-ping.com/ya-puesta\n');
  const r2 = ejecutar(dir);
  afirmar('repetirlo es seguro: mismo cron y NO pisa la configuración ya rellenada', r2.status === 0 && r2.cron === r1.cron && r2.cfg.includes('ya-puesta'));
  const incompleto = montar();
  fs.unlinkSync(path.join(incompleto, 'copia-programada.sh'));
  const r3 = ejecutar(incompleto);
  afirmar('si falta un script, se niega y no instala nada', r3.status === 1 && r3.cron === '' && r3.stderr.includes('Falta copia-programada.sh'));
}

// preparar-servidor.sh e importar-flujos.sh: se ejecutan en una carpeta de proyecto de prueba, con docker simulado (registra sus llamadas)
const BIN2 = path.join(TMP, 'bin2');
fs.mkdirSync(BIN2);
fs.writeFileSync(path.join(BIN2, 'docker'), '#!/usr/bin/env bash\necho "docker $*" >> "$STUB_LOG"\ncase "$*" in *"ps --status running"*) [ "${STUB_DOCKER:-up}" = "up" ] && echo n8n ;; esac\nexit 0\n', { mode: 0o755 });
function proyectoCompleto(nombre) {
  const d = path.join(TMP, `q-${Math.random().toString(36).slice(2)}`, nombre);
  fs.mkdirSync(path.join(d, 'flujos'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(d, '.env.example'), 'SUPABASE_URL=\n');
  fs.writeFileSync(path.join(d, 'flujos', 'whatsapp.json'), '{}\n');
  return d;
}
function lanzar(script, dir, env = {}) {
  const log = path.join(dir, '..', 'llamadas.log');
  const r = spawnSync('bash', [path.join(SERV, script)], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, PATH: `${aPosix(BIN2)}:${process.env.PATH}`, STUB_LOG: aPosix(log), ...env },
  });
  return { ...r, llamadas: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
}
const permisos = (f) => (fs.statSync(f).mode & 0o777).toString(8);

console.log('preparar-servidor.sh');
{
  const hayOpenssl = spawnSync('bash', ['-c', 'command -v openssl'], { encoding: 'utf8' }).status === 0;
  const d = proyectoCompleto('Secretaria');
  const r = lanzar('preparar-servidor.sh', d);
  const clave = path.join(d, 'secretos', 'n8n_encryption_key');
  if (hayOpenssl) {
    afirmar('crea una clave de cifrado de 64 caracteres hexadecimales', r.status === 0 && /^[0-9a-f]{64}\n$/.test(fs.readFileSync(clave, 'utf8')), r.stderr);
    if (process.platform !== 'win32') {
      afirmar('la clave solo es legible por su dueño (400) y su carpeta es 700', permisos(clave) === '400' && permisos(path.join(d, 'secretos')) === '700');
      afirmar('el .env se crea desde la plantilla y es 600', fs.readFileSync(path.join(d, '.env'), 'utf8') === 'SUPABASE_URL=\n' && permisos(path.join(d, '.env')) === '600');
    }
    const antes = fs.readFileSync(clave, 'utf8');
    fs.writeFileSync(path.join(d, '.env'), 'SUPABASE_URL=https://abc.supabase.co\n');
    const r2 = lanzar('preparar-servidor.sh', d);
    afirmar('repetirlo NO cambia la clave ni pisa el .env relleno', r2.status === 0 && fs.readFileSync(clave, 'utf8') === antes && fs.readFileSync(path.join(d, '.env'), 'utf8').includes('abc.supabase.co'));
  }
  const otro = proyectoCompleto('secretaria-main');
  const r3 = lanzar('preparar-servidor.sh', otro);
  afirmar('se niega si la carpeta no se llama «Secretaria» (el volumen de Docker depende del nombre)', r3.status === 1 && r3.stderr.includes('Secretaria') && !fs.existsSync(path.join(otro, 'secretos')));
  const r4 = lanzar('preparar-servidor.sh', path.join(otro, 'flujos'));
  afirmar('se niega fuera de la carpeta del proyecto', r4.status === 1 && r4.stderr.includes('carpeta del proyecto'));
}

console.log('importar-flujos.sh');
{
  const d = proyectoCompleto('Secretaria');
  const r = lanzar('importar-flujos.sh', d);
  const i = (txt) => r.llamadas.findIndex((l) => l.includes(txt));
  afirmar('copia flujos/ al contenedor e importa con --separate', r.status === 0 && i('compose cp flujos n8n:/tmp/flujos-secretaria') >= 0 && i('n8n import:workflow --separate --input=/tmp/flujos-secretaria') > i('compose cp'), JSON.stringify(r.llamadas) + r.stderr);
  afirmar('importa como el usuario node (el dueño de los datos de n8n) y deja la copia legible para él', r.llamadas.some((l) => l.includes('exec -T -u node n8n n8n import:workflow')) && i('chown -R node:node') > i('compose cp') && i('chown -R node:node') < i('import:workflow'));
  afirmar('limpia la copia temporal antes y después', i('rm -rf /tmp/flujos-secretaria') < i('compose cp') && r.llamadas.filter((l) => l.includes('rm -rf /tmp/flujos-secretaria')).length === 2);
  const parado = lanzar('importar-flujos.sh', proyectoCompleto('Secretaria'), { STUB_DOCKER: 'down' });
  afirmar('con n8n parado, no importa nada y explica cómo arrancarlo', parado.status === 1 && parado.stderr.includes('docker compose up -d') && !parado.llamadas.some((l) => l.includes('import:workflow')));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pasan} comprobaciones correctas, ${fallan.length} con fallo.`);
if (fallan.length) {
  console.log('Fallan:');
  fallan.forEach((n) => console.log(`- ${n}`));
  process.exit(1);
}
