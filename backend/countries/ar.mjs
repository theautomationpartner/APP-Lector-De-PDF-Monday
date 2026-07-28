// countries/ar.mjs — Pack de Argentina (AFIP/ARCA).
// Estrategia 99%: el QR de AFIP trae los datos fiscales EXACTOS (CUIT, punto de
// venta, tipo, número, fecha, total, CAE) → los pisamos sobre lo que sacó el LLM
// (ground truth). El LLM queda solo para lo semántico (nombres, domicilios,
// renglones, condición IVA, subtotal/IVA). Todo determinístico y sin costo extra.

// ── Códigos AFIP de tipo de comprobante → [base, letra] ──
const TIPO = {
  1: ['Factura', 'A'], 2: ['Nota de Débito', 'A'], 3: ['Nota de Crédito', 'A'],
  6: ['Factura', 'B'], 7: ['Nota de Débito', 'B'], 8: ['Nota de Crédito', 'B'],
  11: ['Factura', 'C'], 12: ['Nota de Débito', 'C'], 13: ['Nota de Crédito', 'C'],
  51: ['Factura', 'M'], 52: ['Nota de Débito', 'M'], 53: ['Nota de Crédito', 'M'],
  201: ['Factura de Crédito MiPyME', 'A'], 202: ['Nota de Débito MiPyME', 'A'], 203: ['Nota de Crédito MiPyME', 'A'],
  206: ['Factura de Crédito MiPyME', 'B'], 207: ['Nota de Débito MiPyME', 'B'], 208: ['Nota de Crédito MiPyME', 'B'],
  211: ['Factura de Crédito MiPyME', 'C'], 212: ['Nota de Débito MiPyME', 'C'], 213: ['Nota de Crédito MiPyME', 'C'],
}
const classOf = (base) => (base.includes('Crédito') ? 'credit_note' : base.includes('Débito') ? 'debit_note' : 'invoice')

// 11 dígitos → XX-XXXXXXXX-X
const fmtCuit = (n) => { const s = String(n).replace(/\D/g, '').padStart(11, '0'); return `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` }
// Receptor según tipo de documento AFIP (80=CUIT, 86=CUIL, 96=DNI, 99=cons. final)
const fmtReceptor = (tipoDoc, nro) => {
  if (!nro || tipoDoc === 99) return ''
  return (tipoDoc === 80 || tipoDoc === 86) ? fmtCuit(nro) : String(nro)
}
// N° de comprobante estándar: PtoVenta(4) - Número(8) → 0090-00434782
const invNum = (pv, nro) => `${String(pv).padStart(4, '0')}-${String(nro).padStart(8, '0')}`

// Validación del dígito verificador del CUIT (módulo 11). Para chequear datos del LLM.
export function cuitValido(cuit) {
  const s = String(cuit).replace(/\D/g, '')
  if (s.length !== 11) return false
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = w.reduce((a, d, i) => a + d * Number(s[i]), 0)
  let dv = 11 - (sum % 11); if (dv === 11) dv = 0; if (dv === 10) dv = 9
  return dv === Number(s[10])
}

// Parsea el contenido del QR de AFIP (URL con ?p=<base64(JSON)>). null si no es AFIP.
function parseAfip(raw) {
  if (!raw) return null
  const m = raw.match(/[?&]p=([A-Za-z0-9+/=_-]+)/)
  if (!m) return null
  try {
    const j = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return (j && j.cuit && j.codAut) ? j : null
  } catch { return null }
}

// Pisa los campos fiscales de `data` con los del QR (exactos). Devuelve el detalle.
function applyQr(data, q) {
  const [base, letra] = TIPO[q.tipoCmp] || ['Comprobante', '']
  const name = letra ? `${base} ${letra}` : base
  data.supplier_tax_id = fmtCuit(q.cuit)
  const rec = fmtReceptor(q.tipoDocRec, q.nroDocRec); if (rec) data.customer_tax_id = rec
  if (q.fecha) data.issue_date = q.fecha
  data.currency = ({ PES: 'ARS', DOL: 'USD' })[q.moneda] || data.currency || 'ARS'
  data.total_amount = String(q.importe)
  data.invoice_number = invNum(q.ptoVta, q.nroCmp)
  data.document_type = name
  data.document_class = classOf(base)
  data.ar_cae = String(q.codAut)
  data.ar_punto_venta = String(q.ptoVta).padStart(4, '0')
  data.ar_tipo_comprobante = name
  return { cuit: data.supplier_tax_id, nro: data.invoice_number, total: data.total_amount, cae: data.ar_cae }
}

// enrich: recibe el QR ya decodificado (ctx.qr) y pisa los campos fiscales con el
// dato exacto de AFIP. Best-effort (no lanza). ctx = { fileBase64, mediaType, qr }.
export async function enrich(data, ctx = {}) {
  const qr = parseAfip(ctx.qr)
  if (!qr) return { source: 'llm' } // sin QR AFIP legible → queda lo del LLM
  const fixed = applyQr(data, qr)
  console.log('[AR] QR AFIP aplicado:', JSON.stringify(fixed))
  return { source: 'qr' }
}

// Prompt específico de Argentina (se inyecta solo si el tablero eligió AR).
// El QR ya resuelve el header fiscal; acá guiamos lo SEMÁNTICO donde el LLM falla.
export const prompt =
`ARGENTINA (AFIP) — guía específica:
- Separá SIEMPRE emisor y receptor: "Razón Social" del que EMITE vs del cliente. No mezcles domicilios ni CUITs.
- Hay DOS condiciones frente al IVA: la del EMISOR (supplier / ar_condicion_iva) y la del RECEPTOR (customer / ar_condicion_iva_receptor) — ej. "Responsable Inscripto", "Monotributo", "Consumidor Final", "Exento". No las confundas.
- subtotal = "Neto Gravado" / importe antes de IVA. tax_amount = total de IVA (sumá si hay 21% + 10,5%).
- ar_otros_tributos = "Importe Otros Tributos" (percepciones IIBB/IVA/ganancias, impuestos internos), en línea SEPARADA del IVA. "" si no hay.
- ar_cae_vto = "Vto. de CAE" / "Vencimiento del CAE" (YYYY-MM-DD).
- Importes: en AR el punto es separador de MILES y la coma es DECIMAL ("744.098,80" -> 744098.80).`

export default { code: 'AR', name: 'Argentina', prompt, enrich, cuitValido }
