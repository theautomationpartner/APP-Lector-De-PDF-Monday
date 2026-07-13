// internal-board.mjs — Sincroniza los tableros INTERNOS de ops en NUESTRO monday
// (cuenta The Automation Partner): Board 1 "Instalaciones APP Lectura" (una fila
// por cliente) y Board 2 "Facturas leídas" (una fila por lectura — METADATA, sin
// contenido de facturas, para no contradecir la privacy policy).
//
// Todo acá es BEST-EFFORT: se invoca fire-and-forget desde server.mjs y cada
// función traga sus errores (warn al log). Si nuestro monday falla, la lectura
// del cliente NO se ve afectada. Sin MONDAY_INTERNAL_TOKEN queda apagado (dev).
import { config } from './config.mjs'
import { query } from './db.mjs'
import { planLabel } from './plans.mjs'

const TOKEN = config.mondayInternalToken
const MONDAY = 'https://api.monday.com/v2'

// IDs de tableros/columnas de ops (creados 2026-07-13 en la cuenta 28569993).
// La columna "Cliente" (board_relation) se creó a mano — la API no permite crearla.
const B1 = '18421712940' // Instalaciones APP Lectura
const B2 = '18421733614' // Facturas leídas (App Lectura)
const C1 = {
  account: 'text_mm57bww4', plan: 'color_mm57g0h', estado: 'color_mm573k1p',
  install: 'date_mm57ztk8', month: 'numeric_mm57sje4', total: 'numeric_mm57dn3z',
  last: 'date_mm57etvt', country: 'text_mm57djmj',
}
const C2 = {
  fecha: 'date_mm57jzrr', acct: 'text_mm571x72', pais: 'text_mm57aavt',
  estado: 'color_mm57s7bs', modelo: 'text_mm57kjp', tin: 'numeric_mm57j31m',
  tout: 'numeric_mm57jdhq', cliente: 'board_relation_mm57zmw5',
  costo: 'numeric_mm57xm69', obs: 'long_text_mm571nk8',
}

// $/1M tokens (in/out) — mismo catálogo que scripts/usage-report.mjs.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5':  { in: 3, out: 15 },
  'claude-opus-4-8':  { in: 5, out: 25 },
}
const ESTADO = { ok: 'OK', error: 'Error', duplicate: 'Duplicada' }
const dstr = (d) => new Date(d || Date.now()).toISOString().slice(0, 10)

async function gqlOps(q, variables = {}) {
  const r = await fetch(MONDAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': '2025-04' },
    body: JSON.stringify({ query: q, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  const j = await r.json()
  if (j.errors) throw new Error('opsboard: ' + JSON.stringify(j.errors).slice(0, 300))
  return j.data
}

// Fila del cliente en Board 1 (la crea si no existe) → item_id. El mapeo vive en
// installations.board_item_id; el upsert crea la fila de installations si el
// evento de install llega antes de la primera config (queda con defaults).
async function ensureClientItem(accountId) {
  const { rows } = await query(
    'select board_item_id, plan, default_country, created_at from installations where account_id = $1',
    [String(accountId)],
  )
  const inst = rows[0]
  if (inst?.board_item_id) return inst.board_item_id
  const cv = {
    [C1.account]: String(accountId),
    [C1.plan]: { label: planLabel(inst?.plan || config.defaultPlan) },
    [C1.estado]: { label: 'Activa' },
    [C1.install]: { date: dstr(inst?.created_at) },
    [C1.country]: inst?.default_country || '',
  }
  const d = await gqlOps(
    `mutation($b:ID!,$n:String!,$cv:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$cv,create_labels_if_missing:true){ id } }`,
    { b: B1, n: `Cuenta ${accountId}`, cv: JSON.stringify(cv) },
  )
  const itemId = d.create_item.id
  await query(
    `insert into installations (account_id, board_item_id, updated_at) values ($1, $2, now())
     on conflict (account_id) do update set board_item_id = $2, updated_at = now()`,
    [String(accountId), itemId],
  )
  return itemId
}

// Refresca los contadores del cliente en Board 1 (facturas mes/total + última).
async function refreshClientCounters(accountId, clientItem) {
  const { rows } = await query(
    `select count(*) filter (where status = 'ok') as total,
            count(*) filter (where status = 'ok' and created_at >= date_trunc('month', now())) as month,
            max(created_at) filter (where status = 'ok') as last
       from extractions where account_id = $1`,
    [String(accountId)],
  )
  const r = rows[0] || {}
  const cv = { [C1.month]: String(r.month || 0), [C1.total]: String(r.total || 0) }
  if (r.last) cv[C1.last] = { date: dstr(r.last) }
  await gqlOps(
    `mutation($b:ID!,$i:ID!,$cv:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$cv){ id } }`,
    { b: B1, i: String(clientItem), cv: JSON.stringify(cv) },
  )
}

// Registra UNA lectura en Board 2 (nombre "PAÍS · fecha", costo calculado, motivo
// si falló, link al cliente) + refresca los contadores de Board 1.
export async function syncReading({ extractionId, accountId, detectedCountry, model, inputTokens, outputTokens, status, error }) {
  if (!TOKEN || !accountId) return
  try {
    const clientItem = await ensureClientItem(accountId).catch(() => null)
    const p = PRICES[model] || PRICES['claude-haiku-4-5']
    const cost = ((inputTokens || 0) / 1e6) * p.in + ((outputTokens || 0) / 1e6) * p.out
    const cv = {
      [C2.fecha]: { date: dstr() },
      [C2.acct]: String(accountId),
      [C2.pais]: detectedCountry || '',
      [C2.estado]: { label: ESTADO[status] || status },
      [C2.modelo]: model || '',
    }
    if (inputTokens != null) cv[C2.tin] = String(inputTokens)
    if (outputTokens != null) cv[C2.tout] = String(outputTokens)
    if (inputTokens != null || outputTokens != null) cv[C2.costo] = cost.toFixed(5)
    if (error) cv[C2.obs] = { text: String(error).slice(0, 500) }
    if (clientItem) cv[C2.cliente] = { item_ids: [Number(clientItem)] }
    const d = await gqlOps(
      `mutation($b:ID!,$n:String!,$cv:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$cv,create_labels_if_missing:true){ id } }`,
      { b: B2, n: `${detectedCountry || '—'} · ${dstr()}`, cv: JSON.stringify(cv) },
    )
    if (extractionId) {
      await query('update extractions set board_item_id = $1 where id = $2', [d.create_item.id, extractionId])
    }
    if (clientItem) await refreshClientCounters(accountId, clientItem)
  } catch (e) {
    console.warn('[opsboard] no se pudo registrar la lectura:', e.message)
  }
}

// Eventos de lifecycle → Board 1. estado: 'Activa' | 'Desinstalada'; plan opcional.
// En uninstall LLAMAR ANTES de deleteAccountData (que borra el mapeo de la DB).
export async function syncInstallation(accountId, { estado, plan } = {}) {
  if (!TOKEN || !accountId) return
  try {
    const itemId = await ensureClientItem(accountId)
    const cv = {}
    if (estado) cv[C1.estado] = { label: estado }
    if (plan) cv[C1.plan] = { label: planLabel(plan) }
    if (!Object.keys(cv).length) return
    await gqlOps(
      `mutation($b:ID!,$i:ID!,$cv:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$cv,create_labels_if_missing:true){ id } }`,
      { b: B1, i: String(itemId), cv: JSON.stringify(cv) },
    )
  } catch (e) {
    console.warn('[opsboard] no se pudo sincronizar la instalación:', e.message)
  }
}
