// db.mjs — Pool de PostgreSQL + migraciones + helpers de config/histórico.
import pg from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const { Pool } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

// SSL: en el droplet usamos el CA cert de DO (verify-full). En dev/local sin el
// cert, rejectUnauthorized:false para no frenar el desarrollo.
const caCertPath = join(__dirname, 'certs', 'do-pg-ca.crt')
const ssl = existsSync(caCertPath)
  ? { ca: readFileSync(caCertPath, 'utf8'), rejectUnauthorized: true }
  : { rejectUnauthorized: false }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
    `select mapping, status_column_id, country_override, currency_override, ui_language
       from board_configs where account_id = $1 and board_id = $2`,
    [accountId, boardId],
  )
  return rows[0] || null
}

export async function saveBoardConfig(accountId, boardId, cfg = {}) {
  const { mapping = {}, defaultCountry = null, defaultCurrency = null, language = 'en' } = cfg
  await pool.query(
    `insert into board_configs (account_id, board_id, mapping, country_override, currency_override, ui_language, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
     on conflict (account_id, board_id) do update set
       mapping = $3, country_override = $4, currency_override = $5, ui_language = $6, updated_at = now()`,
    [accountId, boardId, JSON.stringify(mapping), defaultCountry, defaultCurrency, language],
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
    [accountId, language, defaultCountry, defaultCurrency],
  )
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