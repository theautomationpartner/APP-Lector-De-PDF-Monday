// countries/index.mjs — Registro de "country packs". Cada país es un módulo
// autocontenido con { prompt, enrich }. El pipeline (extractor) es GENÉRICO y no
// cambia nunca: agregar un país = crear su archivo y sumarlo acá. Una sola línea.
import { decodeInvoiceQr } from '../qr.mjs'
import ar from './ar.mjs'

export const PACKS = {
  AR: ar,
  // CL: cl, UY: uy, MX: mx, ...  ← el molde se replica
}

// Bloques de prompt específicos de los países seleccionados (los que tienen pack).
export function promptFor(countries = []) {
  const blocks = (countries || []).map((c) => PACKS[c]?.prompt).filter(Boolean)
  return blocks.length ? '\n\n' + blocks.join('\n\n') : ''
}

// Enriquecimiento post-LLM: el QR se decodifica UNA sola vez y se le pasa a cada
// pack (ej. AR pisa los campos fiscales con el QR de AFIP). Best-effort: un país
// que falla no frena a los otros; sin packs, no se decodifica nada.
export async function enrichAll(data, countries, fileBase64, mediaType) {
  const packs = (countries || []).map((c) => PACKS[c]).filter((p) => p?.enrich)
  if (!packs.length) return
  let qr = null
  try { qr = await decodeInvoiceQr(fileBase64, mediaType) } catch { /* sin QR */ }
  const ctx = { fileBase64, mediaType, qr }
  for (const pack of packs) {
    try { await pack.enrich(data, ctx) }
    catch (e) { console.warn(`[pack ${pack.code}] enrich falló:`, e.message) }
  }
}
