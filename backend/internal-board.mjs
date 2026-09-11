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
  // Agregadas 2026-09-11.
  etapa: 'color_mm73eay3', contacto: 'email_mm738ttp', instalo: 'text_mm73x2j',
  tier: 'text_mm735210', usuarios: 'numeric_mm73z916', costoMes: 'numeric_mm73sq2z',
  costoTotal: 'numeric_mm736s6b', erroresMes: 'numeric_mm7368xe', ultimoError: 'text_mm73g4fr',
}
export const C2 = {
  fecha: 'date_mm57jzrr', acct: 'text_mm571x72', pais: 'text_mm57aavt',
  estado: 'color_mm57s7bs', modelo: 'text_mm57kjp', tin: 'numeric_mm57j31m',
  tout: 'numeric_mm57jdhq', cliente: 'board_relation_mm57zmw5',
  costo: 'numeric_mm57xm69', obs: 'long_text_mm571nk8',
  // Agregadas 2026-09-11.
  tipo: 'color_mm7313d2', campos: 'numeric_mm738vrx', avisos: 'numeric_mm738xh4',
  duracion: 'numeric_mm73dwf0', formato: 'text_mm739vff', mb: 'numeric_mm73cand',
}

// $/1M tokens (in/out) — mismo catálogo que scripts/usage-report.mjs.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5':  { in: 2, out: 10 },
  'claude-opus-4-8':  { in: 5, out: 25 },
}
const costo = (model, it, ot) => {
  const p = PRICES[model] || PRICES['claude-haiku-4-5']
  return (Number(it) || 0) / 1e6 * p.in + (Number(ot) || 0) / 1e6 * p.out
}
// document_class de la IA → etiqueta. Solo el tipo: nada del contenido.
const TIPO_DOC = { invoice: 'Factura', credit_note: 'Nota de crédito', debit_note: 'Nota de débito', delivery_note: 'Remito', other: 'Otro' }
// Sin lecturas en tantos días, el cliente pasa a "Inactiva".
const DIAS_INACTIVA = 30
// 'ignored' también va: la IA ya corrió (tokens gastados) antes de que el filtro
// del tablero la descartara. Sin esta fila el costo quedaba invisible.
const ESTADO = { ok: 'OK', error: 'Error', duplicate: 'Duplicada', ignored: 'Ignorada' }
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
    'select board_item_id, plan, default_country, created_at, account_name, account_slug from installations where account_id = $1',
    [String(accountId)],
  )
  const inst = rows[0]
  if (inst?.board_item_id) return inst.board_item_id

  // Sin mapeo no quiere decir sin fila: al desinstalar se borra la cuenta de la DB
  // (y con ella el mapeo) pero la fila del tablero queda como histórico. Si el
  // cliente reinstala, se reusa esa fila en vez de crearle una segunda. Si hay
  // varias (duplicados viejos), la más nueva.
  const found = await gqlOps(
    `query($b:ID!,$c:String!,$v:String!){ items_page_by_column_values(board_id:$b, limit:10, columns:[{ column_id:$c, column_values:[$v] }]){ items { id } } }`,
    { b: B1, c: C1.account, v: String(accountId) },
  )
  const previa = (found.items_page_by_column_values?.items || []).map((i) => i.id).sort((a, b) => Number(b) - Number(a))[0]
  if (previa) {
    await query(
      `insert into installations (account_id, board_item_id, updated_at) values ($1, $2, now())
       on conflict (account_id) do update set board_item_id = $2, updated_at = now()`,
      [String(accountId), previa],
    )
    return previa
  }

  const cv = {
    [C1.account]: String(accountId),
    [C1.plan]: { label: planLabel(inst?.plan || config.defaultPlan) },
    [C1.estado]: { label: 'Activa' },
    [C1.install]: { date: dstr(inst?.created_at) },
    [C1.country]: inst?.default_country || '',
  }
  const d = await gqlOps(
    `mutation($b:ID!,$n:String!,$cv:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$cv,create_labels_if_missing:true){ id } }`,
    // Nombre real de la cuenta si ya lo capturamos; si no, el ID (refreshClientRow
    // lo renombra en la primera lectura, cuando ya se conoce).
    { b: B1, n: inst?.account_name || inst?.account_slug || `Cuenta ${accountId}`, cv: JSON.stringify(cv) },
  )
  const itemId = d.create_item.id
  await query(
    `insert into installations (account_id, board_item_id, updated_at) values ($1, $2, now())
     on conflict (account_id) do update set board_item_id = $2, updated_at = now()`,
    [String(accountId), itemId],
  )
  return itemId
}

