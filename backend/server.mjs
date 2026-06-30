import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractInvoice } from './extractor.mjs'
import {
  getBoardIdFromItem, getLatestPdfUrl, getColumnTypes,
  buildColumnValues, writeColumns, postComment, setStatus, getStatusColumnId,
} from './monday.mjs'
import { runStartupMigrations, getBoardConfig, saveBoardConfig, logExtraction } from './db.mjs'
import { t, lifecycleLabels } from './i18n.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

const PORT = process.env.PORT || 8080
const SIGNING_SECRET = process.env.MONDAY_SIGNING_SECRET   // valida el JWT de la receta
const CLIENT_SECRET = process.env.MONDAY_CLIENT_SECRET     // valida el session token de la vista
const MODEL = process.env.MODEL || 'claude-haiku-4-5'

app.get('/health', (_req, res) => res.json({ ok: true }))

// ───────────────────────────────────────────────────────────────────────────
// API de configuración — la vista (board view) guarda/lee el mapeo en Postgres.
// Auth: session token de Monday (firmado con el Client Secret de la app).
// ───────────────────────────────────────────────────────────────────────────
function authSession(req) {
  const token = req.headers.authorization
  if (!token) throw new Error('missing session token')
  const claims = CLIENT_SECRET ? jwt.verify(token, CLIENT_SECRET) : jwt.decode(token)
  const accountId = claims?.dat?.account_id ?? claims?.accountId
  if (!accountId) throw new Error('invalid session token')
  return { accountId: String(accountId) }
}

app.get('/api/config/:boardId', async (req, res) => {
  try {
    const { accountId } = authSession(req)
    const cfg = await getBoardConfig(accountId, req.params.boardId)
    res.json({
      mapping: cfg?.mapping || {},
      defaultCountry: cfg?.country_override || '',
      defaultCurrency: cfg?.currency_override || '',
      language: cfg?.ui_language || 'en',
    })
  } catch (e) {
    res.status(401).json({ error: e.message })
  }
})

app.post('/api/config/:boardId', async (req, res) => {
  try {
    const { accountId } = authSession(req)
    const { mapping, defaultCountry, defaultCurrency, language } = req.body || {}
    await saveBoardConfig(accountId, req.params.boardId, { mapping, defaultCountry, defaultCurrency, language })
    res.json({ ok: true })
  } catch (e) {
    res.status(401).json({ error: e.message })
  }
})

// ───────────────────────────────────────────────────────────────────────────
// Endpoint de la receta — lee el PDF del item y carga las columnas mapeadas.
// ───────────────────────────────────────────────────────────────────────────
app.post('/monday/extract', async (req, res) => {
  let shortLivedToken, accountId, boardId, itemId, statusColId, lang = 'en'
  try {
    // 1) Auth: JWT firmado con el Signing Secret de la app.
    const auth = req.headers.authorization
    const claims = SIGNING_SECRET ? jwt.verify(auth, SIGNING_SECRET) : jwt.decode(auth)
    shortLivedToken = claims?.shortLivedToken
    accountId = String(claims?.dat?.account_id ?? claims?.accountId ?? '')

    const body = req.body || {}
    const payload = body.payload || {}
    const input = payload.inputFields || body.inputFields || {}
    itemId = input.itemId ?? input.item?.id ?? input.item ?? payload.itemId
    boardId = input.boardId ?? input.board?.id ?? input.board ?? payload.boardId
    if (!shortLivedToken || !itemId) {
      return res.status(400).json({ error: 'faltan shortLivedToken / itemId' })
    }
    if (!boardId) boardId = await getBoardIdFromItem(shortLivedToken, itemId)
    if (!boardId) throw new Error('No pude determinar el boardId del item ' + itemId)

    // 2) Config del tablero (mapeo + país/moneda + idioma) desde Postgres.
    const cfg = await getBoardConfig(accountId, boardId)
    const mapping = cfg?.mapping || {}
    lang = cfg?.ui_language || 'en'
    const labels = lifecycleLabels(lang)

    // 3) Estado → "leyendo".
    statusColId = await getStatusColumnId(shortLivedToken, itemId, Object.values(labels))
    if (statusColId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.processing)

    // 4) Validar mapeo y PDF ANTES de gastar crédito de IA.
    if (!Object.values(mapping).filter(Boolean).length) throw new Error(t(lang, 'noMapping'))
    const pdfUrl = await getLatestPdfUrl(shortLivedToken, itemId)
    if (!pdfUrl) throw new Error(t(lang, 'noPdf'))

    // 5) Bajar el PDF y leerlo con Claude (con hints de país/moneda).
    const pdfBuffer = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
    const { data, usage, model } = await extractInvoice(
      pdfBuffer.toString('base64'),
      MODEL,
      { country: cfg?.country_override || '', currency: cfg?.currency_override || '' },
    )

    // 6) Escribir en las columnas mapeadas (según su tipo).
    const colTypes = await getColumnTypes(shortLivedToken, boardId)
    const cv = buildColumnValues(mapping, data, colTypes)
    await writeColumns(shortLivedToken, boardId, itemId, cv)

    // 7) Estado → "leido" + comentario con lo cargado.
    if (statusColId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.done)
    const loaded = Object.entries(mapping)
      .filter(([f, c]) => c && (data[f] || '').toString().trim())
      .map(([f]) => `• ${f}: ${data[f]}`)
    await postComment(shortLivedToken, itemId, t(lang, 'loaded', { model, n: Object.keys(cv).length }) + '\n' + loaded.join('\n'))

    // 8) Histórico.
    await logExtraction({
      accountId, boardId, itemId, detectedCountry: data.detected_country, model,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      fieldsWritten: Object.keys(cv).length, status: 'ok',
    })

    console.log(`[extract] OK item=${itemId} cols=${Object.keys(cv).length} country=${data.detected_country} tokens=${usage.input_tokens}/${usage.output_tokens}`)
    res.status(200).json({ ok: true, written: Object.keys(cv).length, usage })
  } catch (e) {
    console.error('[extract] error:', e.message)
    try {
      if (shortLivedToken && itemId) {
        const labels = lifecycleLabels(lang)
        if (statusColId && boardId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.error)
        await postComment(shortLivedToken, itemId, t(lang, 'failed', { msg: e.message }))
      }
      if (accountId && boardId) {
        await logExtraction({ accountId, boardId, itemId, status: 'error', error: e.message })
      }
    } catch { /* noop */ }
    res.status(200).json({ ok: false, error: e.message })
  }
})

// ───────────────────────────────────────────────────────────────────────────
// Servir el frontend (build de Vite copiado a ./public). API/recetas van arriba.
// ───────────────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public')
if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR))
  app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')))
} else {
  app.get('/', (_req, res) => res.send('Lector PDF IA — backend OK (frontend no copiado a ./public)'))
}

// ───────────────────────────────────────────────────────────────────────────
// Arranque: migrar la DB y escuchar.
// ───────────────────────────────────────────────────────────────────────────
runStartupMigrations()
  .catch((e) => console.error('[db] migración falló:', e.message))
  .finally(() => app.listen(PORT, () => console.log(`Lector PDF IA backend escuchando en :${PORT}`)))