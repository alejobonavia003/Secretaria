#!/usr/bin/env bash
# Copia COMPLETA y ESTRUCTURADA de n8n, pensada para llevarla a otro equipo (por ejemplo, un PC con Windows y Docker Desktop).
# Uso en el servidor, desde la carpeta del proyecto (/root/Secretaria):   bash herramientas/servidor/copia-completa.sh
# Deja en "copias/" una carpeta completa_AAAA-MM-DD_HHMM/ y un único archivo secretaria_n8n_completa_AAAA-MM-DD_HHMM.tar.gz con todo dentro:
#   volumen-n8n.tar.gz        el volumen entero de n8n (flujos, credenciales cifradas, usuario, ejecuciones). Es la copia que manda al restaurar.
#   n8n-exportado/flujos/     un JSON por flujo (legible y reutilizable aunque el volumen no sirva)
#   n8n-exportado/credenciales/   las credenciales exportadas, SIEMPRE cifradas con N8N_ENCRYPTION_KEY
#   docker-compose.yml        el compose con la versión de n8n fijada
#   env-plantilla.txt         SOLO los nombres de las variables del .env, sin valores (para saber qué hay que volver a crear)
#   versiones.txt             versión de n8n, imagen y fecha
#   LEEME.txt                 cómo restaurarla paso a paso
#   SHA256SUMS                sumas de comprobación (para saber que la copia no se ha dañado al moverla)
# LO QUE NO LLEVA, A PROPÓSITO: el .env (tiene secretos) ni N8N_ENCRYPTION_KEY. Cópialos tú aparte y por un canal seguro (gestor de
# contraseñas o scp por separado). Sin la clave, las credenciales de la copia no se pueden descifrar.
# La primera vez, comprueba que el archivo final pesa varios MB y que
# n8n-exportado/flujos/ tiene un .json por flujo. Si las exportaciones fallan, la copia del volumen sigue siendo válida.
set -euo pipefail
# La copia lleva las credenciales (cifradas) y el historial de n8n: solo el dueño puede leer lo que se cree aquí
umask 077

VOLUMEN="secretaria_n8n_data"
CARPETA="$PWD/copias"
FECHA="$(date +%Y-%m-%d_%H%M)"
DESTINO="$CARPETA/completa_$FECHA"
ARCHIVO_FINAL="$CARPETA/secretaria_n8n_completa_$FECHA.tar.gz"

if ! docker volume inspect "$VOLUMEN" >/dev/null 2>&1; then
  echo "No existe el volumen Docker '$VOLUMEN'. Comprueba el nombre con: docker volume ls" >&2
  exit 1
fi
if [ ! -f docker-compose.yml ]; then
  echo "No encuentro docker-compose.yml: ejecuta el script desde la carpeta del proyecto (Secretaria)." >&2
  exit 1
fi

mkdir -p "$DESTINO/n8n-exportado/flujos" "$DESTINO/n8n-exportado/credenciales"
chmod 700 "$CARPETA"

# 1) El volumen entero, montado de SOLO LECTURA (n8n puede seguir funcionando)
echo "1/5 Copiando el volumen de n8n..."
docker run --rm -v "$VOLUMEN":/datos:ro -v "$DESTINO":/copia alpine tar czf /copia/volumen-n8n.tar.gz -C /datos .
TAM="$(stat -c %s "$DESTINO/volumen-n8n.tar.gz")"
if [ "$TAM" -lt 1024 ]; then
  echo "La copia del volumen pesa solo $TAM bytes: algo ha ido mal." >&2
  exit 1
fi

# 2) Exportación legible de flujos y credenciales (necesita n8n en marcha; si falla, se avisa y se sigue)
echo "2/5 Exportando flujos y credenciales (cifradas)..."
if docker compose ps --status running --services 2>/dev/null | grep -qx n8n; then
  docker compose exec -T n8n sh -c 'rm -rf /tmp/exp && mkdir -p /tmp/exp/flujos /tmp/exp/credenciales'
  if docker compose exec -T n8n n8n export:workflow --all --separate --output=/tmp/exp/flujos/ >/dev/null 2>&1 \
     && docker compose cp n8n:/tmp/exp/flujos/. "$DESTINO/n8n-exportado/flujos/" >/dev/null 2>&1; then
    echo "   flujos exportados: $(ls -1 "$DESTINO/n8n-exportado/flujos" | wc -l)"
  else
    echo "   AVISO: no se pudieron exportar los flujos. La copia del volumen sigue siendo válida." >&2
  fi
  if docker compose exec -T n8n n8n export:credentials --all --separate --output=/tmp/exp/credenciales/ >/dev/null 2>&1 \
     && docker compose cp n8n:/tmp/exp/credenciales/. "$DESTINO/n8n-exportado/credenciales/" >/dev/null 2>&1; then
    echo "   credenciales exportadas (cifradas): $(ls -1 "$DESTINO/n8n-exportado/credenciales" | wc -l)"
  else
    echo "   AVISO: no se pudieron exportar las credenciales. La copia del volumen sigue siendo válida." >&2
  fi
  docker compose exec -T n8n rm -rf /tmp/exp >/dev/null 2>&1 || true
  VERSION_N8N="$(docker compose exec -T n8n n8n --version 2>/dev/null | tr -d '\r' || echo desconocida)"
