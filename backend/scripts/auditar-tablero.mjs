// Auditoría de un tablero YA leído. NO gasta un centavo de IA: baja cada PDF y
// compara lo que quedó escrito en las columnas contra dos fuentes exactas:
//   1) el QR de AFIP  → verdad oficial (CUIT, número, fecha, total, CAE)
//   2) la capa de texto del PDF → todo lo que está impreso
// Sirve para encontrar de una los ítems mal cargados sin volver a leerlos.
//
// Uso:  MONDAY_AUDIT_TOKEN=<token de esa cuenta> node scripts/auditar-tablero.mjs --board 9977987607 [--limit 200]
import { query } from '../db.mjs'
import { gql } from '../monday.mjs'
import { pdfText } from '../pdfcodes.mjs'
import { decodeInvoiceQr } from '../qr.mjs'
import { cuitValido } from '../countries/ar.mjs'

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d }
const BOARD = Number(arg('board'))
const LIMIT = Number(arg('limit', '500'))
const TOKEN = process.env.MONDAY_AUDIT_TOKEN
if (!BOARD || !TOKEN) { console.error('Falta --board o MONDAY_AUDIT_TOKEN'); process.exit(1) }

const digits = (s) => String(s || '').replace(/\D/g, '')
// Sin acentos y en minúscula, para comparar razones sociales ("Cámara" vs "CAMARA").
const plano = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const TIPO = {
  1: 'Factura A', 6: 'Factura B', 11: 'Factura C', 51: 'Factura M', 19: 'Factura E',
  2: 'Nota de Débito A', 7: 'Nota de Débito B', 12: 'Nota de Débito C', 52: 'Nota de Débito M', 20: 'Nota de Débito E',
  3: 'Nota de Crédito A', 8: 'Nota de Crédito B', 13: 'Nota de Crédito C', 53: 'Nota de Crédito M', 21: 'Nota de Crédito E',
}

// Contenido del QR de AFIP: una URL con ?p=<base64(JSON)>.
function parseAfip(raw) {
  const m = String(raw || '').match(/[?&]p=([A-Za-z0-9+/=_-]+)/)
  if (!m) return null
  try {
    const j = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return (j && j.cuit && j.codAut) ? j : null
  } catch { return null }
}

// pdf.js escupe cientos de "Warning: ignoring invalid character" por PDF y tapan
// el informe. Los callamos solo mientras parsea.
async function callar(fn) {
  const l = console.log, w = console.warn, e = console.error
  console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { console.log = l; console.warn = w; console.error = e }
}

// ¿La fecha ISO figura impresa como DD/MM/AAAA? ¿Y la versión dada vuelta?
const impresa = (iso, t) => {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [, y, mo, d] = m
  const re = (a, b) => new RegExp(`\\b0?${+a}[/.-]0?${+b}[/.-](?:${y}|${y.slice(2)})\\b`)
  const donde = [t, t.replace(/\s+/g, '')]
  return { ok: donde.some((x) => re(d, mo).test(x)), invertida: donde.some((x) => re(mo, d).test(x)) }
}

// Las partes que, sumadas, tienen que dar el total (fórmula oficial de ARCA).
const PARTES = ['subtotal', 'ar_neto_no_gravado', 'ar_exento', 'tax_amount', 'ar_percepcion_iva',
  'ar_percepcion_iibb', 'ar_percepcion_ganancias', 'ar_impuestos_internos', 'ar_otros_tributos']

const cfg = (await query('SELECT account_id, mapping FROM board_configs WHERE board_id=$1', [BOARD])).rows[0]
if (!cfg) { console.error('Ese tablero no está configurado'); process.exit(1) }
const mapping = cfg.mapping || {}
const porColumna = Object.fromEntries(Object.entries(mapping).map(([f, c]) => [c, f]))

// Todos los ítems con sus valores y el archivo adjunto.
const items = []
let cursor = null
do {
  const q = `query($b:[ID!],$c:String){ boards(ids:$b){ items_page(limit:100, cursor:$c){ cursor items {
    id name column_values { id text } assets { id public_url name created_at } } } } }`
  const r = await gql(TOKEN, q, { b: [String(BOARD)], c: cursor })
  const page = r?.boards?.[0]?.items_page
  items.push(...(page?.items || []))
  cursor = page?.cursor
} while (cursor && items.length < LIMIT)

