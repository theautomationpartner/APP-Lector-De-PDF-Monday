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
import { runStartupMigrations, getBoardConfig, saveBoardConfig, logExtraction, claimInvoiceKey, releaseInvoiceKey, deleteAccountData, getUsage, setAccountPlan } from './db.mjs'
import { planFromSubscription } from './plans.mjs'
import { syncReading, syncInstallation } from './internal-board.mjs'
import { t, lifecycleLabels } from './i18n.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

// Body malformado (JSON basura de bots/escaneres que sondean el dominio) o
// demasiado grande -> respuesta limpia, sin volcar el stack al log.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' })
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' })
  return next(err)
})

// Headers de seguridad. El board view corre DENTRO de monday → solo monday puede
// enmarcarlo (anti-clickjacking). Pero las páginas públicas (onboarding/privacy/
// terms) tienen que poder enmarcarse en cualquier lado — monday testea el "How to
// use" con iframetester.com — así que a ésas NO les ponemos la restricción.
const PUBLIC_PAGES = new Set(['/onboarding', '/privacy', '/terms'])
app.use((req, res, next) => {
  // HSTS: requisito de la review de monday (min 1 año). El TLS lo terminan
  // Cloudflare/nginx; el header viaja igual hasta el navegador.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!PUBLIC_PAGES.has(req.path)) {
    res.setHeader('Content-Security-Policy', 'frame-ancestors https://*.monday.com https://monday.com')
  }
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
  return { accountId: String(accountId), claims }
}

// Sincroniza el plan de la cuenta desde la `subscription` del JWT de monday (si la
// app esta monetizada, monday incluye { subscription: { plan_id, is_trial, ... } }
// tanto en el session token como en el JWT de la receta). SOLO escribe cuando hay
// una subscription valida -> preserva overrides manuales (ej. cuentas de dev en
// enterprise) cuando la cuenta no tiene subscription. Best-effort, no rompe el req.
async function syncPlanFromClaims(accountId, claims) {
  try {
    const sub = claims?.subscription || claims?.dat?.subscription
    if (!sub || !sub.plan_id) return
    const plan = planFromSubscription(sub)
    if (plan) { await setAccountPlan(accountId, plan); return }
    console.warn(`[plan] subscription con plan_id no reconocido: "${sub.plan_id}" (cuenta ${accountId})`)
  } catch (e) { console.warn('[plan] no se pudo sincronizar desde el JWT:', e.message) }
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
    const { accountId, claims } = authSession(req)
    await syncPlanFromClaims(accountId, claims) // al abrir la app, refresca el plan
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
    const { accountId, claims } = authSession(req)
    await syncPlanFromClaims(accountId, claims)
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
  let claimedKey = null // llave de dedup reclamada por ESTA corrida (para liberarla si falla)
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

    // 2.5) Plan de la cuenta desde la subscription del JWT de la receta (si la app
    // esta monetizada) + tope mensual segun ese plan (Enterprise = ilimitado). Frena
    // ANTES de gastar credito de IA. getUsage ya trae el limite del plan.
    await syncPlanFromClaims(accountId, claims)
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
      if (claim.claimed) claimedKey = dedupKey // si algo falla después, se libera en el catch
      const owner = claim.claimed ? null : claim.existing
      // Otro ítem con la misma factura = duplicado. El MISMO ítem (re-disparo) NO.
      if (cfg?.dedup_enabled && owner && String(owner.item_id) !== String(itemId)) {
        if (statusColId) await setStatus(shortLivedToken, boardId, itemId, statusColId, labels.duplicate)
        const date = owner.created_at instanceof Date ? owner.created_at.toISOString().slice(0, 10) : ''
        await postComment(shortLivedToken, itemId, t(lang, 'duplicate', { itemId: owner.item_id, date }))
        // La IA ya se ejecutó antes del chequeo de duplicado → el gasto es real
        // (y es culpa del usuario, que re-subió la misma factura). Se registra.
        const dupId = await logExtraction({ accountId, boardId, itemId, detectedCountry: data.detected_country, model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, status: 'duplicate' })
        void syncReading({ extractionId: dupId, accountId, detectedCountry: data.detected_country, model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, status: 'duplicate' })
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

    // 8) Histórico + tablero interno de ops (fire-and-forget, no frena la respuesta).
    const extractionId = await logExtraction({
      accountId, boardId, itemId, detectedCountry: data.detected_country, model,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      fieldsWritten: Object.keys(cv).length, status: 'ok',
    })
    void syncReading({ extractionId, accountId, detectedCountry: data.detected_country, model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, status: 'ok' })

    console.log(`[extract] OK item=${itemId} cols=${Object.keys(cv).length} country=${data.detected_country} tokens=${usage.input_tokens}/${usage.output_tokens}`)
    res.status(200).json({ ok: true, written: Object.keys(cv).length, usage })
  } catch (e) {
    console.error('[extract] error:', e.message)
    // Si ESTA corrida reclamó la llave de dedup y después falló, la liberamos:
    // la factura no quedó cargada, no debe quedar "reservada" como duplicado.
    if (claimedKey) await releaseInvoiceKey(accountId, boardId, claimedKey, itemId).catch(() => {})
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
        const errId = await logExtraction({ accountId, boardId, itemId, status: 'error', error: e.message })
        void syncReading({ extractionId: errId, accountId, status: 'error', error: e.message })
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
    if (type === 'install' && accountId) {
      // Alta en el tablero interno de instalaciones (best-effort).
      void syncInstallation(accountId, { estado: 'Activa' })
    } else if (type === 'uninstall' && accountId) {
      // Marcar Desinstalada en el tablero ANTES de borrar (el borrado se lleva el
      // mapeo board_item_id). La fila del tablero queda como histórico de churn.
      await syncInstallation(accountId, { estado: 'Desinstalada' })
      const stats = await deleteAccountData(accountId)
      console.log(`[lifecycle] datos borrados account=${accountId}:`, stats)
    } else if (type.startsWith('app_subscription_') && accountId) {
      // Monetizacion: el cliente creo / cambio / renovo / cancelo su plan.
      if (type === 'app_subscription_cancelled') {
        await setAccountPlan(accountId, 'free') // al cancelar, vuelve al free tier
        void syncInstallation(accountId, { plan: 'free' })
        console.log(`[lifecycle] suscripcion cancelada -> free account=${accountId}`)
      } else {
        const plan = planFromSubscription(data.subscription)
        if (plan) {
          await setAccountPlan(accountId, plan)
          void syncInstallation(accountId, { plan })
          console.log(`[lifecycle] plan=${plan} account=${accountId}`)
        } else {
          console.warn(`[lifecycle] subscription sin plan_id reconocido:`, data.subscription?.plan_id)
        }
      }
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