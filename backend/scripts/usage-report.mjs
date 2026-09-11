// Reporte INTERNO de consumo y costo (para nosotros, NO se le muestra al usuario).
// Uso (en el droplet):  cd /opt/lector-pdf-ia/backend && node scripts/usage-report.mjs
import { query } from '../db.mjs'

// Precios por 1M de tokens (USD). Actualizar si se cambia de modelo.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5':  { in: 2, out: 10 },
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
// Por cuenta Y modelo: desde el 11/09/2026 conviven lecturas de Haiku y de Sonnet
// (que cuesta el doble), así que cada tramo se cobra a su precio.
const porCuentaModelo = await query(
  `select account_id, coalesce(model,'?') model,
          count(*) filter (where status='ok')::int leidas,
          coalesce(sum(input_tokens),0)::bigint it, coalesce(sum(output_tokens),0)::bigint ot
     from extractions group by account_id, model`)
const cuentas = new Map()
for (const r of porCuentaModelo.rows) {
  const c = cuentas.get(r.account_id) || { account_id: r.account_id, leidas: 0, costo: 0 }
  c.leidas += r.leidas
  c.costo += costOf(r.model, r.it, r.ot)
  cuentas.set(r.account_id, c)
}
const porCuenta = [...cuentas.values()].sort((a, b) => b.leidas - a.leidas)

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
for (const r of porCuenta) {
  console.log(`  cuenta ${r.account_id}: ${r.leidas} leídas · ~${usd(r.costo)}`)
}
console.log('')
process.exit(0)