// Refresca la fila del cliente en Board 1: contadores (facturas mes/total + última)
// y también nombre, plan y país. Esos tres antes se escribían SOLO al crear la fila,
// que casi siempre es en el install, cuando todavía no se conocen (el nombre llega
// con la primera lectura, el país con la primera config, y el plan puede cambiarse
// a mano en la DB). Resultado: filas que decían "Cuenta 30446835 · Free · sin país"
// para un cliente Pro de Argentina. Exportada para scripts/sync-ops-board.mjs.
//
// Desde el 11/09/2026 también: etapa, contacto, tamaño de la cuenta, costo en IA y
// errores. Todo sale de la DB con 3 consultas chicas; no toca la lectura (esto corre
// en segundo plano, después de responderle a monday).
export async function refreshClientRow(accountId, clientItem) {
  const acct = String(accountId)
  const { rows: [i] } = await query(
    `select account_name, account_slug, plan, default_country, installer_email, installer_name,
            monday_tier, monday_max_users,
            (select count(*) from board_configs b where b.account_id = installations.account_id)::int as tableros
       from installations where account_id = $1`,
    [acct],
  )
  if (!i) return // la cuenta ya se borró (post-uninstall): la fila queda como estaba
  // Por modelo, porque cada uno tiene su precio.
  const { rows: porModelo } = await query(
    `select model,
            count(*) filter (where status = 'ok')::int as total,
            count(*) filter (where status = 'ok' and created_at >= date_trunc('month', now()))::int as month,
            count(*) filter (where status = 'error' and created_at >= date_trunc('month', now()))::int as errores,
            max(created_at) filter (where status = 'ok') as last,
            coalesce(sum(input_tokens), 0) as it, coalesce(sum(output_tokens), 0) as ot,
            coalesce(sum(input_tokens) filter (where created_at >= date_trunc('month', now())), 0) as itm,
            coalesce(sum(output_tokens) filter (where created_at >= date_trunc('month', now())), 0) as otm
       from extractions where account_id = $1 group by model`,
    [acct],
  )
  const r = { total: 0, month: 0, errores: 0, last: null, costoTotal: 0, costoMes: 0 }
  for (const m of porModelo) {
    r.total += m.total; r.month += m.month; r.errores += m.errores
    if (m.last && (!r.last || m.last > r.last)) r.last = m.last
    r.costoTotal += costo(m.model, m.it, m.ot)
    r.costoMes += costo(m.model, m.itm, m.otm)
  }
  const { rows: [ultErr] } = await query(
    `select error, created_at from extractions where account_id = $1 and status = 'error'
      order by created_at desc limit 1`,
    [acct],
  )

  // Etapa: dónde está parado el cliente. Sale de lo que HACE, no de lo que tildó
  // (automation_confirmed es un checkbox de la vista: Polifroni no lo tiene y
  // lleva 100 lecturas).
  const dias = r.last ? (Date.now() - new Date(r.last).getTime()) / 86_400_000 : null
  const etapa = r.total > 0
    ? (dias <= DIAS_INACTIVA ? 'Leyendo' : 'Inactiva')
    : (i.tableros > 0 ? 'Configurada, sin leer' : 'Sin configurar')

  const cv = {
    [C1.month]: String(r.month),
    [C1.total]: String(r.total),
    [C1.plan]: { label: planLabel(i.plan || config.defaultPlan) },
    [C1.etapa]: { label: etapa },
    [C1.costoMes]: r.costoMes.toFixed(3),
    [C1.costoTotal]: r.costoTotal.toFixed(3),
    [C1.erroresMes]: String(r.errores),
    [C1.ultimoError]: ultErr ? `${dstr(ultErr.created_at)} · ${String(ultErr.error || '').slice(0, 180)}` : '',
  }
  if (r.last) cv[C1.last] = { date: dstr(r.last) }
  // Lo que puede no conocerse (cuentas viejas: monday lo manda solo en el install)
  // se escribe solo si está: nunca borrar algo que ya estaba escrito.
  // Sin nombre, el slug (el "acme" de acme.monday.com) identifica mejor que el ID.
  if (i.account_name || i.account_slug) cv.name = i.account_name || i.account_slug
  if (i.default_country) cv[C1.country] = i.default_country
  if (i.installer_email) cv[C1.contacto] = { email: i.installer_email, text: i.installer_email }
  if (i.installer_name) cv[C1.instalo] = i.installer_name
  if (i.monday_tier) cv[C1.tier] = i.monday_tier
  if (i.monday_max_users) cv[C1.usuarios] = String(i.monday_max_users)
  await gqlOps(
    `mutation($b:ID!,$i:ID!,$cv:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$cv,create_labels_if_missing:true){ id } }`,
    { b: B1, i: String(clientItem), cv: JSON.stringify(cv) },
  )
}

