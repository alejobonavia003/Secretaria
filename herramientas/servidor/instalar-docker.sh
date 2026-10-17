#!/usr/bin/env bash
# Instala Docker Engine y el plugin de Compose en Ubuntu con el repositorio oficial de Docker.
# Fuente: https://docs.docker.com/engine/install/ubuntu/. Ubuntu admitido por esa documentación: 22.04, 24.04 y 26.04.
# Uso en el servidor, como root:   bash herramientas/servidor/instalar-docker.sh
# Al acabar debe salir el mensaje de «hello-world».
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecútalo como root (o con sudo)." >&2
  exit 1
fi

. /etc/os-release
case "${VERSION_ID:-}" in
  22.04 | 24.04 | 26.04) ;;
  *)
    echo "Ubuntu ${VERSION_ID:-desconocido} no figura en la documentación de Docker (22.04, 24.04 y 26.04). Para." >&2
    exit 1
    ;;
esac

# 1. Quitar paquetes que chocan con Docker (si no hay ninguno, no pasa nada)
apt remove -y $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc 2>/dev/null | cut -f1) || true

# 2. Repositorio oficial de Docker
apt update
apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt update

# 3. Docker
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# 4. Comprobación
docker --version
docker compose version
docker run --rm hello-world
echo "Docker instalado y funcionando."
