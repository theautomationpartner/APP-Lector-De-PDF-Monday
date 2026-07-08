// Planes de la app (feature-based / límite de facturas por mes).
// Modelo elegido en Monday: feature-based con usage limits (el valor está en las
// facturas, no en los asientos). `limit` = facturas/mes; `null` = ilimitado.
// El enforcement vive en server.mjs; el plan de cada cuenta en installations.plan.
export const PLANS = {
  free:       { limit: 10,   label: 'Free' },
  starter:    { limit: 50,   label: 'Starter' },
  pro:        { limit: 200,  label: 'Pro' },
  business:   { limit: 500,  label: 'Business' },
  enterprise: { limit: null, label: 'Enterprise' }, // ilimitado (fair-use)
}

export const PLAN_IDS = Object.keys(PLANS)

// Límite del plan (facturas/mes). null = ilimitado. Cae al plan `fallback` si el
// id no existe (defensivo ante datos viejos/typos en la DB).
export function planLimit(planId, fallback = 'free') {
  const p = PLANS[planId] || PLANS[fallback] || PLANS.free
  return p.limit
}

export function planLabel(planId, fallback = 'free') {
  return (PLANS[planId] || PLANS[fallback] || PLANS.free).label
}
