import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// La vista corre embebida en un iframe de monday.com.
// - host:true expone el dev server en la red (necesario para el túnel).
// - allowedHosts:true acepta el dominio random del túnel (ngrok/cloudflared).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Aceptar cualquier subdominio del túnel (cloudflared / ngrok) + localhost.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.loca.lt', 'localhost'],
  },
})
