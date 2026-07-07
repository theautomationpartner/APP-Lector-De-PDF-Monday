// Reporte INTERNO de consumo y costo (para nosotros, NO se le muestra al usuario).
// Uso (en el droplet):  cd /opt/lector-pdf-ia/backend && node scripts/usage-report.mjs
import { query } from '../db.mjs'

// Precios por 1M de tokens (USD). Actualizar si se cambia de modelo.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5':  { in: 3, out: 15 },
  'claude-opus-4-8':  { in: 5, out: 25 },
}
const costOf = (model, it, ot) => {
  const p = PRICES[model] || { in: 0, out: 0 }
  return Number(it) * p.in / 1e6 + Number(ot) * p.out / 1e6
}
const usd = (n) => '$' + n.toFixed(4)

const estados = await query(
  `select status, count(*)::int n from extractions group by status order by n desc`)
const porModelo = await query(
  `select coalesce(model,'?') model, count(*)::int n,
          coalesce(sum(input_tokens),0)::bigint it, coalesce(sum(output_tokens),0)::bigint ot
     from extractions where status='ok' group by model order by n desc`)
const porCuenta = await query(
  `select account_id,
          count(*) filter (where status='ok')::int leidas,
          coalesce(sum(input_tokens),0)::bigint it, coalesce(sum(output_tokens),0)::bigint ot
     from extractions group by account_id order by leidas desc`)

console.log('\n══════ POR ESTADO ══════')
for (const r of estados.rows) console.log(`  ${r.status.padEnd(10)} ${r.n}`)

console.log('\n══════ CONSUMO POR MODELO ══════')
let costTotal = 0
for (const r of porModelo.rows) {
  const c = costOf(r.model, r.it, r.ot)
  costTotal += c
  console.log(`  ${r.model}: ${r.n} lecturas · ${r.it} in / ${r.ot} out · ${usd(c)}`)
}
console.log(`\n  ⇒ COSTO TOTAL ESTIMADO: ${usd(costTotal)}`)

console.log('\n══════ POR CUENTA ══════')
for (const r of porCuenta.rows) {
  // Costo por cuenta con precio Haiku (modelo actual); aproximado si hubo varios.
  console.log(`  cuenta ${r.account_id}: ${r.leidas} leídas · ~${usd(costOf('claude-haiku-4-5', r.it, r.ot))}`)
}
console.log('')
process.exit(0)
