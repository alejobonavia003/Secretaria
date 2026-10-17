#!/usr/bin/env bash
# Restaura una copia de n8n (el volumen-n8n.tar.gz que va dentro de la copia de copia-completa.sh) en el volumen de Docker de n8n.
# Uso en el servidor, desde la carpeta del proyecto (/root/Secretaria):
#     bash herramientas/servidor/restaurar-n8n.sh copias/n8n_AAAA-MM-DD_HHMM.tar.gz
# Después:  docker compose up -d
#
# - El volumen se llama secretaria_n8n_data porque Docker Compose lo nombra con el nombre de la carpeta del proyecto: la carpeta debe
#   llamarse "Secretaria" (el script avisa si no).
# - Si el volumen ya tiene datos, pide confirmación escrita antes de sobrescribirlos.
# - La clave N8N_ENCRYPTION_KEY debe ser LA MISMA con la que se hizo la copia, o las credenciales no se descifran.
# - La clave va en secretos/n8n_encryption_key (una sola línea; nunca en el .env).
set -euo pipefail

VOLUMEN="secretaria_n8n_data"
ARCHIVO="${1:-}"

if [ -z "$ARCHIVO" ]; then
  echo "Uso: bash herramientas/servidor/restaurar-n8n.sh copias/n8n_AAAA-MM-DD_HHMM.tar.gz" >&2
  exit 1
fi
if [ ! -f "$ARCHIVO" ]; then
  echo "No existe el archivo: $ARCHIVO" >&2
  exit 1
fi
if [ "$(basename "$PWD" | tr 'A-Z' 'a-z')" != "secretaria" ]; then
  echo "AVISO: la carpeta actual se llama '$(basename "$PWD")' y debería ser 'Secretaria'. Con otro nombre Docker Compose usaría otro volumen y n8n no vería estos datos." >&2
  read -r -p "¿Seguir de todos modos? (escribe SI) " r
  [ "$r" = "SI" ] || exit 1
fi
if [ ! -f .env ]; then
  echo "AVISO: no hay .env en esta carpeta. Créalo antes de arrancar n8n (las variables de WhatsApp y N8N_WEBHOOK_URL)." >&2
fi
if [ ! -f secretos/n8n_encryption_key ]; then
  echo "AVISO: falta secretos/n8n_encryption_key (la clave de cifrado, una sola línea). Sin él, docker compose up -d no arranca n8n." >&2
fi

# n8n debe estar parado mientras se restaura
docker compose stop n8n >/dev/null 2>&1 || true

if docker volume inspect "$VOLUMEN" >/dev/null 2>&1; then
  contenido="$(docker run --rm -v "$VOLUMEN":/d alpine sh -c 'ls -A /d | wc -l')"
  if [ "$contenido" != "0" ]; then
    echo "El volumen $VOLUMEN ya tiene datos ($contenido elementos). Restaurar los SOBRESCRIBE."
    read -r -p "¿Sobrescribir? (escribe SI) " r
    [ "$r" = "SI" ] || { echo "Cancelado."; exit 1; }
  fi
else
  docker volume create "$VOLUMEN" >/dev/null
fi

carpeta="$(cd "$(dirname "$ARCHIVO")" && pwd)"
nombre="$(basename "$ARCHIVO")"
docker run --rm -v "$VOLUMEN":/datos -v "$carpeta":/copia:ro alpine tar xzf "/copia/$nombre" -C /datos

echo "Contenido restaurado en el volumen:"
docker run --rm -v "$VOLUMEN":/datos alpine ls -la /datos
echo "Listo. Arranca n8n con:  docker compose up -d"
