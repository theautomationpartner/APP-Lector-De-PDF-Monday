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
import { runStartupMigrations, getBoardConfig, saveBoardConfig, logExtraction, claimInvoiceKey, deleteAccountData, getUsage } from './db.mjs'
import { t, lifecycleLabels } from './i18n.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

// Headers de seguridad: solo monday puede iframear la app (anti-clickjacking).
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', 'frame-ancestors https://*.monday.com https://monday.com')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
})

const PORT = config.port
const SIGNING_SECRET = config.mondaySigningSecret   // valida el JWT de la receta
const CLIENT_SECRET = config.mondayClientSecret     // valida el session token de la vista
const MODEL = config.model
const IS_PROD = config.appEnv === 'production'
const JWT_OPTS = { algorithms: ['HS256'] }          // Monday firma HS256; pineado

// En producción los secretos de Monday son OBLIGATORIOS: sin ellos la auth caería
// en silencio a decode() (cualquier token falsificado pasaría). Mejor no arrancar.
if (IS_PROD && (!SIGNING_SECRET || !CLIENT_SECRET)) {
  console.error('[config] FALTAN secretos de Monday en producción — no arranco sin auth.')
  process.exit(1)
}

// Errores que SÍ se le muestran al usuario (comentario en el board). El resto de
// los errores internos van al log; al usuario le llega un mensaje genérico.
class UserError extends Error {}
class AuthError extends Error {}

// Verifica un JWT de Monday contra cualquiera de los secretos de la app (según
// la superficie firma con el Client Secret o con el Signing Secret). Devuelve el
// payload decodificado o lanza si ninguno valida.
function verifyWithAnySecret(token) {
  if (!mondaySecrets.length) return jwt.decode(token) // solo dev/local (en prod no arranca sin secretos)
  let lastErr
  for (const s of mondaySecrets) {
    try { return jwt.verify(token, s, JWT_OPTS) } catch (err) { lastErr = err }
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
  if (!token) throw new AuthError('missing session token')
  let claims
  try {
    claims = CLIENT_SECRET ? jwt.verify(token, CLIENT_SECRET, JWT_OPTS) : jwt.decode(token)
  } catch { throw new AuthError('invalid session token') }
  const accountId = claims?.dat?.account_id ?? claims?.accountId
  if (!accountId) throw new AuthError('invalid session token')
  return { accountId: String(accountId) }
}

// 401 solo para fallas de auth; el resto es 500 con mensaje genérico (el detalle
// queda en el log del server, no se filtra al cliente).
function sendApiError(res, e) {
  if (e instanceof AuthError) return res.status(401).json({ error: e.message })
  console.error('[api] error:', e.message)
  return res.status(500).json({ error: 'internal error' })
}

// Valida/acota el body de la config antes de guardarlo (viene del iframe, pero
// no confiamos: tipos correctos, listas ISO, largos acotados).
function sanitizeConfigBody(body = {}) {
  const str = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max) : '')
  const isoArr = (a, re, max = 30) => (Array.isArray(a) ? a : [])
    .map((x) => String(x).trim().toUpperCase()).filter((x) => re.test(x)).slice(0, max)
  const mapping = {}
  if (body.mapping && typeof body.mapping === 'object' && !Array.isArray(body.mapping)) {
    for (const [k, v] of Object.entries(body.mapping).slice(0, 100)) {
      if (typeof v === 'string' && v) mapping[str(k)] = str(v)
    }
  }
  return {
    mapping,
    countries: isoArr(body.countries, /^[A-Z]{2}$/),
    currencies: isoArr(body.currencies, /^[A-Z]{3}$/),
    language: ['en', 'es'].includes(body.language) ? body.language : 'en',
    fileColumnId: str(body.fileColumnId),
    dedupEnabled: !!body.dedupEnabled,
  }
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
    sendApiError(res, e)
  }
})

app.post('/api/config/:boardId', async (req, res) => {
  try {
    const { accountId } = authSession(req)
    await saveBoardConfig(accountId, req.params.boardId, sanitizeConfigBody(req.body))
    res.json({ ok: true })
  } catch (e) {
    sendApiError(res, e)
  }
})

