// db.mjs — Pool de PostgreSQL + migraciones + helpers de config/histórico.
import { fieldsForCountries } from './fields.mjs'
import pg from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.mjs'
import { planLimit, planLabel } from './plans.mjs'

const { Pool } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

// SSL: con el CA cert de DO presente → verify-ca (valida la cadena contra la CA
// del cluster; se saltea el chequeo de hostname porque el CN del cert de DO no
// coincide con el host de conexión — es lo esperado/recomendado por DO). Sin el
// cert (dev/local), rejectUnauthorized:false para no frenar el desarrollo.
const caCertPath = join(__dirname, 'certs', 'do-pg-ca.crt')
// En producción con DB configurada, el cert es OBLIGATORIO: sin él NO caemos en
// silencio a "sin verificación" (MITM posible) — preferimos no arrancar.
if (!existsSync(caCertPath) && config.databaseUrl && config.appEnv === 'production') {
  throw new Error('[db] falta certs/do-pg-ca.crt en producción — no conecto sin verificar TLS')
}
const ssl = existsSync(caCertPath)
  ? { ca: readFileSync(caCertPath, 'utf8'), rejectUnauthorized: true, checkServerIdentity: () => undefined }
  : { rejectUnauthorized: false } // solo dev/local sin cert

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
})

pool.on('error', (err) => console.error('[db pool] idle client error:', err.message))

export const query = (text, params) => pool.query(text, params)

// Corre el schema.sql al arrancar. Es idempotente (CREATE TABLE IF NOT EXISTS).
export async function runStartupMigrations() {
  const sql = readFileSync(join(__dirname, 'db', 'schema.sql'), 'utf8')
  await pool.query(sql)
  // Los reclamos de subítems viven 10 minutos por diseño: los viejos son basura y
  // además guardan IDs de ítems del cliente. Se purgan en cada arranque.
  await pool.query("delete from subitem_claims where created_at < now() - interval '1 day'").catch(() => {})
  console.log('[db] migraciones OK')
}

// ── Config por (cuenta, tablero) ──
export async function getBoardConfig(accountId, boardId) {
  const { rows } = await pool.query(
    `select mapping, status_column_id, status_enabled, tax_ids_plain, automation_confirmed, file_column_id, country_override, currency_override, ui_language,
            dedup_enabled, line_items_enabled, line_items_mapping, rename_item_enabled, only_fiscal_docs, filter_mode, filter_tax_ids, countries, currencies,
            doc_kind
       from board_configs where account_id = $1 and board_id = $2`,
    [accountId, boardId],
  )
  return rows[0] || null
}

// El tipo de documento tiene que ser COHERENTE con el mapeo que llega. Si el
// mapeo trae campos que solo existen en remitos (domicilio de entrega, bultos,
// C.O.T.), el tablero es de remitos, diga lo que diga el docKind.
//
// Esto no debería hacer falta: lo manda el frontend. Pero una pestaña vieja abierta
// puede guardar con el tipo desactualizado y dejar la fila contradictoria — pasó de
// verdad: doc_kind "fiscal" con 22 campos de remito adentro. Un dato que se
// contradice a sí mismo es peor que uno que falta, porque nadie lo mira.
const SOLO_REMITO = new Set(
  fieldsForCountries(['AR'], 'remito').map(([id]) => id)
    .filter((id) => !fieldsForCountries(['AR'], 'fiscal').some(([f]) => f === id)),
)
function tipoCoherente(docKind, mapping) {
  const pedido = docKind === 'remito' ? 'remito' : 'fiscal'
  const campos = Object.keys(mapping || {})
  if (!campos.length) return pedido
  const deRemito = campos.filter((f) => SOLO_REMITO.has(f)).length
  if (pedido === 'fiscal' && deRemito >= 2) {
    console.warn(`[config] llegó doc_kind="fiscal" con ${deRemito} campos que solo existen en remitos — se guarda como "remito"`)
    return 'remito'
  }
  return pedido
}