console.log(`\nTablero ${BOARD} — ${items.length} ítems\n`)
const problemas = []
let sinArchivo = 0, sinTexto = 0, conQr = 0, revisados = 0, sinDesglose = false, totalesOk = 0

for (const it of items) {
  const asset = (it.assets || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  if (!asset) { sinArchivo++; continue }
  const val = Object.fromEntries((it.column_values || []).map((c) => [c.id, c.text || '']))
  const escrito = {}
  for (const [col, campo] of Object.entries(porColumna)) escrito[campo] = col === 'name' ? it.name : (val[col] || '')

  let buf
  try {
    const resp = await fetch(asset.public_url)
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    buf = Buffer.from(await resp.arrayBuffer())
  } catch (e) { problemas.push({ it, fallas: [`no se pudo bajar el archivo (${e.message})`] }); continue }
  revisados++

  const esPdf = /\.pdf$/i.test(asset.name || '')
  const b64 = buf.toString('base64')
  const texto = esPdf ? await callar(() => pdfText(b64)) : null
  const qr = parseAfip(await callar(() => decodeInvoiceQr(b64, esPdf ? 'application/pdf' : 'image/jpeg').catch(() => null)))
  if (qr) conQr++
  if (!texto && !qr) { sinTexto++; continue }

  const fallas = []
  const cmp = (campo, esperado, tag) => {
    const w = String(escrito[campo] ?? '').trim()
    if (!mapping[campo] || !w || esperado == null) return
    if (digits(w) !== digits(esperado)) fallas.push(`${campo}: dice "${w}" · ${tag} dice "${esperado}"`)
  }

  // ── IMPORTES ──────────────────────────────────────────────────────────────
  // El QR trae el importe TOTAL firmado por ARCA: es el único número de la factura
  // que se puede verificar contra una fuente oficial. Y con el total exacto, el
  // desglose se controla solo: según el manual de ARCA, ImpTotal = neto no gravado
  // + exento + neto gravado + IVA + tributos.
  const nOf = (v) => { const n = parseFloat(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null }
  if (qr && mapping.total_amount && escrito.total_amount) {
    const tengo = nOf(escrito.total_amount), afip = Number(qr.importe)
    if (tengo != null && Math.abs(tengo - afip) <= 0.02) totalesOk++
    if (tengo != null && Math.abs(tengo - afip) > 0.02) {
      fallas.push(`total_amount: dice ${tengo} · AFIP dice ${afip} (diferencia ${Math.round((tengo - afip) * 100) / 100})`)
    }
  }
  // El desglose solo se puede controlar si el tablero mapea TODAS las partes. Si le
  // falta una (ej. "impuestos internos", que toda factura de combustible lleva), la
  // suma no cierra nunca y el aviso no distingue "la app leyó mal" de "esa columna
  // no existe". Un control que no sabe de qué se queja es peor que no tenerlo.
  const faltan = PARTES.filter((f) => !mapping[f])
  if (mapping.total_amount && escrito.total_amount && !faltan.length) {
    const suma = PARTES.reduce((a, f) => a + (nOf(escrito[f]) || 0), 0)
    const total = nOf(escrito.total_amount)
    const dif = Math.round((suma - total) * 100) / 100
    if (total && Math.abs(dif) > Math.max(1, total * 0.005)) {
      fallas.push(`el desglose no cierra: las partes suman ${Math.round(suma * 100) / 100} y el total dice ${total} (diferencia ${dif})`)
    }
  } else if (mapping.total_amount && faltan.length) {
    sinDesglose = true
  }

  if (qr) {
    cmp('supplier_tax_id', String(qr.cuit), 'AFIP')
    cmp('ar_cae', String(qr.codAut), 'AFIP')
    cmp('invoice_number', `${String(qr.ptoVta).padStart(4, '0')}-${String(qr.nroCmp).padStart(8, '0')}`, 'AFIP')
    if (qr.nroDocRec) cmp('customer_tax_id', String(qr.nroDocRec), 'AFIP')
    // El QR trae la fecha a veces como 2026-07-30 y a veces como 20260730.
    if (mapping.issue_date && escrito.issue_date && qr.fecha && digits(escrito.issue_date) !== digits(qr.fecha)) {
      const f = digits(qr.fecha)
      fallas.push(`issue_date: dice "${escrito.issue_date}" · AFIP dice "${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}"`)
    }
    // El tipo suele ir en el nombre del ítem, pero muchos tableros lo renombran con
    // su propio formato ("Proveedor - IDFACTCP-167 - 0007-..."). Solo comparamos si
    // el valor efectivamente parece un tipo de comprobante; si no, no es nuestro dato.
    const tipo = TIPO[qr.tipoCmp]
    const esUnTipo = /factura|nota de (credito|debito)|comprobante/.test(plano(escrito.document_type))
    if (tipo && escrito.document_type && esUnTipo && !plano(escrito.document_type).includes(plano(tipo))) {
      fallas.push(`tipo de comprobante: "${escrito.document_type}" · AFIP dice "${tipo}"`)
    }
  }

  // El dígito verificador no depende del PDF: siempre se puede chequear.
  for (const f of ['supplier_tax_id', 'customer_tax_id']) {
    if (!mapping[f] || !escrito[f]) continue
    if (digits(escrito[f]).length === 11 && !cuitValido(escrito[f])) {
      fallas.push(`${f}: "${escrito[f]}" no es un CUIT válido (dígito verificador)`)
    }
  }

  // Chequeos contra el texto impreso. OJO: un PDF escaneado tiene capa de texto
  // vacía o basura, y ahí TODO "falta" — serían 6 falsos positivos por ítem. Por
  // eso los junto aparte: si falla el 100% de lo verificable, el problema es la
  // capa de texto, no el dato. Solo reporto cuando falla una parte.
  const dudas = []
  let chequeados = 0
  if (texto) {
    const digitosPdf = digits(texto)
    const textoPlano = plano(texto)
    const yaVerificado = new Set(qr ? ['ar_cae', 'invoice_number', 'supplier_tax_id'] : [])
    for (const f of ['ar_cae', 'invoice_number', 'supplier_tax_id', 'customer_tax_id']) {
      if (!mapping[f] || !escrito[f] || yaVerificado.has(f)) continue
      const d = digits(escrito[f])
      if (d.length < 8) continue
      chequeados++
      if (!digitosPdf.includes(d)) dudas.push(`${f}: "${escrito[f]}" no aparece en el PDF`)
    }
    for (const f of ['issue_date', 'ar_cae_vto']) {
      if (!mapping[f] || !escrito[f]) continue
      const r = impresa(escrito[f], texto)
      if (!r) continue
      chequeados++
      if (!r.ok && r.invertida) dudas.push(`${f}: "${escrito[f]}" está DADA VUELTA (el PDF imprime día y mes al revés)`)
      else if (!r.ok) dudas.push(`${f}: "${escrito[f]}" no figura impresa en el PDF`)
    }
    if (mapping.supplier_name && escrito.supplier_name) {
      const primera = plano(escrito.supplier_name).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 3)[0]
      if (primera) {
        chequeados++
        if (!textoPlano.includes(primera)) dudas.push(`supplier_name: "${escrito.supplier_name}" no aparece en el PDF`)
      }
    }
  }
  // Falló todo lo verificable → PDF escaneado / sin capa de texto usable. Se descarta.
  if (chequeados >= 2 && dudas.length === chequeados) sinTexto++
  else fallas.push(...dudas)

  // Se imprime en el momento: si el proceso se corta, lo encontrado ya está a salvo.
  if (fallas.length) {
    problemas.push({ it, fallas })
    console.log(`• ${it.name}  (id ${it.id})`)
    for (const f of fallas) console.log(`    - ${f}`)
  }
  if (revisados % 25 === 0) console.log(`   ... ${revisados}/${items.length} revisados · ${problemas.length} con diferencias`)
}

console.log(`\nRevisados ${revisados} · con QR de AFIP ${conQr} · sin archivo ${sinArchivo} · sin texto útil ${sinTexto}`)
if (!mapping.total_amount) {
  console.log('⚠️ Este tablero NO carga el importe total: no hay ningún importe que verificar contra AFIP.')
} else {
  console.log(`Totales verificados contra el QR de AFIP: ${totalesOk} coinciden al centavo`)
  if (sinDesglose) {
    console.log(`⚠️ El desglose no se pudo controlar: al tablero le faltan columnas de importe (${PARTES.filter((f) => !mapping[f]).join(', ')})`)
  }
}
console.log(problemas.length ? `${problemas.length} ítem(s) con diferencias (listados arriba).` : 'Sin diferencias.')
process.exit(0)
