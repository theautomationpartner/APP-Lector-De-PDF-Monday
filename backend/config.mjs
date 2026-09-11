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
  // Sonnet desde el 11/09/2026: en el banco de 19 comprobantes leyó 99,3% contra 92,8%
  // de Haiku, y los errores de Haiku eran de vista (dígitos térmicos), no de prompt.
  // Cuesta ~2,4x. Volver a Haiku = MODEL=claude-haiku-4-5 en el .env, sin tocar código.
  model: process.env.MODEL || 'claude-sonnet-5',
  // Plan por defecto para cuentas sin plan explícito en la DB. Durante la beta se
  // puede poner 'enterprise' para no limitar a nadie; en producción → 'free'.
  defaultPlan: process.env.DEFAULT_PLAN || 'free',
  // Corta-loops (circuit breaker): topes DUROS por ventana corta que aplican a
  // TODOS los planes, incluso Enterprise/ilimitado. Frenan una automatización en
  // bucle antes de gastar IA. 0 = desactivar.
  guardSameItem: Number(process.env.GUARD_SAME_ITEM ?? 8),    // mismo item en 15 min
  guardPerHour:  Number(process.env.GUARD_PER_HOUR  ?? 600),  // lecturas/cuenta en 60 min

  // Cuántas lecturas se procesan A LA VEZ. El límite NO es la IA (aguanta de
  // sobra): es la RAM del droplet. Cada archivo vive en memoria como buffer,
  // como base64 (+33%) y otra vez dentro del cuerpo del request — así que N
  // lecturas en paralelo son ~N veces ese pico. Con 458 MB de RAM, disparar 7
  // ítems juntos mataba el proceso a mitad y los dejaba clavados en "Leyendo
  // Comprobante" (caso real 2026-09-10: 7 archivos, 22 MB en total, 13 reinicios).
  // Las que no entran ESPERAN su turno, no se pierden.
  maxConcurrentExtracts: Number(process.env.MAX_CONCURRENT_EXTRACTS ?? 2),
  // Tope de la fila de espera. Protege de que una ráfaga enorme acumule cientos
  // de requests abiertos. Al pasarse, la lectura falla con mensaje claro en vez
  // de colgarse para siempre.
  maxQueuedExtracts: Number(process.env.MAX_QUEUED_EXTRACTS ?? 40),

  // ── Secretos (solo se leen acá) ──
  databaseUrl: readEnv('DATABASE_URL', { secret: true }),
  anthropicApiKey: readEnv('ANTHROPIC_API_KEY', { secret: true }),
  mondaySigningSecret: readEnv('MONDAY_SIGNING_SECRET', { secret: true }), // JWT de recetas
  mondayClientSecret: readEnv('MONDAY_CLIENT_SECRET', { secret: true }),   // session token de la vista
  mondayClientId: process.env.MONDAY_CLIENT_ID || '', // público (domain ownership)
  // Token de NUESTRA cuenta de monday, para los tableros internos de ops
  // (instalaciones + facturas leídas). Opcional: sin él, el sync queda apagado.
  mondayInternalToken: process.env.MONDAY_INTERNAL_TOKEN || '',
}

export const isStaging = config.appEnv === 'staging'

// Secretos con los que Monday firma sus JWT (session token, JWT de recetas y
// eventos de lifecycle). Se prueban ambos porque según la superficie Monday
// firma con el Client Secret o con el Signing Secret.
export const mondaySecrets = [config.mondayClientSecret, config.mondaySigningSecret].filter(Boolean)