export async function saveBoardConfig(accountId, boardId, cfg = {}) {
  const {
    mapping = {}, language = 'en', fileColumnId = null,
    countries = [], currencies = [],
    dedupEnabled = false, lineItemsEnabled = false, lineItemsMapping = {},
    renameItemEnabled = false, onlyFiscalDocs = false, filterMode = 'all', filterTaxIds = [],
    statusColumnId = null, statusEnabled = true, taxIdsPlain = false, automationConfirmed = false,
    docKind = 'fiscal',
  } = cfg
  const cleanArr = (a) => (Array.isArray(a) ? a : []).map((s) => String(s).trim()).filter(Boolean)
  const countriesC = cleanArr(countries)
  const currenciesC = cleanArr(currencies)
  const cleanTaxIds = cleanArr(filterTaxIds)
  // country_override / currency_override = el primero elegido (hint del extractor).
  const countryO = countriesC[0] || null
  const currencyO = currenciesC[0] || null
  await pool.query(
    `insert into board_configs
       (account_id, board_id, mapping, country_override, currency_override, ui_language,
        dedup_enabled, line_items_enabled, line_items_mapping, rename_item_enabled, only_fiscal_docs, filter_mode, filter_tax_ids, countries, currencies, file_column_id, status_column_id, status_enabled, tax_ids_plain, automation_confirmed, doc_kind, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, now())
     on conflict (account_id, board_id) do update set
       mapping = $3, country_override = $4, currency_override = $5, ui_language = $6,
       dedup_enabled = $7, line_items_enabled = $8, line_items_mapping = $9, rename_item_enabled = $10,
       only_fiscal_docs = $11, filter_mode = $12, filter_tax_ids = $13, countries = $14, currencies = $15, file_column_id = $16,
       status_column_id = $17, status_enabled = $18, tax_ids_plain = $19, automation_confirmed = $20, doc_kind = $21, updated_at = now()`,
    [accountId, boardId, JSON.stringify(mapping), countryO, currencyO, language,
      !!dedupEnabled, !!lineItemsEnabled, JSON.stringify(lineItemsMapping || {}), !!renameItemEnabled,
      !!onlyFiscalDocs, filterMode || 'all', JSON.stringify(cleanTaxIds),
      JSON.stringify(countriesC), JSON.stringify(currenciesC), fileColumnId || null,
      statusColumnId || null, statusEnabled !== false, !!taxIdsPlain, !!automationConfirmed,
      tipoCoherente(docKind, mapping)],
  )
  // upsert de la instalación (defaults a nivel cuenta)
  await pool.query(
    `insert into installations (account_id, ui_language, default_country, default_currency, updated_at)
       values ($1, $2, $3, $4, now())
     on conflict (account_id) do update set
       ui_language = $2,
       default_country  = coalesce($3, installations.default_country),
       default_currency = coalesce($4, installations.default_currency),
       updated_at = now()`,
    [accountId, language, countryO, currencyO],
  )
}

// Fija la columna de estado la PRIMERA vez que se pudo resolver sin ambigüedad
// (tablero con una sola columna de estado). Así, si el usuario agrega otra columna
// de estado más adelante, el tablero sigue escribiendo en la de siempre en vez de
// volverse ambiguo. No pisa una elección explícita del usuario.
export async function adoptStatusColumnId(accountId, boardId, columnId) {
  if (!columnId) return
  await pool.query(
    `update board_configs set status_column_id = $3, updated_at = now()
      where account_id = $1 and board_id = $2 and coalesce(status_column_id, '') = ''`,
    [accountId, boardId, String(columnId)],
  )
}

// Guarda el nombre/slug de la cuenta la primera vez que los conocemos (no los pisa
// después: si el cliente renombra su cuenta, el dato viejo igual sirve de referencia
// y evitamos un UPDATE en cada lectura).
export async function saveAccountInfo(accountId, name, slug) {
  if (!accountId || (!name && !slug)) return
  await pool.query(
    `insert into installations (account_id, account_name, account_slug, updated_at)
       values ($1, $2, $3, now())
     on conflict (account_id) do update set
       account_name = coalesce(nullif(installations.account_name, ''), $2),
       account_slug = coalesce(nullif(installations.account_slug, ''), $3),
       updated_at = now()`,
    [String(accountId), name || null, slug || null],
  )
}

