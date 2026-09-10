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
// maxSide acota el lado largo ANTES de pasar a crudo. Una foto de celular de 12 MP
// en RGBA son ~48 MB por intento; a 2400 px baja a ~17 MB. El QR se sigue leyendo:
// necesita nitidez del patrón, no megapíxeles. Sin esto, varias fotos a la vez
// pasaban el tope de memoria de PM2 y el proceso moría a mitad de la lectura,
// dejando el ítem clavado en "Leyendo Comprobante" (caso real, 2026-08).
async function scan(imgBuf, maxSide = 0) {
  for (const prep of [false, true]) {
    try {
      let pipe = sharp(imgBuf)
      if (maxSide) pipe = pipe.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      if (prep) pipe = pipe.grayscale().normalize()
      const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const res = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'attemptBoth' })
      if (res?.data) return res.data
    } catch { /* probar siguiente estrategia */ }
  }
  return null
}

// Devuelve el CONTENIDO del QR (string) o null. PDFs: escala adaptativa 3→4 sobre
// las primeras páginas (el QR fiscal suele ir en la 1ª o repetido). Imágenes: directo.
let enCola = Promise.resolve()
export function decodeInvoiceQr(fileBase64, mediaType) {
  const turno = enCola.then(() => decodeAhora(fileBase64, mediaType))
  enCola = turno.catch(() => {}) // la cola sigue aunque una falle
  return turno
}

async function decodeAhora(fileBase64, mediaType) {
  try {
    // Acepta base64 (archivos chicos) o Buffer (grandes, leidos del disco).
    const buf = Buffer.isBuffer(fileBase64) ? fileBase64 : Buffer.from(fileBase64, 'base64')
    if (mediaType !== 'application/pdf') return await scan(buf, 2400) // foto / scan
    // Renderizar una página cuesta 40-90 MB. Antes probábamos 2 escalas × 3 páginas
    // = hasta 6 renders por factura, y con un PDF pesado el proceso moría por falta
    // de memoria a mitad de la lectura. Ahora: escala 3 en las 2 primeras páginas
    // (el QR fiscal va casi siempre en la 1ª) y, sólo si no apareció, escala 4 en la
    // primera. Máximo 3 renders.
    // El esfuerzo se ajusta al PESO del PDF. Un escaneo de 9 MB renderizado a escala 3
    // consume cientos de MB y mataba el proceso a mitad de la lectura (caso real: el
    // ítem quedaba clavado en "Leyendo"). El QR es un extra —da los datos fiscales
    // exactos gratis— pero NUNCA vale perder la factura entera por intentarlo.
    const pesoMb = buf.length / 1048576
    const plan = pesoMb <= 3 ? [[3, 2], [4, 1]] : pesoMb <= 8 ? [[2, 1]] : null
    if (!plan) {
      console.warn(`[qr] PDF de ${Math.round(pesoMb)}MB: no intento leer el QR (riesgo de quedarme sin memoria). La IA lee la factura igual.`)
      return null
    }
    for (const [scale, maxPages] of plan) {
      const doc = await pdf(buf, { scale })
      let page = 0
      for await (const png of doc) {
        const r = await scan(png)
        if (r) return r
        if (++page >= maxPages) break
      }
    }
    return null
  } catch (e) {
    console.warn('[qr] no se pudo decodificar:', e.message)
    return null
  }
}
