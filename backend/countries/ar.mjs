// countries/ar.mjs — Pack de Argentina (AFIP/ARCA).
// Estrategia 99%: el QR de AFIP trae los datos fiscales EXACTOS (CUIT, punto de
// venta, tipo, número, fecha, total, CAE) → los pisamos sobre lo que sacó el LLM
// (ground truth). El LLM queda solo para lo semántico (nombres, domicilios,
// renglones, condición IVA, subtotal/IVA). Todo determinístico y sin costo extra.

// ── Códigos AFIP de tipo de comprobante → [base, letra] ──
const TIPO = {
  1: ['Factura', 'A'], 2: ['Nota de Débito', 'A'], 3: ['Nota de Crédito', 'A'],
  6: ['Factura', 'B'], 7: ['Nota de Débito', 'B'], 8: ['Nota de Crédito', 'B'],
  11: ['Factura', 'C'], 12: ['Nota de Débito', 'C'], 13: ['Nota de Crédito', 'C'],
  17: ['Liquidación Serv. Públicos', 'A'], 18: ['Liquidación Serv. Públicos', 'B'],
  19: ['Factura', 'E'], 20: ['Nota de Débito', 'E'], 21: ['Nota de Crédito', 'E'], 22: ['Factura', 'E'],
  51: ['Factura', 'M'], 52: ['Nota de Débito', 'M'], 53: ['Nota de Crédito', 'M'],
  81: ['Tique Factura', 'A'], 82: ['Tique Factura', 'B'], 83: ['Tique', ''],
  201: ['Factura de Crédito MiPyME', 'A'], 202: ['Nota de Débito MiPyME', 'A'], 203: ['Nota de Crédito MiPyME', 'A'],
  206: ['Factura de Crédito MiPyME', 'B'], 207: ['Nota de Débito MiPyME', 'B'], 208: ['Nota de Crédito MiPyME', 'B'],
  211: ['Factura de Crédito MiPyME', 'C'], 212: ['Nota de Débito MiPyME', 'C'], 213: ['Nota de Crédito MiPyME', 'C'],
}
const classOf = (base) => (base.includes('Crédito') ? 'credit_note' : base.includes('Débito') ? 'debit_note' : 'invoice')

// 11 dígitos → XX-XXXXXXXX-X
const fmtCuit = (n) => { const s = String(n).replace(/\D/g, '').padStart(11, '0'); return `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` }
// Receptor según tipo de documento AFIP (80=CUIT, 86=CUIL, 96=DNI, 99=cons. final)
const fmtReceptor = (tipoDoc, nro) => {
  if (!nro || tipoDoc === 99) return ''
  return (tipoDoc === 80 || tipoDoc === 86) ? fmtCuit(nro) : String(nro)
}
// N° de comprobante: PtoVenta - Número(8) → 0090-00434782.
const invNum = (pv, nro, ancho = 4) => `${String(pv).padStart(ancho, '0')}-${String(nro).padStart(8, '0')}`

// El QR trae el punto de venta como NÚMERO y no dice con cuántos dígitos está
// impreso. La especificación de ARCA admite hasta 5, y hay proveedores que imprimen
// 5 (Potenza: "00003-00042742"). Forzar 4 dejaba el número distinto del papel.
// Si lo que leyó la IA vale lo mismo que el del QR, le creemos el ancho impreso.
const anchoPtoVta = (data, real) => {
  const leido = String(data.ar_punto_venta || '').replace(/\D/g, '') ||
    String(data.invoice_number || '').split('-')[0].replace(/\D/g, '')
  const ok = leido && Number(leido) === Number(real) && leido.length >= 4 && leido.length <= 5
  return ok ? leido.length : 4
}

// Validación del dígito verificador del CUIT (módulo 11). Para chequear datos del LLM.
export function cuitValido(cuit) {
  const s = String(cuit).replace(/\D/g, '')
  if (s.length !== 11) return false
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = w.reduce((a, d, i) => a + d * Number(s[i]), 0)
  let dv = 11 - (sum % 11); if (dv === 11) dv = 0; if (dv === 10) dv = 9
  return dv === Number(s[10])
}

// Parsea el contenido del QR de AFIP (URL con ?p=<base64(JSON)>). null si no es AFIP.
function parseAfip(raw) {
  if (!raw) return null
  const m = raw.match(/[?&]p=([A-Za-z0-9+/=_-]+)/)
  if (!m) return null
  try {
    const j = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return (j && j.cuit && j.codAut) ? j : null
  } catch { return null }
}