export async function getAccountName(accountId) {
  const { rows } = await pool.query(
    'select account_name, account_slug from installations where account_id = $1', [String(accountId)],
  )
  return rows[0] || null
}

// Idioma guardado a nivel cuenta (fallback para tableros que aún no se guardaron).
export async function getInstallationLanguage(accountId) {
  const { rows } = await pool.query('select ui_language from installations where account_id = $1', [String(accountId)])
  return rows[0]?.ui_language || null
}

// Auto-guardado SOLO del idioma (no toca el mapeo ni las reglas): es una
// preferencia, no debería requerir el botón Guardar. Actualiza la fila del
// tablero si existe + upsert del default de la cuenta.
export async function saveLanguage(accountId, boardId, language) {
  const lang = ['en', 'es'].includes(language) ? language : 'en'
  await pool.query(
    'update board_configs set ui_language = $3, updated_at = now() where account_id = $1 and board_id = $2',
    [String(accountId), String(boardId), lang],
  )
  await pool.query(
    `insert into installations (account_id, ui_language, updated_at) values ($1, $2, now())
     on conflict (account_id) do update set ui_language = $2, updated_at = now()`,
    [String(accountId), lang],
  )
}

// ── Anti-duplicados: registro de facturas ya cargadas ──
export async function findInvoiceKey(accountId, boardId, key) {
  const { rows } = await pool.query(
    `select item_id, created_at from invoice_keys
       where account_id = $1 and board_id = $2 and dedup_key = $3`,
    [accountId, boardId, key],
  )
  return rows[0] || null
}
export async function recordInvoiceKey(accountId, boardId, key, itemId) {
  await pool.query(
    `insert into invoice_keys (account_id, board_id, dedup_key, item_id)
       values ($1, $2, $3, $4)
     on conflict (account_id, board_id, dedup_key) do nothing`,
    [accountId, boardId, key, itemId ? String(itemId) : null],
  )
}

// Reclama la llave ATÓMICAMENTE (insert-first). Evita la carrera de dos triggers
// simultáneos con la misma factura: solo uno logra insertar; el otro recibe al
// dueño existente. { claimed: true } | { claimed: false, existing: {item_id, created_at} }
export async function claimInvoiceKey(accountId, boardId, key, itemId) {
  const { rows } = await pool.query(
    `insert into invoice_keys (account_id, board_id, dedup_key, item_id)
       values ($1, $2, $3, $4)
     on conflict (account_id, board_id, dedup_key) do nothing
     returning item_id`,
    [accountId, boardId, key, itemId ? String(itemId) : null],
  )
  if (rows.length) return { claimed: true }
  return { claimed: false, existing: await findInvoiceKey(accountId, boardId, key) }
}

// Libera una llave reclamada por ESTE item. Se usa cuando la carga falla DESPUÉS
// de reclamar: si no, la factura quedaría "reservada" por un ítem que nunca la
// cargó y otro ítem legítimo sería marcado duplicado. Solo borra si el dueño es
// el mismo item (no toca claims ajenos).
export async function releaseInvoiceKey(accountId, boardId, key, itemId) {
  await pool.query(
    `delete from invoice_keys
      where account_id = $1 and board_id = $2 and dedup_key = $3 and item_id = $4`,
    [accountId, boardId, key, String(itemId)],
  )
}

// ── Subítems: derecho exclusivo a crearlos ──
// Insert-first atómico: si dos disparos simultáneos entran con el mismo ítem, solo
// uno inserta y crea los renglones; el otro se saltea. Antes ambos preguntaban
// "¿ya tiene subítems?", los dos veían 0 y los dos creaban (duplicados).
// El reclamo es de VIDA CORTA (10 min): solo existe para tapar la ventana de la
// carrera, que dura segundos. Uno viejo se considera vencido y se puede volver a
// tomar — así, si alguien borra los subítems a mano y vuelve a leer, se recrean.
export async function claimSubitems(accountId, itemId) {
  const { rows } = await pool.query(
    `insert into subitem_claims (account_id, item_id) values ($1, $2)
     on conflict (account_id, item_id) do update set created_at = now()
       where subitem_claims.created_at < now() - interval '10 minutes'
     returning item_id`,
    [accountId, String(itemId)],
  )
  return rows.length > 0
}

