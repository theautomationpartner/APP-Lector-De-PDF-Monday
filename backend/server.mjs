import express from 'express'
import jwt from 'jsonwebtoken'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config, mondaySecrets } from './config.mjs'
import { extractInvoice } from './extractor.mjs'
import {
  getBoardIdFromItem, getLatestFileUrl, getColumnTypes,
  buildColumnValues, writeColumns, postComment, setStatus, getStatusColumnId,
} from './monday.mjs'
import { runStartupMigrations, getBoardConfig, saveBoardConfig, logExtraction, findInvoiceKey, recordInvoiceKey, deleteAccountData, getUsage } from './db.mjs'
import { t, lifecycleLabels } from './i18n.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

const PORT = config.port
const SIGNING_SECRET = config.mondaySigningSecret   // valida el JWT de la receta
const CLIENT_SECRET = config.mondayClientSecret     // valida el session token de la vista
const MODEL = config.model

// Verifica un JWT de Monday contra cualquiera de los secretos de la app (según
// la superficie firma con el Client Secret o con el Signing Secret). Devuelve el
// payload decodificado o lanza si ninguno valida.
function verifyWithAnySecret(token) {
  if (!mondaySecrets.length) return jwt.decode(token) // dev/local sin secretos
  let lastErr
  for (const s of mondaySecrets) {
    try { return jwt.verify(token, s) } catch (err) { lastErr = err }
  }
  throw lastErr
}

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
    const countries = cfg?.countries?.length ? cfg.countries : (cfg?.country_override ? [cfg.country_override] : [])
    const currencies = cfg?.currencies?.length ? cfg.currencies : (cfg?.currency_override ? [cfg.currency_override] : [])
    res.json({
      mapping: cfg?.mapping || {},
      countries,
      currencies,
      fileColumnId: cfg?.file_column_id || '',
      language: cfg?.ui_language || 'en',
      dedupEnabled: cfg?.dedup_enabled ?? false,
    })
  } catch (e) {
    res.status(401).json({ error: e.message })
  }
})

