import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// La vista corre embebida en un iframe de monday.com.
// - host:true expone el dev server en la red (necesario para el túnel).
// - allowedHosts:true acepta el dominio random del túnel (ngrok/cloudflared).
// Sello de compilación, visible en la pantalla. Sin esto, cuando algo no coincide
// entre lo que se ve y lo que se guarda no hay forma de saber si el navegador está
// corriendo el código nuevo o uno cacheado — y se pierden horas adivinando.
const SELLO = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  define: { __BUILD__: JSON.stringify(SELLO) },
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Aceptar cualquier subdominio del túnel (cloudflared / ngrok) + localhost.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.loca.lt', 'localhost'],
  },
})