// Pisa los campos fiscales de `data` con los del QR (exactos). Devuelve el detalle.
function applyQr(data, q) {
  const [base, letra] = TIPO[q.tipoCmp] || ['Comprobante', '']
  const name = letra ? `${base} ${letra}` : base
  data.supplier_tax_id = fmtCuit(q.cuit)
  const rec = fmtReceptor(q.tipoDocRec, q.nroDocRec); if (rec) data.customer_tax_id = rec
  if (q.fecha) data.issue_date = q.fecha
  data.currency = ({ PES: 'ARS', DOL: 'USD' })[q.moneda] || data.currency || 'ARS'
  data.total_amount = String(q.importe)
  const ancho = anchoPtoVta(data, q.ptoVta)
  data.invoice_number = invNum(q.ptoVta, q.nroCmp, ancho)
  data.document_type = name
  data.document_class = classOf(base)
  data.ar_cae = String(q.codAut)
  data.ar_punto_venta = String(q.ptoVta).padStart(ancho, '0')
  data.ar_tipo_comprobante = name
  return { cuit: data.supplier_tax_id, nro: data.invoice_number, total: data.total_amount, cae: data.ar_cae }
}

// Parsea un importe "1234.56" (string del LLM) → número. 0 si vacío/ilegible.
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0 }

// Control aritmético: la suma del desglose (netos + IVA + percepciones + otros)
// tiene que dar el total. Con QR el total es EXACTO, así que sirve de checksum del
// desglose que sacó el LLM. No corrige nada (no sabemos cuál campo está mal), solo
// avisa para poder marcar la lectura. Devuelve { ok, diff, sum, total } o null.
function checkArithmetic(data) {
  const total = num(data.total_amount)
  if (!total) return null
  const ivaParts = num(data.ar_iva_21) + num(data.ar_iva_105) + num(data.ar_iva_27)
  // tax_amount ES el IVA total de la factura, así que nunca puede quedar por debajo de
  // la suma de las alícuotas que conocemos (21/10,5/27). Si hay una alícuota que no
  // desglosamos (ej. IVA 5%), quedarnos solo con las partes daba un falso "no cierra".
  const iva = Math.max(ivaParts, num(data.tax_amount))
  const sum = num(data.subtotal) + num(data.ar_neto_no_gravado) + num(data.ar_exento) + iva +
    num(data.ar_percepcion_iva) + num(data.ar_percepcion_iibb) + num(data.ar_percepcion_ganancias) +
    num(data.ar_impuestos_internos) + num(data.ar_otros_tributos)
  const diff = Math.round((sum - total) * 100) / 100
  const ok = Math.abs(diff) <= Math.max(1, total * 0.005) // tolerancia: $1 o 0,5% del total
  return { ok, diff, sum: Math.round(sum * 100) / 100, total }
}

// enrich: recibe el QR ya decodificado (ctx.qr) y pisa los campos fiscales con el
// dato exacto de AFIP. Best-effort (no lanza). ctx = { fileBase64, mediaType, qr }.
export async function enrich(data, ctx = {}) {
  const qr = parseAfip(ctx.qr)
  let source = 'llm'
  const warnings = []
  if (qr) {
    const fixed = applyQr(data, qr)
    console.log('[AR] QR AFIP aplicado:', JSON.stringify(fixed))
    source = 'qr'
  }
  // Sanidad del CAE. Del QR siempre viene bien; leído por la IA de la imagen se le
  // puede escapar un dígito (caso real reportado). AFIP usa 14 dígitos: si no son
  // 14, el dato está mal y hay que avisar en vez de dejarlo pasar en silencio.
  const cae = String(data.ar_cae || '').replace(/\D/g, '')
  if (cae && cae.length !== 14) {
    console.warn(`[AR] ⚠️ CAE con ${cae.length} dígitos (deberían ser 14): "${data.ar_cae}" — fuente: ${source}`)
    warnings.push({ key: 'warnCae', vars: { cae: data.ar_cae, n: cae.length } })
  }
  // Dígito verificador del CUIT. Los últimos 11 dígitos de un CUIT no son libres: el
  // último sale de una cuenta con los otros diez. Si no cierra, el número NO existe —
  // no hay interpretación posible, está mal leído. Pasa sobre todo en escaneos, donde
  // el renglón del CUIT es la línea más chica y clara del papel (3 casos reales en
  // 174 facturas auditadas, sin un solo falso positivo).
  // No lo corregimos (no sabemos cuál dígito falló): avisamos, que hoy entra en
  // silencio. Del QR siempre viene bien, así que esto solo dispara en lo que leyó la IA.
  // OJO: el receptor puede estar identificado con DNI/CUIL y no con CUIT (tipos de
  // documento 96/86 de ARCA), así que solo validamos cuando tiene 11 dígitos.
  for (const campo of ['supplier_tax_id', 'customer_tax_id']) {
    const v = data[campo]
    if (!v || String(v).replace(/\D/g, '').length !== 11) continue
    if (cuitValido(v)) continue
    const quien = campo === 'supplier_tax_id' ? 'emisor' : 'receptor'
    console.warn(`[AR] ⚠️ CUIT del ${quien} inválido (dígito verificador): "${v}" — fuente: ${source}`)
    warnings.push({ key: 'warnCuit', vars: { cuit: v, quien } })
  }
  // Checksum del desglose de impuestos contra el total (exacto si vino del QR).
  const control = checkArithmetic(data)
  if (control && !control.ok) {
    console.warn(`[AR] ⚠️ el desglose de impuestos NO cierra: suma=${control.sum} vs total=${control.total} (dif ${control.diff}) — revisar`)
    warnings.push({ key: 'warnSum', vars: { sum: control.sum, total: control.total, diff: control.diff } })
  }
  return { source, control, warnings }
}

