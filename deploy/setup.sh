#!/usr/bin/env bash
# Provisiona el droplet (Ubuntu) para correr Lector PDF IA.
# Correr UNA sola vez, como root:  bash setup.sh
set -euo pipefail

echo "==> Actualizando sistema"
apt-get update -y && apt-get upgrade -y

echo "==> Instalando Node 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "==> Instalando nginx, git y certbot (HTTPS gratis)"
apt-get install -y nginx git certbot python3-certbot-nginx

echo "==> Instalando PM2 (global)"
npm install -g pm2

echo "==> Creando carpetas"
mkdir -p /var/log/pm2 /opt/lector-pdf-ia

echo ""
echo "==> Listo. Versiones instaladas:"
node -v && echo "nginx $(nginx -v 2>&1)" && echo "pm2 $(pm2 -v)"
echo ""
echo "Próximo paso: subir el código a /opt/lector-pdf-ia y seguir DEPLOY.md (paso 2 en adelante)."