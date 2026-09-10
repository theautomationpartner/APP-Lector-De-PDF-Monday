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

// Extrae el texto de un PDF. Acepta base64 (archivos chicos, que viajan en memoria)
// o un Buffer (archivos grandes, que se leen del disco y nunca se pasan a base64:
// convertirlos sumaria un 33% de memoria justo en el caso que no entra).
// null si no se puede (no es PDF, o es un escaneo sin capa de texto).
export async function pdfText(base64) {
  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') // el /lib evita el self-test del index
    const { text } = await pdfParse(Buffer.isBuffer(base64) ? base64 : Buffer.from(base64, 'base64'))
    return text || null
  } catch (e) { console.warn('[pdfText] no se pudo extraer texto:', e.message); return null }
}

// ── Fechas dadas vuelta ────────────────────────────────────────────────────
// "02/09/2026" es el 2 de septiembre en casi todo el mundo, pero en EE.UU. es el
// 9 de febrero, y el LLM a veces aplica el orden gringo. Como el PDF imprime la
// fecha tal cual, podemos verificarlo sin gastar tokens.
//
// Solo corregimos con evidencia POSITIVA: la forma invertida tiene que estar
// impresa y la del LLM NO. Si el día o el mes es > 12 no hay ambigüedad posible,
// y si son iguales (05/05) da lo mismo. Ante la duda no se toca nada.
const impresa = (y, m, d) =>
  new RegExp(`\\b0?${+d}[/.-]0?${+m}[/.-](?:${y}|${String(y).slice(2)})\\b`)

export function fixSwappedDates(data, text, dateFields) {
  const donde = [String(text), String(text).replace(/\s+/g, '')]
  const hay = (re) => donde.some((t) => re.test(t))
  const fixed = []
  for (const id of dateFields || []) {
    const m = String(data[id] || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) continue
    const [, y, mo, d] = m
    if (+mo > 12 || +d > 12 || mo === d) continue    // sin ambigüedad → nada que decidir
    if (hay(impresa(y, mo, d))) continue             // lo que dijo el LLM está impreso → OK
    if (!hay(impresa(y, d, mo))) continue            // la invertida tampoco está → sin evidencia
    data[id] = `${y}-${d}-${mo}`
    fixed.push(id)
  }
  return fixed
}

// ── Ancho del punto de venta ───────────────────────────────────────────────
// ARCA admite hasta 5 dígitos y cada emisor imprime lo suyo: los comprobantes de
// "Comprobantes en línea" salen con 5 ("Punto de Venta: 00001") y muchos sistemas
// privados con 4 ("0090-00434782"). Pedírselo al modelo NO funciona: con el mismo
// prompt y temperatura 0 a veces devuelve 00001 y a veces 0001, porque el formato
// de 4 pesa mucho en lo que aprendió. Cuando el PDF tiene texto lo sacamos de ahí,
// que es exacto y gratis. Corregir ar_punto_venta alcanza: el pack de AR arma
// después el invoice_number con ese ancho.
export function fixPuntoVenta(data, text) {
  const m = text.match(/Punto\s*de\s*Venta\s*:?\s*(\d{4,5})\b/i) ||
            text.match(/\b(\d{4,5})\s*-\s*(\d{8})\b/)
  if (!m) return null
  const impreso = m[1]
  const actual = String(data.ar_punto_venta || '').replace(/\D/g, '')
  // Solo tocamos el ANCHO: si el valor no coincide, el problema es otro y no es
  // nuestro (no vamos a pisar un número distinto con el primero que encontramos).
  if (!actual || Number(actual) !== Number(impreso) || actual === impreso) return null
  data.ar_punto_venta = impreso
  const partes = String(data.invoice_number || '').split('-')
  if (partes.length === 2) data.invoice_number = `${impreso}-${partes[1]}`
  return impreso
}

// Verifica/corrige contra el texto del PDF: los códigos largos (chave, CUFE, CAE,
// UUID) que el LLM pudo transcribir mal, y las fechas que pudo dar vuelta.
// Estrategia (combinar LLM + determinístico): si el valor del LLM ya aparece en el
// texto → confirmado, se deja. Si no → se recupera el valor exacto del texto.
// Devuelve { codes, dates } con los campos corregidos.
export async function reconcileCodes(data, base64, activeFields, dateFields) {
  const text = await pdfText(base64)
  if (!text) return { codes: [], dates: [] }   // foto/scan sin capa de texto → queda lo del LLM
  const normText = norm(text)
  const active = new Set((activeFields || []).map(([id]) => id))
  const codes = []
  for (const [id, extract] of Object.entries(CODE_EXTRACTORS)) {
    if (!active.has(id)) continue
    const llm = norm(data[id])
    if (llm && normText.includes(llm)) continue        // el LLM coincide con el texto → OK
    const exact = extract(text)                          // ausente o incorrecto → recuperar del texto
    if (exact && norm(exact) !== llm) { data[id] = exact; codes.push(id) }
  }
  const dates = fixSwappedDates(data, text, (dateFields || []).filter((f) => active.has(f)))
  const pv = active.has('ar_punto_venta') ? fixPuntoVenta(data, text) : null
  return { codes, dates, pv }
}
