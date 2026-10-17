#!/usr/bin/env bash
# Comprueba que el SERVIDOR está sano y avisa a un monitor externo (Healthchecks.io o similar). Se ejecuta cada 5 minutos con cron (ver instalar-cron.sh).
# Comprueba: que el contenedor de n8n está en marcha, que n8n responde en /healthz, que el disco no está lleno, que Tailscale responde y que la dirección
# pública del webhook contesta (desde el propio servidor, atravesando Tailscale Funnel).
# Si todo va bien, avisa al monitor de que sigue vivo (GET a su dirección). Si algo falla, avisa a esa dirección + /fail con el motivo. Si el servidor está
# apagado o cron no corre, no hay latido y es el MONITOR quien avisa (por correo): por eso no hay que confiar solo en WhatsApp.
# Configuración (sin secretos en este archivo): /root/.secretaria-monitor, con líneas CLAVE=valor (chmod 600):
#     HEALTHCHECK_URL_SERVIDOR=https://hc-ping.com/xxxxxxxx     latido de este script (lo creas tú en la web del monitor)
#     HEALTHCHECK_URL_COPIA=https://hc-ping.com/yyyyyyyy        latido de la copia semanal (otro "check")
#     URL_PUBLICA=https://secretaria.<tu-tailnet>.ts.net          dirección pública de n8n, sin barra final (opcional)
# Variables opcionales: SECRETARIA_DIR (carpeta del proyecto), SECRETARIA_UMBRAL_DISCO (% de disco, por defecto 85).
# La lógica está probada con órdenes simuladas (herramientas/probar-servidor.js).

CONFIG="${SECRETARIA_MONITOR_CONFIG:-/root/.secretaria-monitor}"
LOG="${SECRETARIA_MONITOR_LOG:-/var/log/secretaria-monitor.log}"
URL_LOCAL="${SECRETARIA_N8N_URL:-http://127.0.0.1:5678}"
UMBRAL_DISCO="${SECRETARIA_UMBRAL_DISCO:-85}"

# Carpeta del proyecto: la indicada, la del propio script o sus padres, o /root/Secretaria
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

# Lee una clave del archivo de configuración SIN ejecutarlo (nunca "source" de un archivo con secretos)
leer_clave() {
  [ -f "$CONFIG" ] || return 0
  grep -E "^$1=" "$CONFIG" | tail -n1 | cut -d= -f2- | tr -d '\r"'"'"
}
HC_URL="$(leer_clave HEALTHCHECK_URL_SERVIDOR)"
URL_PUBLICA="$(leer_clave URL_PUBLICA)"

fallos=()

# 1) Contenedor de n8n
if command -v docker >/dev/null 2>&1; then
  if ! (cd "$PROYECTO" 2>/dev/null && docker compose ps --status running --services 2>/dev/null | grep -qx n8n); then
    fallos+=("el contenedor de n8n no está en marcha")
  fi
else
  fallos+=("docker no está disponible")
fi

# 2) n8n responde
if ! curl -fsS --max-time 10 "$URL_LOCAL/healthz" >/dev/null 2>&1; then
  fallos+=("n8n no responde en $URL_LOCAL/healthz")
fi

# 3) Disco
uso="$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
if [ -n "$uso" ] && [ "$uso" -ge "$UMBRAL_DISCO" ] 2>/dev/null; then
  fallos+=("el disco está al ${uso}% (límite ${UMBRAL_DISCO}%)")
fi

# 4) Tailscale
if command -v tailscale >/dev/null 2>&1; then
  if ! tailscale status >/dev/null 2>&1; then fallos+=("Tailscale no responde"); fi
fi

# 5) Dirección pública del webhook (con un token falso: n8n debe contestar 403, o 200 si el token coincidiera)
if [ -n "$URL_PUBLICA" ]; then
  codigo="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${URL_PUBLICA%/}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=comprobacion&hub.challenge=1" 2>/dev/null)"
  case "$codigo" in
    200|403) ;;
    *) fallos+=("la dirección pública no responde como debe (código ${codigo:-ninguno})") ;;
  esac
fi

# --- Resultado ---
ahora="$(date '+%Y-%m-%d %H:%M:%S')"
if [ "${#fallos[@]}" -eq 0 ]; then
  [ -n "$HC_URL" ] && curl -fsS --max-time 10 --retry 2 "$HC_URL" >/dev/null 2>&1
  exit 0
fi

motivo="$(printf '%s; ' "${fallos[@]}")"
echo "$ahora FALLO: $motivo" >> "$LOG" 2>/dev/null
# El registro no crece sin límite
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 500 ]; then
  tail -n 300 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi
[ -n "$HC_URL" ] && curl -fsS --max-time 10 --retry 2 --data-raw "$motivo" "${HC_URL%/}/fail" >/dev/null 2>&1
exit 1
