// Pone al día los tableros INTERNOS de ops contra la DB (la fuente de verdad).
// Idempotente: se puede correr las veces que haga falta. No llama a la IA.
// Uso (en el droplet):  cd /opt/lector-pdf-ia/backend && node scripts/sync-ops-board.mjs [--dry]
//
// Qué hace:
//  1. Board 1: refresca cada cliente (nombre, plan, país, contadores). Sirve también
//     al cambiar de mes: "Facturas mes" solo se recalcula cuando el cliente lee.
//  2. Board 2: sube las lecturas que la DB tiene y el tablero no (las "ignoradas"
//     no se registraban hasta el 11/09/2026), con su fecha real.
//  3. Board 2: re-engancha lecturas cuyo ítem SÍ se creó pero la DB no guardó el id
//     (pasó cuando el proceso se cayó justo entre las dos cosas).
//  4. Board 2: completa "Campos" en las lecturas viejas (la DB lo tiene desde
//     siempre; tipo, avisos, duración y archivo recién desde el 11/09/2026).
//
// Corre también todos los días por cron (06:00 AR) para que la etapa del cliente
// ("Inactiva") y "Facturas mes" no queden viejos en un cliente que no lee.
import { query } from '../db.mjs'
import { config } from '../config.mjs'
import { refreshClientRow, C2 } from '../internal-board.mjs'

const DRY = process.argv.includes('--dry')
const TOKEN = config.mondayInternalToken
if (!TOKEN) { console.error('Falta MONDAY_INTERNAL_TOKEN'); process.exit(1) }
const B2 = '18421733614'
const PRICES = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-5': [2, 10], 'claude-opus-4-8': [5, 25] }
const ESTADO = { ok: 'OK', error: 'Error', duplicate: 'Duplicada', ignored: 'Ignorada' }
const dstr = (d) => new Date(d).toISOString().slice(0, 10)

async function gql(q, variables = {}) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': '2025-04' },
    body: JSON.stringify({ query: q, variables }),
  })
  const j = await r.json()
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300))
  return j.data
}

// ── 1. Board 1 ──
const inst = (await query('select account_id, board_item_id from installations where board_item_id is not null')).rows
for (const i of inst) {
  if (DRY) { console.log(`[B1] refrescaría ${i.account_id} → ítem ${i.board_item_id}`); continue }
  await refreshClientRow(i.account_id, i.board_item_id)
  console.log(`[B1] ${i.account_id} refrescado`)
}
const clienteDe = Object.fromEntries(inst.map((i) => [i.account_id, i.board_item_id]))

// Ítems de Board 2 que ya existen (para no duplicar y para re-enganchar).
const items = []
let cursor = null
do {
  const d = await gql(
    `query($b:[ID!],$c:String){ boards(ids:$b){ items_page(limit:500, cursor:$c){ cursor items { id column_values(ids:["${C2.acct}","${C2.fecha}","${C2.tin}","${C2.tout}","${C2.campos}"]) { id text } } } } }`,
    { b: [B2], c: cursor },
  )
  const p = d.boards[0].items_page
  items.push(...p.items)
  cursor = p.cursor
} while (cursor)
const conItem = (await query('select board_item_id, fields_written from extractions where board_item_id is not null')).rows
const mapeados = new Set(conItem.map((r) => r.board_item_id))

// ── 4. "Campos" de las lecturas que ya están en el tablero y no lo tienen.
const camposEnBoard = Object.fromEntries(items.map((it) => [it.id, it.column_values.find((c) => c.id === C2.campos)?.text || '']))
const sinCampos = conItem.filter((r) => r.fields_written != null && camposEnBoard[r.board_item_id] === '')
console.log(`[B2] lecturas sin "Campos" en el tablero: ${sinCampos.length}`)
for (const r of sinCampos) {
  if (DRY) continue
  await gql(
    `mutation($b:ID!,$i:ID!,$cv:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$cv){ id } }`,
    { b: B2, i: String(r.board_item_id), cv: JSON.stringify({ [C2.campos]: String(r.fields_written) }) },
  )
}
const sueltos = items.filter((it) => !mapeados.has(it.id)).map((it) => ({
  id: it.id, ...Object.fromEntries(it.column_values.map((c) => [c.id, c.text])),
}))

const faltan = (await query(
  `select id, account_id, status, model, input_tokens, output_tokens, detected_country, error, fields_written, created_at
     from extractions where board_item_id is null order by created_at`,
)).rows

for (const e of faltan) {
  // ── 3. ¿Ya tiene ítem y solo le falta el enganche? Mismo cliente, día y tokens.
  const par = e.input_tokens != null && sueltos.find((s) =>
    s[C2.acct] === e.account_id && s[C2.fecha] === dstr(e.created_at)
    && s[C2.tin] === String(e.input_tokens) && s[C2.tout] === String(e.output_tokens))
  if (par) {
    sueltos.splice(sueltos.indexOf(par), 1)
    console.log(`[B2] extracción ${e.id} ↔ ítem existente ${par.id}`)
    if (!DRY) await query('update extractions set board_item_id = $1 where id = $2', [par.id, e.id])
    continue
  }

  // ── 2. No está: se sube con su fecha real.
  const [pin, pout] = PRICES[e.model] || PRICES['claude-haiku-4-5']
  const cv = {
    [C2.fecha]: { date: dstr(e.created_at) },
    [C2.acct]: e.account_id,
    [C2.pais]: e.detected_country || '',
    [C2.estado]: { label: ESTADO[e.status] || e.status },
    [C2.modelo]: e.model || '',
  }
  if (e.input_tokens != null) {
    cv[C2.tin] = String(e.input_tokens)
    cv[C2.tout] = String(e.output_tokens || 0)
    cv[C2.costo] = (e.input_tokens / 1e6 * pin + (e.output_tokens || 0) / 1e6 * pout).toFixed(5)
  }
  if (e.fields_written != null) cv[C2.campos] = String(e.fields_written)
  const obs = e.status === 'ignored' ? 'Ignorada por el filtro del tablero (cargada después por sync-ops-board)' : e.error
  if (obs) cv[C2.obs] = { text: String(obs).slice(0, 500) }
  if (clienteDe[e.account_id]) cv[C2.cliente] = { item_ids: [Number(clienteDe[e.account_id])] }
  console.log(`[B2] extracción ${e.id} (${e.status}, ${dstr(e.created_at)}) → ítem nuevo`)
  if (DRY) continue
  const d = await gql(
    `mutation($b:ID!,$n:String!,$cv:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$cv,create_labels_if_missing:true){ id } }`,
    { b: B2, n: `${e.detected_country || '—'} · ${dstr(e.created_at)}`, cv: JSON.stringify(cv) },
  )
  await query('update extractions set board_item_id = $1 where id = $2', [d.create_item.id, e.id])
}

// Los ítems de Board 2 sin extracción son las pruebas internas y lecturas de julio
// anteriores a la tabla actual: se dejan, son histórico.
console.log(`\nListo${DRY ? ' (simulación, no se escribió nada)' : ''}. Ítems de Board 2 sin extracción en la DB (histórico, se dejan): ${sueltos.length}`)
process.exit(0)
