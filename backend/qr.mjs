// qr.mjs — Decodifica el código QR de una factura (PDF o imagen). Los QR de las
// facturas electrónicas de LatAm (AFIP AR, CFDI MX, DTE CL, CFE UY, DIAN CO)
// traen los datos fiscales EXACTOS y estructurados. Leerlos es determinístico y
// GRATIS (sin IA). Best-effort: si no hay QR legible, devuelve null y el flujo
// sigue con lo que extrajo el LLM.
import { pdf } from 'pdf-to-img'
import sharp from 'sharp'
import jsQR from 'jsqr'

// Escanea un buffer de imagen buscando un QR. Prueba en crudo y luego en escala
// de grises normalizada (más contraste = más chance de leerlo).
async function scan(imgBuf) {
  for (const prep of [false, true]) {
    try {
      const pipe = prep ? sharp(imgBuf).grayscale().normalize() : sharp(imgBuf)
      const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const res = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'attemptBoth' })
      if (res?.data) return res.data
    } catch { /* probar siguiente estrategia */ }
  }
  return null
}

// Devuelve el CONTENIDO del QR (string) o null. PDFs: escala adaptativa 3→4 sobre
// las primeras páginas (el QR fiscal suele ir en la 1ª o repetido). Imágenes: directo.
export async function decodeInvoiceQr(fileBase64, mediaType) {
  try {
    const buf = Buffer.from(fileBase64, 'base64')
    if (mediaType !== 'application/pdf') return await scan(buf) // foto / scan
    for (const scale of [3, 4]) {                                // más resolución si la 1ª no leyó
      const doc = await pdf(buf, { scale })
      let page = 0
      for await (const png of doc) {
        const r = await scan(png)
        if (r) return r
        if (++page >= 3) break                                   // cota de memoria/tiempo (droplet 512MB)
      }
    }
    return null
  } catch (e) {
    console.warn('[qr] no se pudo decodificar:', e.message)
    return null
  }
}