// Registra UNA lectura en Board 2 (nombre "PAÍS · fecha", costo calculado, motivo
// si falló, link al cliente) + refresca la fila del cliente en Board 1.
// meta (opcional) = { docClass, fields, warnings, ms, mediaType, bytes }: lo arma
// server.mjs con lo que ya tiene a mano; lo que falte simplemente no se escribe.
export async function syncReading({ extractionId, accountId, detectedCountry, model, inputTokens, outputTokens, status, error, meta = {} }) {
  if (!TOKEN || !accountId) return
  try {
    const clientItem = await ensureClientItem(accountId).catch(() => null)
    const cost = costo(model, inputTokens, outputTokens)
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
    const tipo = TIPO_DOC[String(meta.docClass || '').toLowerCase()]
    if (tipo) cv[C2.tipo] = { label: tipo }
    if (meta.fields != null) cv[C2.campos] = String(meta.fields)
    if (meta.warnings != null) cv[C2.avisos] = String(meta.warnings)
    // Duración = desde que monday disparó hasta ahora, cola incluida: lo que esperó
    // el cliente, no solo lo que tardó la IA.
    if (meta.ms != null) cv[C2.duracion] = (meta.ms / 1000).toFixed(1)
    if (meta.mediaType) cv[C2.formato] = String(meta.mediaType).split('/').pop().toUpperCase().replace('JPEG', 'JPG')
    if (meta.bytes) cv[C2.mb] = (meta.bytes / 1048576).toFixed(2)
    const d = await gqlOps(
      `mutation($b:ID!,$n:String!,$cv:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$cv,create_labels_if_missing:true){ id } }`,
      { b: B2, n: `${detectedCountry || '—'} · ${dstr()}`, cv: JSON.stringify(cv) },
    )
    if (extractionId) {
      await query('update extractions set board_item_id = $1 where id = $2', [d.create_item.id, extractionId])
    }
    if (clientItem) await refreshClientRow(accountId, clientItem)
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
    if (Object.keys(cv).length) {
      await gqlOps(
        `mutation($b:ID!,$i:ID!,$cv:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$cv,create_labels_if_missing:true){ id } }`,
        { b: B1, i: String(itemId), cv: JSON.stringify(cv) },
      )
    }
    // Y el resto de la fila (nombre que acaba de llegar en el webhook, plan, país).
    await refreshClientRow(accountId, itemId)
  } catch (e) {
    console.warn('[opsboard] no se pudo sincronizar la instalación:', e.message)
  }
}
