// score-fixtures.mjs — Corre el extractor sobre los fixtures de fixtures/ar/ y
// compara contra su <id>.truth.json, sacando % de acierto por campo y total.
// ⚠️ GASTA API (una llamada por fixture). Uso:  node scripts/score-fixtures.mjs [--model=...]
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { extractInvoice } from '../extractor.mjs'
import 'dotenv/config'

const DIR = 'fixtures/ar'
const model = (process.argv.find((a) => a.startsWith('--model=')) || '').split('=')[1] || 'claude-haiku-4-5'
const PRICE = { 'claude-haiku-4-5': { in: 1, out: 5 } }[model] || { in: 1, out: 5 }

// ── Normalización + comparadores por tipo de campo ────────────────────────────
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
const numOf = (v) => { const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null }
// Clase de condición IVA (para comparar "Responsable Inscripto" ≈ "Resp. Inscripto").
const condClass = (s) => { const n = norm(s); if (n.includes('monotrib')) return 'mono'; if (n.includes('consumidorfinal') || n.includes('cf')) return 'cf'; if (n.includes('exent')) return 'ex'; if (n.includes('inscript') || n.includes('ri')) return 'ri'; if (n.includes('exterior')) return 'ext'; return n }

const NUMERIC = new Set(['subtotal', 'tax_amount', 'total_amount', 'ar_neto_no_gravado', 'ar_exento', 'ar_iva_21', 'ar_iva_105', 'ar_iva_27', 'ar_percepcion_iva', 'ar_percepcion_iibb', 'ar_percepcion_ganancias', 'ar_impuestos_internos', 'ar_otros_tributos', 'ar_cotizacion'])
const CONTAINS = new Set(['supplier_name', 'customer_name', 'supplier_address', 'customer_address'])
const CONDICION = new Set(['ar_condicion_iva', 'ar_condicion_iva_receptor'])

function cmp(id, truth, ext) {
  const tEmpty = truth === '' || truth == null, eEmpty = norm(ext) === ''
  if (tEmpty) return eEmpty ? 'ok' : 'extra' // la verdad es vacío
  if (eEmpty) return 'miss'                    // faltó extraer
  if (NUMERIC.has(id)) { const a = numOf(truth), b = numOf(ext); if (a == null || b == null) return 'bad'; return Math.abs(a - b) <= Math.max(0.5, Math.abs(a) * 0.01) ? 'ok' : 'bad' }
  if (CONDICION.has(id)) return condClass(truth) === condClass(ext) ? 'ok' : 'bad'
  if (CONTAINS.has(id)) { const t = norm(truth), e = norm(ext); return (e.includes(t) || t.includes(e)) ? 'ok' : 'bad' }
  return norm(truth) === norm(ext) ? 'ok' : 'bad'
}

// ── Main ──────────────────────────────────────────────────────────────────────
const ids = readdirSync(DIR).filter((f) => f.endsWith('.truth.json')).map((f) => f.replace('.truth.json', '')).sort()
let totIn = 0, totOut = 0
const perField = {} // id → { ok, tot }
const rows = []

for (const id of ids) {
  const truth = JSON.parse(readFileSync(join(DIR, `${id}.truth.json`), 'utf8'))
  const b64 = readFileSync(join(DIR, `${id}.pdf`)).toString('base64')
  let data, usage
  try { ({ data, usage } = await extractInvoice(b64, 'application/pdf', model, { countries: ['AR'], lineItems: true })) }
  catch (e) { console.log(`✗ ${id}: ERROR ${e.message}`); continue }
  totIn += usage.input_tokens; totOut += usage.output_tokens

  const fails = []
  let ok = 0, tot = 0
  for (const [id2, tv] of Object.entries(truth)) {
    if (id2 === 'line_items') continue
    const r = cmp(id2, tv, data[id2])
    tot++; perField[id2] ??= { ok: 0, tot: 0 }; perField[id2].tot++
    if (r === 'ok') { ok++; perField[id2].ok++ } else fails.push(`${id2}[${r}]: esperado "${tv}" ≠ "${data[id2] ?? ''}"`)
  }
  // Renglones: comparar cantidad
  const liT = truth.line_items?.length || 0, liE = data.line_items?.length || 0
  const liOk = liT === liE
  rows.push({ id, ok, tot, pct: Math.round((ok / tot) * 100), fails, li: `${liE}/${liT}${liOk ? '' : ' ⚠'}` })
}

console.log('\n' + '='.repeat(72))
for (const r of rows) {
  console.log(`${r.pct === 100 ? '✓' : '✗'} ${r.id.padEnd(22)} ${r.ok}/${r.tot} campos (${r.pct}%)  renglones ${r.li}`)
  for (const f of r.fails) console.log(`      · ${f}`)
}
console.log('='.repeat(72))
const totOk = rows.reduce((a, r) => a + r.ok, 0), totTot = rows.reduce((a, r) => a + r.tot, 0)
console.log(`ACIERTO GLOBAL: ${totOk}/${totTot} = ${(100 * totOk / totTot).toFixed(1)}%`)
console.log('\nPeores campos:')
Object.entries(perField).map(([k, v]) => [k, v.ok / v.tot, v]).filter(([, p]) => p < 1).sort((a, b) => a[1] - b[1])
  .forEach(([k, p, v]) => console.log(`  ${(100 * p).toFixed(0)}%  ${k} (${v.ok}/${v.tot})`))
const cost = (totIn / 1e6) * PRICE.in + (totOut / 1e6) * PRICE.out
console.log(`\ntokens ${totIn} in / ${totOut} out · costo estimado $${cost.toFixed(4)} USD`)
