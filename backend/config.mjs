// config.mjs — ÚNICO punto donde se leen las variables de entorno / secretos.
// Regla de la review de Monday: ningún `process.env` fuera de este archivo.
// Los secretos viven solo en el `.env` del servidor (permisos 600, fuera de git)
// y se acceden por estos getters. Este archivo es la captura de evidencia que
// pide el reviewer ("all secrets are read from environment variables").
// NUNCA loguear los valores — solo nombres / longitudes / IDs.
import 'dotenv/config'

// Marca qué secretos faltan al arrancar, sin imprimir el valor.
function readEnv(name, { secret = false } = {}) {
  const v = process.env[name] || ''
  if (!v) console.warn(`[config] variable de entorno ausente: ${name}`)
  else if (secret) console.log(`[config] ${name} = [SET] (len ${v.length})`)
  return v
}

export const config = {
  // ── No secretos ──
  port: Number(process.env.PORT) || 8080,
  appEnv: process.env.APP_ENV || 'production', // 'staging' gatea alertas externas
  appBaseUrl: process.env.APP_BASE_URL || '',
  model: process.env.MODEL || 'claude-haiku-4-5',
  // Plan por defecto para cuentas sin plan explícito en la DB. Durante la beta se
  // puede poner 'enterprise' para no limitar a nadie; en producción → 'free'.
  defaultPlan: process.env.DEFAULT_PLAN || 'free',

  // ── Secretos (solo se leen acá) ──
  databaseUrl: readEnv('DATABASE_URL', { secret: true }),
  anthropicApiKey: readEnv('ANTHROPIC_API_KEY', { secret: true }),
  mondaySigningSecret: readEnv('MONDAY_SIGNING_SECRET', { secret: true }), // JWT de recetas
  mondayClientSecret: readEnv('MONDAY_CLIENT_SECRET', { secret: true }),   // session token de la vista
  mondayClientId: process.env.MONDAY_CLIENT_ID || '', // público (domain ownership)
}

export const isStaging = config.appEnv === 'staging'

// Secretos con los que Monday firma sus JWT (session token, JWT de recetas y
// eventos de lifecycle). Se prueban ambos porque según la superficie Monday
// firma con el Client Secret o con el Signing Secret.
export const mondaySecrets = [config.mondayClientSecret, config.mondaySigningSecret].filter(Boolean)
