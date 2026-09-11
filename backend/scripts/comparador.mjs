// comparador.mjs — Compara lo que leyó el modelo contra la verdad, según el
// TIPO de dato. Separado del script para poder testearlo sin gastar API.

// ── Comparación POR TIPO DE DATO ───────────────────────────────────────────────
// Comparar todo igual da falsos resultados en las dos direcciones:
//   - como número, "30-63722002-7" parsea como 30 y dos CUIT distintos que
//     empiezan igual darían "acierto";
//   - como texto, "1756.320" no es igual a "1756.32", siendo el mismo importe.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
const digitos = (s) => String(s ?? '').replace(/\D/g, '')
const num = (v) => {
  const t = String(v ?? '').trim()
  if (!t) return null
  const n = Number(t.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Códigos: se comparan dígito por dígito (el formato con o sin guiones no importa).
const IDS = new Set(['supplier_tax_id', 'customer_tax_id', 'ar_transportista_cuit', 'ar_cae', 'ar_cot'])
// Número de comprobante: cada tramo como entero, así 0001-00000902 == 00001-00000902
// (mismo comprobante, distinto ancho del punto de venta) pero 0003-00004844 no es
// igual a 00031-00004844 (otro punto de venta).
const NUMEROS = new Set(['invoice_number', 'ar_comprobante_asociado'])
const ENTEROS = new Set(['ar_punto_venta', 'ar_bultos'])
const TEXTOS = new Set(['customer_name', 'supplier_name', 'ar_domicilio_entrega', 'ar_transportista', 'ar_orden_compra'])

export function acierta(campo, esperado, obtenido) {
  const eVacio = norm(esperado) === '', oVacio = norm(obtenido) === ''
  if (eVacio || oVacio) return eVacio && oVacio // vacío solo acierta contra vacío
  if (IDS.has(campo)) return digitos(esperado) === digitos(obtenido)
  if (NUMEROS.has(campo)) {
    const a = String(esperado).split(/\D+/).filter(Boolean), b = String(obtenido).split(/\D+/).filter(Boolean)
    if (a.length > 1 && b.length > 1) return a.length === b.length && a.every((x, i) => Number(x) === Number(b[i]))
    return digitos(esperado) === digitos(obtenido)
  }
  if (ENTEROS.has(campo)) return Number(digitos(esperado)) === Number(digitos(obtenido))
  if (TEXTOS.has(campo)) { const a = norm(esperado), b = norm(obtenido); return a === b || b.includes(a) }
  const a = num(esperado), b = num(obtenido)
  if (a !== null && b !== null) return Math.abs(a - b) < 0.01
  return norm(esperado) === norm(obtenido)
}