// Prompt específico de Argentina (se inyecta solo si el tablero eligió AR).
// El QR ya resuelve el header fiscal; acá guiamos lo SEMÁNTICO donde el LLM falla.
export const prompt =
`ARGENTINA (AFIP/ARCA) — guía para leer comprobantes argentinos. REGLA DE ORO: extraé
SOLO lo IMPRESO. Si un importe o dato NO aparece impreso, devolvé "" (vacío) — NUNCA 0,
NUNCA un valor inferido ni calculado por vos.

1) TIPO Y LETRA. Factura / Nota de Crédito / Nota de Débito + letra A, B, C, M o E (o
"FCE MiPyME", "Liquidación de Servicios Públicos", "Tique Factura"). Regla: A = IVA
discriminado; B = IVA incluido (no se discrimina); C = sin IVA (monotributo/exento);
E = exportación (exento). document_class: "invoice" (Factura/Liquidación/Tique Factura),
"credit_note" (Nota de Crédito), "debit_note" (Nota de Débito). Remito, presupuesto u
orden de compra → "other".

2) NOTAS DE CRÉDITO Y DÉBITO. Toda NC/ND lleva un bloque "Comprobantes Asociados"
(a veces "Comprobante Asociado" o "Documentos Asociados") con la factura que corrige:
tipo, punto de venta, número y a veces fecha y CUIT. En ar_comprobante_asociado poné
SOLO el número, con el formato 0000-00000000 (punto de venta 4 dígitos + número 8).
Ejemplo: si dice "Factura A 0032-00002468" o "Tipo 01 Pto.Vta 32 Nro 2468", devolvés
"0032-00002468". Si lista varios, separalos con ", ". En una factura común va "".
Los IMPORTES de una NC/ND se leen tal cual están impresos, en positivo — no les
cambies el signo.

3) EMISOR vs RECEPTOR. Separalos SIEMPRE (razón social, CUIT, domicilio). El que EMITE
→ supplier_*; el cliente → customer_*. Nunca los mezcles.

4) DOS CONDICIONES IVA. ar_condicion_iva = la del EMISOR; ar_condicion_iva_receptor =
la del CLIENTE ("Responsable Inscripto", "Monotributo", "Consumidor Final", "IVA
Exento"…). No las intercambies.

5) ENCABEZADO (solo si está impreso). ar_periodo_desde / ar_periodo_hasta = "Período
Facturado Desde/Hasta" (aparece en facturas de servicios; YYYY-MM-DD). ar_cotizacion =
"Cotización" / "Tipo de cambio", SOLO si la factura está en moneda extranjera
(ej. "1 USD = 1350" → 1350).

6) BASES. subtotal = "Neto Gravado". ar_neto_no_gravado = "Neto No Gravado". ar_exento
= "Importe Exento" / "Op. Exentas".

7) IVA DISCRIMINADO (solo Factura A/M), cada uno SOLO su tasa: ar_iva_21 = "IVA 21%",
ar_iva_105 = "IVA 10,5%", ar_iva_27 = "IVA 27%" ("" si esa línea no aparece). tax_amount
= IVA TOTAL (suma de todas, incluidas 5%/2,5% si aparecen).
   • Factura B: el IVA va INCLUIDO en el precio → tax_amount y ar_iva_* VACÍOS (no 0).
   • Factura C (Monotributo/Exento): NO hay IVA → tax_amount y ar_iva_* VACÍOS (no 0).
   • Factura E (exportación): es EXENTA de IVA. El total va SOLO en total_amount; NO lo
     pongas en ar_exento. ar_exento se completa únicamente si hay una línea impresa
     "Importe Exento" con su propio monto.

8) OTROS TRIBUTOS / PERCEPCIONES (sección aparte del IVA), cada importe en UN campo, sin
repetir: ar_percepcion_iva = "Percepción IVA"; ar_percepcion_iibb = "Percepción IIBB /
Ingresos Brutos" (sumá si hay varias provincias: ARBA, AGIP…); ar_percepcion_ganancias =
"Percepción Ganancias"; ar_impuestos_internos = "Impuestos Internos"; ar_otros_tributos =
SOLO el resto (tasas municipales, etc.). ⚠️ Una "Percepción de IVA" NO es IVA — va en su campo.

9) CONTROL: Neto Gravado + Neto No Gravado + Exento + IVA total + Perc. IVA + Perc. IIBB
+ Perc. Ganancias + Imp. Internos + Otros = Total. Usalo para ubicar bien cada importe.

10) AUTORIZACIÓN. ar_cae = el código largo de autorización, esté rotulado "CAE N°",
"CAI N°" o "CAEA" (14 dígitos). ar_cae_vto = "Vto. de CAE" / "Fecha de Vencimiento"
(YYYY-MM-DD). ⚠️ El vencimiento SOLO si está impreso: NO lo calcules sumándole días a
la fecha de emisión.

11) NÚMERO DE COMPROBANTE. Son dos partes: punto de venta + número correlativo.
El punto de venta tiene HASTA 5 dígitos según la especificación de ARCA — copiá la
cantidad de dígitos TAL COMO ESTÁ IMPRESA, no la lleves a 4. El número correlativo va
con 8 dígitos, completando con ceros a la izquierda si vienen menos.
   • "0090-00434782"      → invoice_number "0090-00434782",  ar_punto_venta "0090"
   • "00003-00042742"     → invoice_number "00003-00042742", ar_punto_venta "00003"
   • "N° 0007 - 1438"     → invoice_number "0007-00001438",  ar_punto_venta "0007"
   • "0003R00188890"      → invoice_number "0003-00188890",  ar_punto_venta "0003"
NUNCA devuelvas el número sin su punto de venta.

12) IMPORTES: punto = miles, coma = decimal ("744.098,80" → 744098.80).

13) FECHAS. En Argentina se imprimen DD/MM/AAAA: el PRIMER número es el DÍA.
"02/09/2026" es el 2 de septiembre de 2026 → 2026-09-02. NUNCA el 9 de febrero.
Vale para fecha de emisión, vencimiento, Vto. de CAE y período facturado.
Devolvelas siempre como YYYY-MM-DD.

<ejemplos>
1) Factura A: Neto Gravado 100000 | IVA 21% 21000 | Perc. IIBB 3000 | TOTAL 124000
   → subtotal 100000, ar_iva_21 21000, tax_amount 21000, ar_percepcion_iibb 3000,
     ar_iva_105 "", ar_iva_27 "", ar_exento "", ar_neto_no_gravado "", total_amount 124000.
2) Factura C (Monotributo): Reparación 45000 | TOTAL 45000 (SIN IVA)
   → subtotal 45000, tax_amount "", ar_iva_21 "", ar_percepcion_iibb "", total_amount 45000.
3) Factura E (exportación, USD, Cotización 1350): 500 x USD 20 | TOTAL USD 10000 (EXENTA)
   → currency USD, subtotal 10000, tax_amount "", ar_exento "", ar_cotizacion 1350,
     total_amount 10000.
4) Nota de Crédito A, con bloque "Comprobantes Asociados: Factura A - Pto.Vta 0032 -
   Nro 00002468": Devolución 16000 | IVA 21% 3360 | TOTAL 19360
   → document_type "Nota de Crédito A", document_class "credit_note",
     ar_comprobante_asociado "0032-00002468", subtotal 16000, ar_iva_21 3360,
     total_amount 19360 (POSITIVO, como está impreso).
5) Factura A común, SIN bloque de comprobantes asociados
   → ar_comprobante_asociado "" (vacío: no lo inventes ni copies el número propio).
</ejemplos>`

export default { code: 'AR', name: 'Argentina', prompt, enrich, cuitValido }
