// Configuración de PM2 para correr el backend en el droplet.
// Optimizada para 512 MB de RAM.
//
// Uso (en el droplet, dentro de backend/):
//   pm2 start ecosystem.config.js
//   pm2 save      (persiste para que sobreviva reboots)
//   pm2 startup   (seguir la instrucción que imprime)
//
// Logs: /var/log/pm2/lector-pdf-ia-{out,error}.log

module.exports = {
  apps: [{
    name: 'lector-pdf-ia',
    script: './server.mjs',
    cwd: '/opt/lector-pdf-ia/backend',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    // Si la app supera 350 MB, PM2 la reinicia (margen: 512 - nginx - sistema).
    max_memory_restart: '350M',
    node_args: '--max-old-space-size=350',
    kill_timeout: 5000,
    listen_timeout: 10000,
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/var/log/pm2/lector-pdf-ia-error.log',
    out_file: '/var/log/pm2/lector-pdf-ia-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // Si crashea más de 10 veces antes de estar 30s arriba, PM2 desiste
    // (evita loops de restart si un bug rompe en el arranque).
    max_restarts: 10,
    min_uptime: '30s',
  }],
}