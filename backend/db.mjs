// db.mjs — Pool de PostgreSQL + migraciones + helpers de config/histórico.
import pg from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.mjs'

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
  console.log('[db] migraciones OK')
}

// ── Config por (cuenta, tablero) ──
export async function getBoardConfig(accountId, boardId) {
  const { rows } = await pool.query(
    `select mapping, status_column_id, file_column_id, country_override, currency_override, ui_language,
            dedup_enabled, filter_mode, filter_tax_ids, countries, currencies
       from board_configs where account_id = $1 and board_id = $2`,
    [accountId, boardId],
  )
  return rows[0] || null
}

export async function saveBoardConfig(accountId, boardId, cfg = {}) {
  const {
    mapping = {}, language = 'en', fileColumnId = null,
    countries = [], currencies = [],
    dedupEnabled = false, filterMode = 'all', filterTaxIds = [],
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
        dedup_enabled, filter_mode, filter_tax_ids, countries, currencies, file_column_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     on conflict (account_id, board_id) do update set
       mapping = $3, country_override = $4, currency_override = $5, ui_language = $6,
       dedup_enabled = $7, filter_mode = $8, filter_tax_ids = $9,
       countries = $10, currencies = $11, file_column_id = $12, updated_at = now()`,
    [accountId, boardId, JSON.stringify(mapping), countryO, currencyO, language,
      !!dedupEnabled, filterMode || 'all', JSON.stringify(cleanTaxIds),
      JSON.stringify(countriesC), JSON.stringify(currenciesC), fileColumnId || null],
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

// ── Histórico de lecturas ──
export async function logExtraction(row = {}) {
  const {
    accountId, boardId, itemId, detectedCountry, model,
    inputTokens, outputTokens, fieldsWritten, status, error,
  } = row
  await pool.query(
    `insert into extractions
       (account_id, board_id, item_id, detected_country, model, input_tokens, output_tokens, fields_written, status, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [accountId, boardId, itemId || null, detectedCountry || null, model || null,
      inputTokens || null, outputTokens || null, fieldsWritten || null, status, error || null],
  )
}

// ── Uso: cuántas facturas leyó la cuenta (para mostrarle el contador al usuario) ──
// Solo lecturas exitosas (status='ok'). Por cuenta (unidad de facturación futura).
export async function getUsage(accountId) {
  const { rows } = await pool.query(
    `select
       count(*) filter (where status = 'ok') as total,
       count(*) filter (where status = 'ok' and created_at >= date_trunc('month', now())) as month
     from extractions where account_id = $1`,
    [String(accountId)],
  )
  const r = rows[0] || {}
  return { total: Number(r.total || 0), month: Number(r.month || 0) }
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
    for (const table of ['invoice_keys', 'extractions', 'board_configs', 'installations']) {
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