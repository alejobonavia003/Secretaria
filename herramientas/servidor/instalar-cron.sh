#!/usr/bin/env bash
# Instala las tareas programadas del servidor (como root, UNA vez; repetirlo es seguro, sobrescribe lo mismo):
#   - cada 5 minutos: vigilar-servidor.sh   (comprueba el servidor y avisa al monitor externo)
#   - domingos a las 03:30: copia-programada.sh   (copia completa de n8n y aviso al monitor)
# Uso, como root, desde la carpeta del proyecto (/root/Secretaria):   bash herramientas/servidor/instalar-cron.sh
# Crea /root/.secretaria-monitor (chmod 600) con las claves vacías si no existe: las direcciones de latido las rellenas TÚ (no son para el chat).
# Para quitarlo todo:   rm /etc/cron.d/secretaria-monitor
# La lógica está probada con órdenes simuladas (herramientas/probar-servidor.js).
set -euo pipefail

DESTINO_CRON="${SECRETARIA_CRON_DIR:-/etc/cron.d}/secretaria-monitor"
CONFIG="${SECRETARIA_MONITOR_CONFIG:-/root/.secretaria-monitor}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ] && [ -z "${SECRETARIA_CRON_DIR:-}" ]; then
  echo "Ejecútalo como root (estás conectado como root en el servidor)." >&2
  exit 1
fi
for f in vigilar-servidor.sh copia-programada.sh; do
  if [ ! -f "$DIR/$f" ]; then
    echo "Falta $f junto a este script ($DIR). Súbelo con scp." >&2
    exit 1
  fi
done
if [ ! -f "$DIR/copia-completa.sh" ] && [ ! -f "$DIR/herramientas/servidor/copia-completa.sh" ]; then
  echo "AVISO: no encuentro copia-completa.sh junto a estos scripts: la copia semanal fallaría." >&2
fi

if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<'FIN'
# Direcciones de latido del monitor externo (Healthchecks.io o similar). Rellénalas tú; este archivo no se versiona ni se comparte.
HEALTHCHECK_URL_SERVIDOR=
HEALTHCHECK_URL_COPIA=
# Dirección pública de n8n, sin barra final (opcional; permite comprobar que Tailscale Funnel sigue sirviendo el webhook)
URL_PUBLICA=
FIN
  chmod 600 "$CONFIG"
  echo "Creado $CONFIG (vacío). Rellénalo con nano antes de fiarte del monitor."
fi

mkdir -p "$(dirname "$DESTINO_CRON")"
cat > "$DESTINO_CRON" <<FIN
# Tareas programadas de la secretaria (instaladas por instalar-cron.sh)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SECRETARIA_DIR=$([ -f "$DIR/docker-compose.yml" ] && echo "$DIR" || echo "$(dirname "$(dirname "$DIR")")")
*/5 * * * * root bash $DIR/vigilar-servidor.sh >/dev/null 2>&1
30 3 * * 0 root bash $DIR/copia-programada.sh >/dev/null 2>&1
FIN
chmod 644 "$DESTINO_CRON"

echo "Instalado $DESTINO_CRON:"
cat "$DESTINO_CRON"
echo
echo "Siguiente: rellena $CONFIG con nano, y prueba ahora:   bash $DIR/vigilar-servidor.sh; echo \"código de salida: \$?\""
