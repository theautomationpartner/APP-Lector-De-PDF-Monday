# Deploy de Lector PDF IA en el droplet (DigitalOcean)

Guía paso a paso. Está pensada para correr cuando ya tengas el acceso al droplet.

## Requisitos (los pide tu jefe)
- Acceso SSH al droplet `167.172.137.150` (usuario `root`).
- Un subdominio apuntando a esa IP (ej: `lector.theautomationpartner.com`)
  **o** usamos un nombre gratis tipo `167-172-137-150.nip.io`.

## Secretos que vas a necesitar
- `ANTHROPIC_API_KEY` — de Anthropic.
- `MONDAY_SIGNING_SECRET` + `MONDAY_CLIENT_SECRET` — Monday Developer Center → app 11460961 → Secrets.
- `DATABASE_URL` — Postgres (usar el host **PRIVADO/VPC**, no el público).
- CA cert de la DB — DO panel → Databases → tu cluster → **Download CA certificate**.

---

## 1. Provisionar el servidor (una sola vez)
Desde tu PC, subir el script y correrlo:
```
scp deploy/setup.sh root@167.172.137.150:/root/
ssh root@167.172.137.150
bash /root/setup.sh
```
Instala Node 20, nginx, PM2, certbot.

## 2. Subir el código a /opt/lector-pdf-ia
**Opción git** (recomendada — el repo es público, no necesita auth):
```
git clone https://github.com/theautomationpartner/APP-Lector-De-PDF-Monday.git /opt/lector-pdf-ia
```
**Opción scp/rsync** (sin git todavía), desde tu PC en la carpeta `lector-pdf-ia/`:
```
rsync -av --exclude node_modules --exclude .env --exclude dist --exclude public \
  ./ root@167.172.137.150:/opt/lector-pdf-ia/
```

## 3. Instalar deps + build del frontend
```
ssh root@167.172.137.150
cd /opt/lector-pdf-ia/frontend && npm install && npm run build
cd /opt/lector-pdf-ia/backend  && npm install --omit=dev && npm run copy-frontend
```

## 4. CA cert + .env
```
mkdir -p /opt/lector-pdf-ia/backend/certs
# subir el CA cert de la DB a: backend/certs/do-pg-ca.crt
cp /opt/lector-pdf-ia/backend/.env.example /opt/lector-pdf-ia/backend/.env
nano /opt/lector-pdf-ia/backend/.env
```
En el `.env` completar: `ANTHROPIC_API_KEY`, `MONDAY_SIGNING_SECRET`, `MONDAY_CLIENT_SECRET`,
`DATABASE_URL` (con el host **privado/VPC** + `?sslmode=require`), `PORT=8080`.

## 5. Arrancar con PM2
```
cd /opt/lector-pdf-ia/backend
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # ejecutar la línea que imprime (para que arranque solo tras reboot)
curl http://localhost:8080/health   # -> {"ok":true}
```

## 6. nginx + HTTPS
```
cp /opt/lector-pdf-ia/deploy/nginx.conf.example /etc/nginx/sites-available/lector-pdf-ia
nano /etc/nginx/sites-available/lector-pdf-ia      # poner server_name = tu subdominio
ln -s /etc/nginx/sites-available/lector-pdf-ia /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d TU_SUBDOMINIO                   # HTTPS gratis (Let's Encrypt)
```
(Si usás **Cloudflare** en "orange cloud", el HTTPS lo da Cloudflare y este último paso de certbot no hace falta.)

## 7. Re-apuntar la app de Monday (App ID 11460961)
En el Developer Center, **no se crea nada nuevo**, se re-apunta:
- **Board View** (vista de config) → URL: `https://TU_SUBDOMINIO/`
- **Acción / receta** → URL: `https://TU_SUBDOMINIO/monday/extract`
- Cargar `MONDAY_SIGNING_SECRET` y `MONDAY_CLIENT_SECRET`.
- Probar en versión **Draft** → promover a **Live**.
- En el board de prueba: **eliminar la receta vieja y crearla de nuevo** (para que tome la versión nueva).

## 8. Seguridad (al final, una vez que anda)
- Rotar la contraseña de la DB (DO → Databases → Users → Reset password).
- **Trusted Sources** → dejar solo el droplet.
- Actualizar `DATABASE_URL` en el `.env` con la nueva contraseña y `pm2 reload lector-pdf-ia --update-env`.

---

## Verificación final
```
curl https://TU_SUBDOMINIO/health        # -> {"ok":true}
```
Abrir la app en un board de Monday → debería cargar la vista de mapeo.