else
  echo "   AVISO: n8n no está en marcha: se omite la exportación (el volumen sí se ha copiado)." >&2
  VERSION_N8N="desconocida (n8n parado)"
fi

# 3) Compose, nombres de variables (sin valores) y versiones
echo "3/5 Guardando compose, variables y versiones..."
cp docker-compose.yml "$DESTINO/docker-compose.yml"
if [ -f .env ]; then
  # Solo "NOMBRE=": los valores nunca salen del .env
  sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1=/' .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=$' > "$DESTINO/env-plantilla.txt" || true
else
  echo "# (no había .env en esta carpeta)" > "$DESTINO/env-plantilla.txt"
fi
{
  echo "fecha=$FECHA"
  echo "n8n=$VERSION_N8N"
  echo "imagen=$(grep -m1 'image:' docker-compose.yml | sed 's/^ *image: *//')"
  echo "volumen=$VOLUMEN"
} > "$DESTINO/versiones.txt"

# 4) Instrucciones de restauración
echo "4/5 Escribiendo LEEME.txt y las sumas de comprobación..."
cat > "$DESTINO/LEEME.txt" <<'FIN'
COPIA COMPLETA DE N8N (Secretaria)

Qué es: el volumen entero de n8n más una exportación legible de los flujos y las credenciales (cifradas).
Qué NO es: no incluye el .env ni N8N_ENCRYPTION_KEY, ni los datos de Supabase (están en la nube, en tu proyecto de Supabase),
ni los archivos de Drive ni los eventos de Calendar.

ANTES DE RESTAURAR (en el equipo nuevo)
 1. Instala Docker (Docker Desktop en Windows) y Git si lo vas a usar.
 2. La carpeta del proyecto DEBE llamarse "Secretaria" (Docker nombra el volumen con el nombre de la carpeta: secretaria_n8n_data).
    Copia en ella el proyecto (docker-compose.yml de esta copia sirve).
 3. Crea el archivo .env con las MISMAS variables que en el servidor (mira env-plantilla.txt: solo trae los nombres). Lo imprescindible:
    la clave de cifrado de n8n con EXACTAMENTE el mismo valor que tenía el servidor. Con otro valor n8n arranca pero NO descifra las
    credenciales. Va en el archivo secretos/n8n_encryption_key (una sola línea), no en el .env.
    Pon también N8N_WEBHOOK_URL con la dirección pública del equipo nuevo (con https y barra final).
 4. Comprueba las sumas:   sha256sum -c SHA256SUMS   (en Linux/Git Bash)

RESTAURAR
 Linux:     bash restaurar-n8n.sh volumen-n8n.tar.gz        (desde la carpeta Secretaria)
 Windows:   powershell -File herramientas\copias\restaurar-n8n.ps1 -Archivo ruta\a\volumen-n8n.tar.gz
 Después:   docker compose up -d     (NO "restart": hay que recrear el contenedor para que lea el .env)

DESPUÉS DE RESTAURAR
 - Entra en n8n: deberían estar los flujos, las credenciales y tu usuario.
 - Credenciales de Google (Calendar y Drive): si la dirección pública cambió, hay que añadir la nueva URL de redirección en Google Cloud
   (Credenciales > tu cliente OAuth) y volver a pulsar «Sign in with Google» en cada credencial.
 - Meta (WhatsApp): registra la URL nueva del webhook y comprueba el token de verificación.
 - Publica los flujos que no estén publicados (en n8n 2.x los flujos se publican; los subflujos primero).
 - Prueba: un mensaje de texto, un recordatorio y una foto.

SI SOLO TIENES LOS JSON (el volumen no sirve)
 Importa los de n8n-exportado/flujos/ desde n8n (Import from file) y las credenciales de n8n-exportado/credenciales/ con
 "n8n import:credentials --input=..." (solo se descifran con la misma N8N_ENCRYPTION_KEY). Si no la tienes, crea las credenciales a mano.
FIN
( cd "$DESTINO" && find . -type f ! -name SHA256SUMS -print0 | xargs -0 sha256sum > SHA256SUMS )

# 5) Un único archivo para moverlo, y limpieza de copias viejas
echo "5/5 Empaquetando..."
# El script de restauración viaja dentro de la copia (así el equipo nuevo no depende de nada más)
for f in restaurar-n8n.sh restaurar-n8n.ps1; do
  for sitio in "./$f" "herramientas/servidor/$f" "herramientas/copias/$f"; do
    if [ -f "$sitio" ]; then cp "$sitio" "$DESTINO/$f"; break; fi
  done
done
tar czf "$ARCHIVO_FINAL" -C "$CARPETA" "completa_$FECHA"
echo
echo "Copia creada: copias/secretaria_n8n_completa_$FECHA.tar.gz ($(( $(stat -c %s "$ARCHIVO_FINAL") / 1024 / 1024 )) MB)"
echo "Bájala FUERA del servidor (desde tu PC):   scp root@LA-IP:/root/Secretaria/copias/secretaria_n8n_completa_$FECHA.tar.gz ."
echo "RECUERDA guardar APARTE el .env y la clave de secretos/n8n_encryption_key en tu gestor de contraseñas: sin la clave la copia no descifra las credenciales."

# Conserva solo las 7 copias completas más recientes (y borra la carpeta de trabajo de esta: ya está dentro del .tar.gz)
rm -rf "$DESTINO"
ls -1t "$CARPETA"/secretaria_n8n_completa_*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