// Contador de uso para la vista: cuántas facturas leyó la cuenta (mes + total).
// Solo el CONTEO — el costo/consumo es interno (ver scripts/usage-report.mjs).
app.get('/api/usage', async (req, res) => {
  try {
    const { accountId } = authSession(req)
    res.json(await getUsage(accountId))
  } catch (e) {
    sendApiError(res, e)
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
    const claims = SIGNING_SECRET ? jwt.verify(auth, SIGNING_SECRET, JWT_OPTS) : jwt.decode(auth)
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
    if (!boardId) throw new UserError(t(lang, 'noBoard', { itemId }))

    // 2) Config del tablero (mapeo + país/moneda + idioma) desde Postgres.
    const cfg = await getBoardConfig(accountId, boardId)
    const mapping = cfg?.mapping || {}
    lang = cfg?.ui_language || 'en'
    const labels = lifecycleLabels(lang)

    // 2.5) Tope mensual según el PLAN de la cuenta (Enterprise = ilimitado). Frena
    // ANTES de gastar crédito de IA. getUsage ya trae el límite del plan.
    const acctUsage = await getUsage(accountId)
    if (acctUsage.limit != null && acctUsage.month >= acctUsage.limit) {
      throw new UserError(t(lang, 'limitReached', { n: acctUsage.limit }))
    }

    // 3) Estado → "leyendo".
    statusColId = await getStatusColumnId(shortLivedToken, itemId, Object.values(labels))
    if (statusColId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.processing)

    // 4) Validar mapeo y PDF ANTES de gastar crédito de IA.
    if (!Object.values(mapping).filter(Boolean).length) throw new UserError(t(lang, 'noMapping'))
    const file = await getLatestFileUrl(shortLivedToken, itemId, cfg?.file_column_id || '')
    if (!file?.url) throw new UserError(t(lang, 'noPdf'))

    // 5) Bajar el archivo (PDF o imagen) y leerlo con Claude (con hints país/moneda).
    // Cap de tamaño (Claude acepta hasta ~32MB; y protege la RAM del droplet) +
    // timeout para no quedar colgados en una descarga.
    const MAX_FILE_BYTES = 30 * 1024 * 1024
    const fresp = await fetch(file.url, { signal: AbortSignal.timeout(30_000) })
    if (!fresp.ok) throw new UserError(t(lang, 'noPdf'))
    const clen = Number(fresp.headers.get('content-length') || 0)
    if (clen > MAX_FILE_BYTES) throw new UserError(t(lang, 'fileTooBig', { mb: 30 }))
    const buf = Buffer.from(await fresp.arrayBuffer())
    if (buf.length > MAX_FILE_BYTES) throw new UserError(t(lang, 'fileTooBig', { mb: 30 }))
    const { data, usage, model } = await extractInvoice(
      buf.toString('base64'),
      file.mediaType,
      MODEL,
      { countries: cfg?.countries || [] },
    )

    // 5.5) ANTI-DUPLICADOS (antes de escribir). IDs fiscales normalizados a
    // alfanumérico-mayúscula para comparar (guiones/puntos/espacios no afectan).
    const normId = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase()
    // Llave = ID fiscal emisor + número + tipo (normalizados). Se reclama ATÓMICA-
    // MENTE (insert-first): dos triggers simultáneos con la misma factura no pueden
    // pasar los dos — solo uno inserta, el otro ve al dueño. Se registra siempre
    // (toggle ON u OFF) para tener histórico si el dedup se activa después.
    const dedupKey = `${normId(data.supplier_tax_id)}|${normId(data.invoice_number)}|${normId(data.document_type)}`
    const keyComplete = !!(normId(data.supplier_tax_id) && normId(data.invoice_number))
    if (keyComplete) {
      const claim = await claimInvoiceKey(accountId, boardId, dedupKey, itemId)
      const owner = claim.claimed ? null : claim.existing
      // Otro ítem con la misma factura = duplicado. El MISMO ítem (re-disparo) NO.
      if (cfg?.dedup_enabled && owner && String(owner.item_id) !== String(itemId)) {
        if (statusColId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.duplicate)
        const date = owner.created_at instanceof Date ? owner.created_at.toISOString().slice(0, 10) : ''
        await postComment(shortLivedToken, itemId, t(lang, 'duplicate', { itemId: owner.item_id, date }))
        await logExtraction({ accountId, boardId, itemId, detectedCountry: data.detected_country, model, status: 'duplicate' })
        console.log(`[extract] DUPLICADA item=${itemId} key=${dedupKey} vs item=${owner.item_id}`)
        return res.status(200).json({ ok: true, duplicate: true })
      }
    }

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
    // Al usuario solo le mostramos errores "esperables" (UserError, ya traducidos);
    // los internos (DB, APIs) van al log y al board le llega un mensaje genérico.
    const userMsg = e instanceof UserError ? e.message : t(lang, 'internalError')
    try {
      if (shortLivedToken && itemId) {
        const labels = lifecycleLabels(lang)
        if (statusColId && boardId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.error)
        await postComment(shortLivedToken, itemId, t(lang, 'failed', { msg: userMsg }))
      }
      if (accountId && boardId) {
        await logExtraction({ accountId, boardId, itemId, status: 'error', error: e.message })
      }
    } catch { /* noop */ }
    res.status(200).json({ ok: false, error: userMsg })
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
// Bind SOLO a localhost: el único camino de entrada es nginx (que sí escucha
// afuera). Evita que alguien le pegue directo al puerto 8080 salteando el proxy.
runStartupMigrations()
  .catch((e) => console.error('[db] migración falló:', e.message))
  .finally(() => app.listen(PORT, '127.0.0.1', () => console.log(`Lector PDF IA backend escuchando en 127.0.0.1:${PORT}`)))