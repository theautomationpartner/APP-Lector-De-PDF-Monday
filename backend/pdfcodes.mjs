// Capa DETERMINÍSTICA para códigos largos (chave, CUFE, CAE, UUID…).
// Los LLMs se equivocan transcribiendo cadenas largas de dígitos (limitación de
// tokenización). Pero la factura electrónica es un PDF con capa de texto donde el
// código está EXACTO. Acá lo verificamos contra ese texto y, si el LLM no coincide,
// lo corregimos con el valor real. Gratis (sin tokens) y exacto. Solo PDFs digitales
// (las fotos no tienen capa de texto → queda el valor del LLM).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const norm = (s) => String(s || '').replace(/[^0-9a-z]/gi, '').toUpperCase()

// Extractor por campo: recibe el texto del PDF y devuelve el código exacto o null.
export const CODE_EXTRACTORS = {
  // Argentina — CAE: 14 dígitos tras "CAE"
  ar_cae:          (t) => { const m = t.match(/CAE\s*(?:N[°º.]*)?\s*:?\s*(\d{14})\b/i); return m ? m[1] : null },
  // Brasil — Chave de acesso: 44 dígitos (impresos con espacios) tras "CHAVE DE ACESSO"
  br_chave_acesso: (t) => { const m = t.match(/chave\s*de\s*acesso\s*([\d\s.]{44,90})/i); if (!m) return null; const d = m[1].replace(/\D/g, ''); return d.length >= 44 ? d.slice(0, 44) : null },
  // Colombia — CUFE: ~96 hex tras "CUFE"
  co_cufe:         (t) => { const m = t.match(/CUFE\s*:?\s*([0-9a-f]{90,100})/i); return m ? m[1].toLowerCase() : null },
  // Ecuador — Clave de acceso: 49 dígitos (impresos con espacios) tras "CLAVE DE ACCESO"
  ec_clave_acceso: (t) => { const m = t.match(/clave\s*de\s*acceso\s*([\d\s]{49,90})/i); if (!m) return null; const d = m[1].replace(/\D/g, ''); return d.length >= 49 ? d.slice(0, 49) : null },
  // México — Folio Fiscal (UUID 8-4-4-4-12 hex)
  mx_folio_fiscal: (t) => { const m = t.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i); return m ? m[1].toUpperCase() : null },
  // Uruguay — Nº CAE (número largo)
  uy_cae:          (t) => { const m = t.match(/(?:Nro\.?\s*)?CAE\s*(?:N[°º.]*)?\s*:?\s*(\d{9,14})\b/i); return m ? m[1] : null },
}

// Extrae el texto de un PDF (base64). null si no se puede (no es PDF con capa de texto).
export async function pdfText(base64) {
  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') // el /lib evita el self-test del index
    const { text } = await pdfParse(Buffer.from(base64, 'base64'))
    return text || null
  } catch (e) { console.warn('[pdfText] no se pudo extraer texto:', e.message); return null }
}

// Verifica/corrige los códigos largos de `data` contra el texto del PDF.
// Estrategia (combinar LLM + determinístico): si el valor del LLM ya aparece en el
// texto → confirmado, se deja. Si no → se recupera el valor exacto del texto.
// Devuelve la lista de campos corregidos.
export async function reconcileCodes(data, base64, activeFields) {
  const text = await pdfText(base64)
  if (!text) return []           // foto/scan sin capa de texto → queda lo del LLM
  const normText = norm(text)
  const active = new Set((activeFields || []).map(([id]) => id))
  const fixed = []
  for (const [id, extract] of Object.entries(CODE_EXTRACTORS)) {
    if (!active.has(id)) continue
    const llm = norm(data[id])
    if (llm && normText.includes(llm)) continue        // el LLM coincide con el texto → OK
    const exact = extract(text)                          // ausente o incorrecto → recuperar del texto
    if (exact && norm(exact) !== llm) { data[id] = exact; fixed.push(id) }
  }
  return fixed
}