app.post('/api/config/:boardId', async (req, res) => {
  try {
    const { accountId } = authSession(req)
    const { mapping, countries, currencies, language, fileColumnId, dedupEnabled } = req.body || {}
    await saveBoardConfig(accountId, req.params.boardId, {
      mapping, countries, currencies, language, fileColumnId, dedupEnabled,
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(401).json({ error: e.message })
  }
})

// Contador de uso para la vista: cuántas facturas leyó la cuenta (mes + total).
// Solo el CONTEO — el costo/consumo es interno (ver scripts/usage-report.mjs).
app.get('/api/usage', async (req, res) => {
  try {
    const { accountId } = authSession(req)
    res.json(await getUsage(accountId))
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
      return res.status(400).json({ error: 'missing shortLivedToken / itemId' })
    }
    if (!boardId) boardId = await getBoardIdFromItem(shortLivedToken, itemId)
    if (!boardId) throw new Error(t(lang, 'noBoard', { itemId }))

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
    const file = await getLatestFileUrl(shortLivedToken, itemId, cfg?.file_column_id || '')
    if (!file?.url) throw new Error(t(lang, 'noPdf'))

    // 5) Bajar el archivo (PDF o imagen) y leerlo con Claude (con hints país/moneda).
    const buf = Buffer.from(await (await fetch(file.url)).arrayBuffer())
    const { data, usage, model } = await extractInvoice(
      buf.toString('base64'),
      file.mediaType,
      MODEL,
      { countries: cfg?.countries || [] },
    )

    // 5.5) ANTI-DUPLICADOS (antes de escribir). IDs fiscales normalizados a
    // alfanumérico-mayúscula para comparar (guiones/puntos/espacios no afectan).
    const normId = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase()
    // Llave = ID fiscal emisor + número + tipo (normalizados).
    const dedupKey = `${normId(data.supplier_tax_id)}|${normId(data.invoice_number)}|${normId(data.document_type)}`
    const keyComplete = !!(normId(data.supplier_tax_id) && normId(data.invoice_number))
    if (cfg?.dedup_enabled && keyComplete) {
      const seen = await findInvoiceKey(accountId, boardId, dedupKey)
      // Otro ítem con la misma factura = duplicado. El MISMO ítem (re-disparo) NO.
      if (seen && String(seen.item_id) !== String(itemId)) {
        if (statusColId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.duplicate)
        const date = seen.created_at instanceof Date ? seen.created_at.toISOString().slice(0, 10) : ''
        await postComment(shortLivedToken, itemId, t(lang, 'duplicate', { itemId: seen.item_id, date }))
        await logExtraction({ accountId, boardId, itemId, detectedCountry: data.detected_country, model, status: 'duplicate' })
        console.log(`[extract] DUPLICADA item=${itemId} key=${dedupKey} vs item=${seen.item_id}`)
        return res.status(200).json({ ok: true, duplicate: true })
      }
    }

    // 6) Escribir en las columnas mapeadas (según su tipo).
    const colTypes = await getColumnTypes(shortLivedToken, boardId)
    const cv = buildColumnValues(mapping, data, colTypes)
    await writeColumns(shortLivedToken, boardId, itemId, cv)
    // Registrar la factura como vista (para dedup futuro), esté el toggle ON u OFF.
    if (keyComplete) await recordInvoiceKey(accountId, boardId, dedupKey, itemId)

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
// Webhook de lifecycle de la app — Monday notifica install/uninstall/subscription.
// En 'uninstall' borramos TODOS los datos de la cuenta (política Monday: ≤10 días
// post-desinstalación). Auth: JWT firmado con un secreto de la app.
// Docs: https://developer.monday.com/apps/docs/app-lifecycle-events
// ───────────────────────────────────────────────────────────────────────────
app.post('/api/webhooks/monday-lifecycle', async (req, res) => {
  // Responder ya: Monday reintenta si tardamos. El trabajo va después.
  res.status(200).json({ ok: true })
  try {
    const auth = req.headers.authorization
    if (!auth) return console.warn('[lifecycle] sin token de autorización')
    verifyWithAnySecret(auth) // 401 implícito: si falla, no ejecutamos nada
    const { type = '', data = {} } = req.body || {}
    const accountId = String(data.account_id ?? '')
    console.log(`[lifecycle] evento=${type} account=${accountId}`)
    if (type === 'uninstall' && accountId) {
      const stats = await deleteAccountData(accountId)
      console.log(`[lifecycle] datos borrados account=${accountId}:`, stats)
    }
  } catch (err) {
    console.error('[lifecycle] error:', err.message)
  }
})

// Domain ownership verification para el privacy & security review de Monday.
// Docs: https://developer.monday.com/apps/docs/privacy-and-security
app.get('/monday-app-association.json', (_req, res) => {
  if (!config.mondayClientId) return res.status(500).json({ error: 'MONDAY_CLIENT_ID not configured' })
  res.json({ apps: [{ clientID: config.mondayClientId }] })
})

// Páginas públicas (sin login, HTTPS, dominio propio) que pide el marketplace:
// /onboarding = "How to use" (va al form de submission), /privacy y /terms = legales.
const PAGES_DIR = path.join(__dirname, 'public-pages')
app.get('/onboarding', (_req, res) => res.sendFile(path.join(PAGES_DIR, 'onboarding.html')))
app.get('/privacy', (_req, res) => res.sendFile(path.join(PAGES_DIR, 'privacy.html')))
app.get('/terms', (_req, res) => res.sendFile(path.join(PAGES_DIR, 'terms.html')))

// ───────────────────────────────────────────────────────────────────────────
// Servir el frontend (build de Vite copiado a ./public). API/recetas van arriba.
// Cache: index.html sin cache (para ver los deploys al toque); assets hasheados
// inmutables. Cloudflare respeta el no-cache del HTML.
// ───────────────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public')
if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      } else if (/\.(js|css|woff2?|png|jpg|jpeg|svg|webp)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }))
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => res.send('AI Invoice Reader — backend OK (frontend not copied to ./public)'))
}

// ───────────────────────────────────────────────────────────────────────────
// Arranque: migrar la DB y escuchar.
// ───────────────────────────────────────────────────────────────────────────
runStartupMigrations()
  .catch((e) => console.error('[db] migración falló:', e.message))
  .finally(() => app.listen(PORT, () => console.log(`Lector PDF IA backend escuchando en :${PORT}`)))