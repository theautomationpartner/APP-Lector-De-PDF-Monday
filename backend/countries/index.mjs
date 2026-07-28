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

// ¿Alguno de los países seleccionados tiene pack con enrich? (para saber si vale
// la pena arrancar la decodificación del QR en paralelo con la IA).
export function anyPack(countries = []) {
  return (countries || []).some((c) => PACKS[c]?.enrich)
}

// Enriquecimiento post-LLM. El QR se decodifica UNA vez (idealmente en paralelo con
// la IA: pasar ctx.qr ya decodificado) y se le pasa a cada pack. Best-effort: un
// país que falla no frena a los otros; sin packs, no hace nada.
export async function enrichAll(data, countries, ctx = {}) {
  const packs = (countries || []).map((c) => PACKS[c]).filter((p) => p?.enrich)
  if (!packs.length) return
  const qr = ctx.qr !== undefined ? ctx.qr
    : await decodeInvoiceQr(ctx.fileBase64, ctx.mediaType).catch(() => null)
  const c = { fileBase64: ctx.fileBase64, mediaType: ctx.mediaType, qr }
  for (const pack of packs) {
    try { await pack.enrich(data, c) }
    catch (e) { console.warn(`[pack ${pack.code}] enrich falló:`, e.message) }
  }
}
