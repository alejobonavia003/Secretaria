# Restaura el volumen de n8n desde un volumen-n8n.tar.gz (el de una copia completa de herramientas/servidor/copia-completa.sh,
# de una copia hecha en el servidor) en Windows con Docker Desktop.
# Uso (PowerShell, desde la carpeta del proyecto, que DEBE llamarse "Secretaria"):
#     powershell -File herramientas\copias\restaurar-n8n.ps1 -Archivo C:\ruta\volumen-n8n.tar.gz
# Después:  docker compose up -d      (no "restart")
# - Si el volumen ya tiene datos, pide escribir SI antes de sobrescribirlos.
# - La clave N8N_ENCRYPTION_KEY debe ser LA MISMA con la que se hizo la copia.
# - La clave va en secretos/n8n_encryption_key (una sola línea; nunca en el .env).
# Se ejecuta en Windows con Docker Desktop abierto.
param(
  [Parameter(Mandatory = $true)][string]$Archivo
)
$ErrorActionPreference = 'Stop'
$volumen = 'secretaria_n8n_data'

if (-not (Test-Path -LiteralPath $Archivo -PathType Leaf)) { Write-Error "No existe el archivo: $Archivo"; exit 1 }
$carpetaProyecto = (Get-Item -LiteralPath .).Name
if ($carpetaProyecto.ToLower() -ne 'secretaria') {
  Write-Warning "La carpeta actual se llama '$carpetaProyecto' y debería ser 'Secretaria': con otro nombre Docker Compose usaría otro volumen."
  if ((Read-Host '¿Seguir de todos modos? (escribe SI)') -ne 'SI') { exit 1 }
}
if (-not (Test-Path .env)) { Write-Warning 'No hay .env en esta carpeta: créalo antes de arrancar n8n (las variables de WhatsApp y N8N_WEBHOOK_URL).' }
if (-not (Test-Path secretos\n8n_encryption_key)) { Write-Warning 'Falta secretos\n8n_encryption_key (la clave de cifrado, una sola línea). Sin él, docker compose up -d no arranca n8n.' }

docker compose stop n8n 2>$null | Out-Null

$existe = docker volume ls -q --filter "name=^$volumen$"
if ($existe) {
  $contenido = docker run --rm -v "${volumen}:/d" alpine sh -c 'ls -A /d | wc -l'
  if ([int]$contenido -gt 0) {
    Write-Host "El volumen $volumen ya tiene datos ($contenido elementos). Restaurar los SOBRESCRIBE."
    if ((Read-Host '¿Sobrescribir? (escribe SI)') -ne 'SI') { Write-Host 'Cancelado.'; exit 1 }
  }
} else {
  docker volume create $volumen | Out-Null
}

$ruta = (Resolve-Path -LiteralPath $Archivo).Path
$carpeta = Split-Path -Parent $ruta
$nombre = Split-Path -Leaf $ruta
docker run --rm -v "${volumen}:/datos" -v "${carpeta}:/copia:ro" alpine tar xzf "/copia/$nombre" -C /datos
if ($LASTEXITCODE -ne 0) { Write-Error 'La restauración falló.'; exit 1 }

Write-Host 'Contenido restaurado en el volumen:'
docker run --rm -v "${volumen}:/datos" alpine ls -la /datos
Write-Host 'Listo. Arranca n8n con:  docker compose up -d'
