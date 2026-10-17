#!/usr/bin/env bash
# Prepara la carpeta del proyecto en el servidor la primera vez: la clave de cifrado de n8n y el archivo .env, con sus permisos.
# Uso, como root y desde la carpeta del proyecto:   bash herramientas/servidor/preparar-servidor.sh
# No pisa nada: si la clave o el .env ya existen, los deja como están (una clave nueva haría ilegibles las credenciales de n8n).
set -euo pipefail

PROYECTO="${SECRETARIA_DIR:-$(pwd)}"
cd "$PROYECTO"

if [ ! -f docker-compose.yml ] || [ ! -f .env.example ]; then
  echo "Ejecútalo desde la carpeta del proyecto (la que tiene docker-compose.yml y .env.example)." >&2
  exit 1
fi

# El volumen de Docker se llama <carpeta>_n8n_data: con otro nombre de carpeta, las copias de seguridad no encontrarían los datos
if [ "$(basename "$PROYECTO")" != "Secretaria" ] && [ "${SECRETARIA_CUALQUIER_NOMBRE:-}" != "1" ]; then
  echo "La carpeta debe llamarse exactamente «Secretaria» (ahora: «$(basename "$PROYECTO")»). Renómbrala antes de seguir." >&2
  exit 1
fi

# 1. Clave de cifrado de n8n: 64 caracteres hexadecimales aleatorios, legible solo por el usuario del contenedor (uid 1000)
mkdir -p secretos
chmod 700 secretos
if [ -s secretos/n8n_encryption_key ]; then
  echo "La clave de cifrado ya existe: no se toca."
else
  umask 077
  openssl rand -hex 32 > secretos/n8n_encryption_key
  chown 1000:1000 secretos/n8n_encryption_key 2>/dev/null || true
  chmod 400 secretos/n8n_encryption_key
  echo "Clave de cifrado creada en secretos/n8n_encryption_key."
  echo "GUÁRDALA YA en tu gestor de contraseñas (sin ella, ninguna copia de seguridad recupera las credenciales):"
  echo "    cat secretos/n8n_encryption_key"
fi

# 2. Archivo .env a partir de la plantilla, solo legible por root
if [ -f .env ]; then
  echo "El archivo .env ya existe: no se toca."
else
  cp .env.example .env
  chmod 600 .env
  echo "Creado .env a partir de .env.example. Rellénalo con:   nano .env"
fi
