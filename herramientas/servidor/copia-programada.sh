#!/usr/bin/env bash
# Copia semanal de n8n para cron: ejecuta copia-completa.sh, comprueba que de verdad se ha creado una copia nueva y avisa al monitor externo
# (HEALTHCHECK_URL_COPIA en /root/.secretaria-monitor) de que ha ido bien o mal. Si la copia no se hace, el monitor avisa por correo al faltar el latido.
# Esta copia queda EN EL SERVIDOR: para que valga contra la pérdida del servidor hay que bajarla fuera (scp a tu PC) de vez en cuando.
# La lógica está probada con órdenes simuladas (herramientas/probar-servidor.js).

CONFIG="${SECRETARIA_MONITOR_CONFIG:-/root/.secretaria-monitor}"
LOG="${SECRETARIA_COPIA_LOG:-/var/log/secretaria-copia.log}"

buscar_proyecto() {
  local d
  if [ -n "${SECRETARIA_DIR:-}" ]; then echo "$SECRETARIA_DIR"; return; fi
  d="$(cd "$(dirname "$0")" && pwd)"
  while [ "$d" != "/" ]; do
    if [ -f "$d/docker-compose.yml" ]; then echo "$d"; return; fi
    d="$(dirname "$d")"
  done
  echo "/root/Secretaria"
}
PROYECTO="$(buscar_proyecto)"

leer_clave() {
  [ -f "$CONFIG" ] || return 0
  grep -E "^$1=" "$CONFIG" | tail -n1 | cut -d= -f2- | tr -d '\r"'"'"
}
HC_URL="$(leer_clave HEALTHCHECK_URL_COPIA)"

aviso() { # $1 = "" (bien) o "/fail"; $2 = texto
  [ -z "$HC_URL" ] && return 0
  curl -fsS --max-time 10 --retry 2 --data-raw "$2" "${HC_URL%/}$1" >/dev/null 2>&1
}

cd "$PROYECTO" 2>/dev/null || { echo "$(date '+%F %T') FALLO: no existe $PROYECTO" >> "$LOG"; aviso /fail "no existe la carpeta del proyecto"; exit 1; }
SCRIPT="copia-completa.sh"
[ -f "$SCRIPT" ] || SCRIPT="herramientas/servidor/copia-completa.sh"
[ -f "$SCRIPT" ] || { echo "$(date '+%F %T') FALLO: falta copia-completa.sh" >> "$LOG"; aviso /fail "falta copia-completa.sh"; exit 1; }

inicio="$(date +%s)"
if ! bash "$SCRIPT" >> "$LOG" 2>&1; then
  echo "$(date '+%F %T') FALLO: copia-completa.sh terminó con error" >> "$LOG"
  aviso /fail "copia-completa.sh terminó con error"
  exit 1
fi

# Debe existir una copia creada durante esta ejecución y con un tamaño razonable
ultima="$(ls -1t copias/secretaria_n8n_completa_*.tar.gz 2>/dev/null | head -n1)"
if [ -z "$ultima" ] || [ "$(stat -c %Y "$ultima")" -lt "$inicio" ] || [ "$(stat -c %s "$ultima")" -lt 1048576 ]; then
  echo "$(date '+%F %T') FALLO: no se encontró una copia nueva de tamaño razonable" >> "$LOG"
  aviso /fail "no se encontró una copia nueva de tamaño razonable"
  exit 1
fi

echo "$(date '+%F %T') OK: $ultima ($(( $(stat -c %s "$ultima") / 1024 / 1024 )) MB)" >> "$LOG"
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -n 600 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
aviso "" "copia correcta: $ultima"
exit 0
