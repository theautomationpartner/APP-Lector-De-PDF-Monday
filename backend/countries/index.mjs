// countries/index.mjs — Registro de "country packs". Cada país es un módulo
// autocontenido con { prompt, enrich }. El pipeline (extractor) es GENÉRICO y no
// cambia nunca: agregar un país = crear su archivo y sumarlo acá. Una sola línea.
import { decodeInvoiceQr } from '../qr.mjs'
import ar from './ar.mjs'
import arRemito from './ar.remito.mjs'

// Dos dimensiones: PAÍS × TIPO DE DOCUMENTO. Un tablero elige un país y un tipo.
// Agregar un país = una fila. Agregar un tipo de documento = una columna.
export const PACKS = {
  AR: { fiscal: ar, remito: arRemito },
  // CL: { fiscal: cl }, UY: { fiscal: uy }, ...  ← el molde se replica
}

// El pack de un país para un tipo de documento (null si ese país no lo soporta).
const packOf = (c, kind = 'fiscal') => PACKS[c]?.[kind] || null

// Bloques de prompt específicos de los países seleccionados (los que tienen pack).
export function promptFor(countries = [], kind = 'fiscal') {
  const blocks = (countries || []).map((c) => packOf(c, kind)?.prompt).filter(Boolean)
  return blocks.length ? '\n\n' + blocks.join('\n\n') : ''
}

// ¿Alguno de los países seleccionados tiene pack con enrich? (para saber si vale
// la pena arrancar la decodificación del QR en paralelo con la IA).
export function anyPack(countries = [], kind = 'fiscal') {
  return (countries || []).some((c) => packOf(c, kind)?.enrich)
}

// ¿Este tipo de documento necesita el QR? Los remitos NO lo tienen (llevan CAI de
// imprenta), así que ni se intenta decodificar: es tiempo y memoria a cambio de nada.
export const usaQr = (kind = 'fiscal') => kind !== 'remito'

// Enriquecimiento post-LLM. El QR se decodifica UNA vez (idealmente en paralelo con
// la IA: pasar ctx.qr ya decodificado) y se le pasa a cada pack. Best-effort: un
// país que falla no frena a los otros; sin packs, no hace nada.
// Devuelve { warnings: [{key, vars}] } — controles que no cerraron (CAE con largo
// raro, desglose que no suma). El caller los muestra en el comentario del ítem:
// antes solo quedaban en el log del server y el usuario nunca se enteraba.
export async function enrichAll(data, countries, ctx = {}, kind = 'fiscal') {
  const packs = (countries || []).map((c) => packOf(c, kind)).filter((p) => p?.enrich)
  if (!packs.length) return { warnings: [] }
  const qr = !usaQr(kind) ? null
    : ctx.qr !== undefined ? ctx.qr
    : await decodeInvoiceQr(ctx.fileBase64, ctx.mediaType).catch(() => null)
  const c = { fileBase64: ctx.fileBase64, mediaType: ctx.mediaType, qr }
  const warnings = []
  for (const pack of packs) {
    try {
      const r = await pack.enrich(data, c)
      if (Array.isArray(r?.warnings)) warnings.push(...r.warnings)
    } catch (e) { console.warn(`[pack ${pack.code}] enrich falló:`, e.message) }
  }
  return { warnings }
}
