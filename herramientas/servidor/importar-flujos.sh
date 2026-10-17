#!/usr/bin/env bash
# Importa (o actualiza) los 14 flujos de flujos/ en el n8n del servidor con la línea de órdenes de n8n.
# Así cada nodo queda enlazado SOLO con su credencial, buscándola por nombre: antes de importar tienen que existir en n8n las cinco
# credenciales con estos nombres EXACTOS: Supabase, Google Drive, Google Calendar, Gemini API key y WhatsApp token.
# Cada flujo tiene un id fijo: volver a importarlo ACTUALIZA el mismo flujo (no crea otro) y lo deja SIN PUBLICAR: hay que publicarlo de nuevo.
# Uso, desde la carpeta del proyecto con n8n en marcha:   bash herramientas/servidor/importar-flujos.sh
set -euo pipefail

PROYECTO="${SECRETARIA_DIR:-$(pwd)}"
cd "$PROYECTO"

if [ ! -d flujos ] || [ ! -f docker-compose.yml ]; then
  echo "Ejecútalo desde la carpeta del proyecto (la que tiene docker-compose.yml y flujos/)." >&2
  exit 1
fi
if ! docker compose ps --status running --services 2>/dev/null | grep -qx n8n; then
  echo "n8n no está en marcha. Arráncalo con:   docker compose up -d" >&2
  exit 1
fi

DESTINO=/tmp/flujos-secretaria
docker compose exec -T -u root n8n rm -rf "$DESTINO"
docker compose cp flujos "n8n:$DESTINO"
docker compose exec -T -u root n8n chown -R node:node "$DESTINO"
docker compose exec -T -u node n8n n8n import:workflow --separate --input="$DESTINO"
docker compose exec -T -u root n8n rm -rf "$DESTINO"

echo
echo "Flujos importados. En el editor de n8n (Overview): abre cada uno, comprueba que ningún nodo marca la credencial en rojo y publícalo."
echo "Orden: primero «Procesar mensaje» y «Aviso de fallos»; después el resto. «Reiniciar todo» NO se publica."