// Libera el reclamo si la creación falló, para que un reintento pueda hacerla.
export async function releaseSubitems(accountId, itemId) {
  await pool.query(
    'delete from subitem_claims where account_id = $1 and item_id = $2',
    [accountId, String(itemId)],
  )
}

// ── Histórico de lecturas ──
export async function logExtraction(row = {}) {
  const {
    accountId, boardId, itemId, detectedCountry, model,
    inputTokens, outputTokens, fieldsWritten, status, error,
  } = row
  const { rows } = await pool.query(
    `insert into extractions
       (account_id, board_id, item_id, detected_country, model, input_tokens, output_tokens, fields_written, status, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id`,
    [accountId, boardId, itemId || null, detectedCountry || null, model || null,
      inputTokens || null, outputTokens || null, fieldsWritten || null, status, error || null],
  )
  return rows[0]?.id ?? null
}

// ── Plan de la cuenta ──
// Lee installations.plan (default de config si no hay fila). Devuelve el id.
export async function getAccountPlan(accountId) {
  const { rows } = await pool.query(
    `select plan from installations where account_id = $1`, [String(accountId)],
  )
  return rows[0]?.plan || config.defaultPlan
}

// Setea el plan de una cuenta (upsert). Se usa para grants manuales (ej. tu cuenta
// = enterprise) y, a futuro, desde el webhook de suscripción de Monday.
export async function setAccountPlan(accountId, plan) {
  await pool.query(
    `insert into installations (account_id, plan, updated_at) values ($1, $2, now())
     on conflict (account_id) do update set plan = $2, updated_at = now()`,
    [String(accountId), plan],
  )
}

// ── Corta-loops: lecturas recientes de la cuenta y del mismo item ──
// accountMin / itemMin en minutos. Usa el índice idx_extractions_account.
export async function recentReadCounts(accountId, itemId, accountMin = 60, itemMin = 15) {
  const { rows } = await pool.query(
    `select
       count(*) filter (where created_at >= now() - make_interval(mins => $3::int)) as account_recent,
       count(*) filter (where item_id::text = $2 and created_at >= now() - make_interval(mins => $4::int)) as same_item
     from extractions where account_id = $1`,
    [String(accountId), itemId != null ? String(itemId) : '', accountMin, itemMin],
  )
  return {
    accountRecent: Number(rows[0]?.account_recent || 0),
    sameItem: Number(rows[0]?.same_item || 0),
  }
}

// ── Uso: cuántas facturas leyó la cuenta (para mostrarle el contador al usuario) ──
// Solo lecturas exitosas (status='ok'). Incluye el plan y su límite mensual.
export async function getUsage(accountId) {
  const { rows } = await pool.query(
    `select
       count(*) filter (where status = 'ok') as total,
       count(*) filter (where status = 'ok' and created_at >= date_trunc('month', now())) as month
     from extractions where account_id = $1`,
    [String(accountId)],
  )
  const r = rows[0] || {}
  const plan = await getAccountPlan(accountId)
  return {
    total: Number(r.total || 0),
    month: Number(r.month || 0),
    plan, planLabel: planLabel(plan), limit: planLimit(plan), // limit null = ilimitado
  }
}

// ── Borrado de datos de la cuenta (GDPR / desinstalación) ──
// Política de Monday: eliminar los datos del cliente ≤10 días post-uninstall.
// Se dispara desde el evento 'uninstall' del webhook de lifecycle. Transacción
// atómica: o se borra todo, o no se borra nada. Los nombres de tabla son fijos
// (no vienen del usuario) → seguro interpolarlos.
export async function deleteAccountData(accountId) {
  if (!accountId) return null
  const client = await pool.connect()
  const stats = {}
  try {
    await client.query('BEGIN')
    // subitem_claims también guarda IDs de ítems del cliente: si no se borra, quedan
    // datos suyos después de desinstalar.
    for (const table of ['invoice_keys', 'subitem_claims', 'extractions', 'board_configs', 'installations']) {
      const r = await client.query(`delete from ${table} where account_id = $1`, [String(accountId)])
      stats[table] = r.rowCount
    }
    await client.query('COMMIT')
    return stats
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}