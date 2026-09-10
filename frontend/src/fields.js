import { makeT } from './i18n.js'

// Catálogo internacional de campos de factura (sirve para cualquier país).
// El backend usa este mismo set + sinónimos por país en el prompt de la IA.

// document_type se muestra junto al título de la factura (aparte).
export const ALL_FIELDS = [
  'document_type',
  'invoice_number', 'issue_date', 'due_date', 'currency',
  'supplier_name', 'supplier_tax_id', 'supplier_address',
  'customer_name', 'customer_tax_id', 'customer_address',
  'subtotal', 'tax_amount', 'total_amount',
  'payment_terms',
]

// Capas de campos ESPECÍFICOS por país (opcionales). Se muestran en el Mapeo solo
// si el tablero configuró ese país. Deben coincidir con backend/fields.mjs.
export const COUNTRY_FIELDS = {
  AR: ['ar_tipo_comprobante', 'ar_comprobante_asociado', 'ar_punto_venta', 'ar_cae', 'ar_cae_vto', 'ar_periodo_desde', 'ar_periodo_hasta', 'ar_cotizacion',
       'ar_condicion_iva', 'ar_condicion_iva_receptor',
       'ar_neto_no_gravado', 'ar_exento', 'ar_iva_21', 'ar_iva_105', 'ar_iva_27',
       'ar_percepcion_iva', 'ar_percepcion_iibb', 'ar_percepcion_ganancias', 'ar_impuestos_internos', 'ar_otros_tributos'],
  CL: ['cl_tipo_dte', 'cl_giro_emisor', 'cl_impuesto_adicional', 'cl_monto_exento'],
  UY: ['uy_tipo_cfe', 'uy_serie', 'uy_cae', 'uy_cae_vto', 'uy_codigo_seguridad'],
  MX: ['mx_folio_fiscal', 'mx_uso_cfdi', 'mx_regimen_fiscal', 'mx_metodo_pago', 'mx_forma_pago', 'mx_tipo_comprobante'],
  BR: ['br_chave_acesso', 'br_serie', 'br_natureza_operacao', 'br_protocolo', 'br_icms', 'br_ipi'],
  CO: ['co_cufe', 'co_resolucion_dian', 'co_medio_pago'],
  PE: ['pe_tipo_comprobante', 'pe_serie', 'pe_codigo_hash'],
  EC: ['ec_clave_acceso', 'ec_numero_autorizacion', 'ec_ambiente', 'ec_tipo_emision'],
}

// Universales + capas de los países seleccionados (sin duplicar).
export function fieldsForCountries(countries = [], kind = 'fiscal') {
  if (kind === 'remito') {
    const seen = new Set(ALL_FIELDS_REMITO)
    const extra = []
    for (const c of (countries || [])) for (const f of (COUNTRY_FIELDS_REMITO[c] || [])) if (!seen.has(f)) { seen.add(f); extra.push(f) }
    return [...ALL_FIELDS_REMITO, ...extra]
  }
  const extra = (countries || []).flatMap((c) => COUNTRY_FIELDS[c] || [])
  return [...ALL_FIELDS, ...extra.filter((f) => !ALL_FIELDS.includes(f))]
}

// ─── Layout del mapeo por país (Paso 2) ──────────────────────────────────────
// Dónde va cada campo específico del país DENTRO de la factura del mapeo, para que
// se vea como una factura real de ese país (y no una caja aparte). Zonas:
// header (encabezado), supplier (emisor), customer (receptor), totals (totales).
// Escalar un país = definir su layout acá. Sin layout → sus campos caen en un
// bloque genérico "extras" (backward-compatible, no rompe nada).
// ─── REMITOS ─────────────────────────────────────────────────────────────────
// Espejo de fields.mjs del backend. Un remito no es una factura sin importes:
// se va todo lo de plata y entra lo de logística y trazabilidad.
export const ALL_FIELDS_REMITO = [
  'document_type', 'invoice_number', 'issue_date',
  'supplier_name', 'supplier_tax_id', 'supplier_address',
  'customer_name', 'customer_tax_id', 'customer_address', 'payment_terms',
]
export const COUNTRY_FIELDS_REMITO = {
  // Un remito NO lleva letra A/B/C (es "R") ni condición de IVA: no hay impuesto
  // que discriminar. Y el N° interno de cliente del proveedor no le sirve a nadie
  // del lado del que recibe. Fuera, por pedido de contaduría.
  AR: ['ar_punto_venta', 'ar_cae', 'ar_cae_vto', 'ar_domicilio_entrega',
    'ar_transportista', 'ar_transportista_cuit', 'ar_bultos', 'ar_peso',
    'ar_valor_declarado', 'ar_orden_compra', 'ar_comprobante_asociado', 'ar_cot'],
}
export const COUNTRY_LAYOUT_REMITO = {
  AR: {
    header:   ['ar_punto_venta', 'ar_cae', 'ar_cae_vto', 'ar_orden_compra', 'ar_comprobante_asociado'],
    supplier: [],
    customer: [],
    entrega:  ['ar_domicilio_entrega', 'ar_transportista', 'ar_transportista_cuit', 'ar_bultos', 'ar_peso', 'ar_valor_declarado', 'ar_cot'],
  },
}
// Campos posibles a nivel RENGLÓN, por tipo de documento.
export const LINE_ITEM_FIELDS_BY_KIND = {
  fiscal: ['quantity', 'unit_price', 'bonificacion', 'subtotal', 'iva', 'total'],
  remito: ['quantity', 'unidad', 'codigo', 'lote', 'vto_partida', 'deposito', 'envases'],
}
export const DOC_KINDS = ['fiscal', 'remito']

export const COUNTRY_LAYOUT = {
  AR: {
    header:   ['ar_tipo_comprobante', 'ar_comprobante_asociado', 'ar_punto_venta', 'ar_cae', 'ar_cae_vto', 'ar_periodo_desde', 'ar_periodo_hasta', 'ar_cotizacion'],
    supplier: ['ar_condicion_iva'],
    customer: ['ar_condicion_iva_receptor'],
    totals:   ['ar_neto_no_gravado', 'ar_exento', 'ar_iva_21', 'ar_iva_105', 'ar_iva_27',
               'ar_percepcion_iva', 'ar_percepcion_iibb', 'ar_percepcion_ganancias', 'ar_impuestos_internos', 'ar_otros_tributos'],
  },
}

// Junta, para los países elegidos, los campos por zona + los "extras" (países sin
// layout definido). Los campos del país no cubiertos por el layout caen en totals.
export function countryZones(countries = []) {
  const zones = { header: [], supplier: [], customer: [], totals: [] }
  const extras = [] // [{ country, fields: [...] }] para países sin layout
  for (const c of (countries || [])) {
    const layout = COUNTRY_LAYOUT[c]
    if (layout) {
      for (const z of ['header', 'supplier', 'customer', 'totals']) {
        for (const f of (layout[z] || [])) zones[z].push(f)
      }
      const covered = new Set(Object.values(layout).flat())
      for (const f of (COUNTRY_FIELDS[c] || [])) if (!covered.has(f)) zones.totals.push(f)
    } else {
      const fs = COUNTRY_FIELDS[c] || []
      if (fs.length) extras.push({ country: c, fields: fs })
    }
  }
  return { zones, extras }
}

// ─── Capas (tiers) + grupos para el selector "¿Qué querés cargar?" ───────────
// Cada campo tiene una capa: basic (lo esencial), accounting (contable), full (todo).
// Los paquetes prenden una capa. Campos sin capa definida → 'accounting'.
export const FIELD_TIER = {
  document_type: 'basic', invoice_number: 'basic', issue_date: 'basic', due_date: 'full',
  currency: 'accounting', supplier_name: 'basic', supplier_tax_id: 'basic', supplier_address: 'full',
  customer_name: 'accounting', customer_tax_id: 'full', customer_address: 'full',
  subtotal: 'accounting', tax_amount: 'accounting', total_amount: 'basic', payment_terms: 'full',
  // Argentina
  ar_tipo_comprobante: 'accounting', ar_comprobante_asociado: 'accounting', ar_punto_venta: 'accounting', ar_cae: 'accounting', ar_cae_vto: 'full',
  ar_periodo_desde: 'full', ar_periodo_hasta: 'full', ar_cotizacion: 'full',
  ar_condicion_iva: 'accounting', ar_condicion_iva_receptor: 'full',
  ar_neto_no_gravado: 'full', ar_exento: 'full', ar_iva_21: 'full', ar_iva_105: 'full', ar_iva_27: 'full',
  ar_percepcion_iva: 'accounting', ar_percepcion_iibb: 'accounting', ar_percepcion_ganancias: 'accounting',
  ar_impuestos_internos: 'full', ar_otros_tributos: 'full',
}
const TIER_RANK = { basic: 0, accounting: 1, full: 2 }
export const tierOf = (field) => FIELD_TIER[field] || 'accounting'

// Campos activos según el paquete (tier) elegido + países. basic ⊂ accounting ⊂ full.
export function fieldsForTier(tier, countries = []) {
  const max = TIER_RANK[tier] ?? 2
  return fieldsForCountries(countries).filter((f) => TIER_RANK[tierOf(f)] <= max)
}

// Grupos del selector/preview, ordenados como una factura: Comprobante, Emisor,
// Receptor, Importes. Junta universales + campos del país en cada zona.
export function fieldGroups(countries = [], kind = 'fiscal') {
  if (kind === 'remito') {
    const z = { header: [], supplier: [], customer: [], entrega: [] }
    for (const c of (countries || [])) {
      const l = COUNTRY_LAYOUT_REMITO[c]
      if (!l) continue
      for (const k of Object.keys(z)) for (const f of (l[k] || [])) z[k].push(f)
    }
    return [
      { zone: 'header',   fields: ['document_type', 'invoice_number', 'issue_date', 'payment_terms', ...z.header] },
      { zone: 'supplier', fields: ['supplier_name', 'supplier_tax_id', 'supplier_address', ...z.supplier] },
      { zone: 'customer', fields: ['customer_name', 'customer_tax_id', 'customer_address', ...z.customer] },
      { zone: 'entrega',  fields: z.entrega },
    ]
  }
  const { zones } = countryZones(countries)
  const g = (zone, uni) => ({ zone, fields: [...uni, ...zones[zone]] })
  return [
    g('header',   ['document_type', 'invoice_number', 'issue_date', 'due_date', 'currency', 'payment_terms']),
    g('supplier', ['supplier_name', 'supplier_tax_id', 'supplier_address']),
    g('customer', ['customer_name', 'customer_tax_id', 'customer_address']),
    { zone: 'totals', fields: ['subtotal', 'tax_amount', ...zones.totals, 'total_amount'] },
  ]
}

// Campos posibles a nivel RENGLÓN (subítems). description = nombre del subítem.
export const LINE_ITEM_FIELDS = ['quantity', 'unit_price', 'bonificacion', 'subtotal', 'iva', 'total']

// Columnas que hay que crear/mapear para un set de campos: [{ field, type }].
// El tipo de columna de monday se deriva del campo (numbers / date / text).
export function neededColumns(fieldIds = []) {
  return fieldIds.map((f) => ({
    field: f,
    type: NUMERIC_FIELDS.includes(f) ? 'numbers'
      : DATE_FIELDS.includes(f) ? 'date'
      : DROPDOWN_FIELDS.includes(f) ? 'dropdown'
      : 'text',
  }))
}

// Campos con valores CERRADOS/fijos → columna dropdown (no texto): más prolijo,
// filtrable y con color. El backend crea las opciones al escribir (create_labels_if_missing).
export const DROPDOWN_FIELDS = ['document_type', 'ar_tipo_comprobante', 'currency', 'ar_condicion_iva', 'ar_condicion_iva_receptor']

// Listas curadas para los defaults (ISO). "" = auto-detect.
export const COUNTRIES = [
  'AR', 'AU', 'BR', 'CA', 'CL', 'CO', 'DE', 'EC', 'ES', 'FR', 'GB', 'IT', 'MX', 'PE', 'PT', 'US', 'UY',
]

// Países que se MUESTRAN en el selector (los que ya tienen pack validado al 99%).
// Escalar = agregar el ISO acá cuando su pack (QR/enrich del backend) esté listo.
// Los chips visibles = LAUNCH_COUNTRIES ∪ los ya guardados en el tablero (por si
// alguno configuró un país que todavía no está en la lista, que no desaparezca).
export const LAUNCH_COUNTRIES = ['AR']
export const CURRENCIES = [
  'USD', 'EUR', 'ARS', 'BRL', 'CAD', 'CLP', 'COP', 'GBP', 'MXN', 'AUD',
]

// ─── Plantilla: columnas que "Preparar mi tablero" crea (si faltan) ───────────
// Para tableros nuevos/vacíos. Name (título del ítem) va al emisor; Archivo y
// Estado se crean aparte en App.jsx. Lean: solo lo esencial.
export const TEMPLATE_COLUMNS = [
  { field: 'invoice_number',  type: 'text',    title: { en: 'Invoice #',        es: 'N° Factura' } },
  { field: 'document_type',   type: 'text',    title: { en: 'Type',             es: 'Tipo' } },
  { field: 'issue_date',      type: 'date',    title: { en: 'Issue date',       es: 'Fecha emisión' } },
  { field: 'due_date',        type: 'date',    title: { en: 'Due date',         es: 'Vencimiento' } },
  { field: 'supplier_tax_id', type: 'text',    title: { en: 'Supplier tax ID',  es: 'CUIT / Tax ID emisor' } },
  { field: 'currency',        type: 'text',    title: { en: 'Currency',         es: 'Moneda' } },
  { field: 'subtotal',        type: 'numbers', title: { en: 'Subtotal',         es: 'Subtotal' } },
  { field: 'tax_amount',      type: 'numbers', title: { en: 'Tax',              es: 'Impuestos' } },
  { field: 'total_amount',    type: 'numbers', title: { en: 'Total',            es: 'Total' } },
]

// ─── Auto-mapeo ───────────────────────────────────────────────────────────────
// Detecta qué columna del tablero corresponde a cada campo, por título (multi
// idioma) + tipo. Es best-effort: pre-mapea y el usuario revisa antes de guardar.

// Campos numéricos y de fecha (para chequear compatibilidad de tipo de columna).
export const NUMERIC_FIELDS = ['subtotal', 'tax_amount', 'total_amount', 'ar_peso', 'ar_valor_declarado', 'ar_bultos',
  'ar_neto_no_gravado', 'ar_exento', 'ar_iva_21', 'ar_iva_105', 'ar_iva_27',
  'ar_percepcion_iva', 'ar_percepcion_iibb', 'ar_percepcion_ganancias', 'ar_impuestos_internos', 'ar_otros_tributos',
  'ar_cotizacion', 'cl_impuesto_adicional', 'cl_monto_exento', 'br_icms', 'br_ipi']
export const DATE_FIELDS = ['issue_date', 'due_date', 'ar_cae_vto', 'vto_partida', 'ar_periodo_desde', 'ar_periodo_hasta', 'uy_cae_vto']

// Palabras clave por campo (EN + ES + variantes por país), ya normalizadas
// (minúsculas, sin acentos ni símbolos). Se busca que el título de la columna
// las CONTENGA. Orden = prioridad.
const FIELD_SYNONYMS = {
  invoice_number: ['invoicenumber', 'invoiceno', 'nrofactura', 'nrocomprobante', 'ncomprobante', 'nfactura', 'comprobante', 'invoice', 'factura', 'folio', 'numero'],
  document_type: ['documenttype', 'tipocomprobante', 'tipodocumento', 'tipo', 'type'],
  issue_date: ['issuedate', 'invoicedate', 'fechaemision', 'fechafactura', 'emision', 'fecha', 'date'],
  due_date: ['duedate', 'fechavencimiento', 'vencimiento', 'vto', 'payby'],
  currency: ['currency', 'moneda', 'divisa', 'curr'],
  supplier_name: ['suppliername', 'razonsocialemisor', 'proveedor', 'emisor', 'supplier', 'vendor', 'seller'],
  supplier_tax_id: ['suppliertaxid', 'cuitemisor', 'taxidemisor', 'taxid', 'vatnumber', 'cuit', 'rfc', 'nif', 'gstin', 'cnpj', 'ruc', 'ein', 'abn', 'vat'],
  supplier_address: ['supplieraddress', 'domicilioemisor', 'direccionemisor', 'domicilio', 'direccion', 'address'],
  customer_name: ['customername', 'razonsocialcliente', 'cliente', 'receptor', 'customer', 'buyer', 'billto'],
  customer_tax_id: ['customertaxid', 'cuitreceptor', 'taxidcliente', 'clienttaxid'],
  customer_address: ['customeraddress', 'domiciliocliente', 'direccioncliente'],
  subtotal: ['subtotal', 'importeneto', 'neto', 'net', 'base'],
  tax_amount: ['taxamount', 'impuestos', 'impuesto', 'iva', 'vat', 'gst', 'tax'],
  total_amount: ['totalamount', 'importetotal', 'totalapagar', 'grandtotal', 'total'],
  payment_terms: ['paymentterms', 'condiciondepago', 'condicionpago', 'condicionventa', 'terms', 'condicion'],
}

const norm = (s) => (s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')

// Tipos de columna de monday compatibles con cada clase de campo.
const isNumeric = (type) => type === 'numbers' || type === 'numeric'
const isDate = (type) => type === 'date'
const isTextLike = (type) => ['text', 'long-text', 'long_text', 'name', 'status', 'dropdown', 'color', 'email', 'phone'].includes(type)

function typeOk(fieldId, type) {
  if (NUMERIC_FIELDS.includes(fieldId)) return isNumeric(type)
  if (DATE_FIELDS.includes(fieldId)) return isDate(type)
  return isTextLike(type)
}

// Devuelve { fieldId: columnId } con las coincidencias encontradas. No repite
// columnas. Dos pasadas: primero palabras ESPECÍFICAS (compuestas, ≥6 letras)
// para que "Fecha de Vencimiento" caiga en due_date antes de que el genérico
// "fecha" de issue_date lo agarre; después las genéricas para lo que quedó.
// supplier_name cae al Name del ítem si no hay una columna mejor.
// Todos los campos conocidos de un tipo (todos los países), para reconocer una
// plantilla sin saber todavía qué país eligió el usuario.
function todosLosCampos(kind = 'fiscal') {
  const base = kind === 'remito' ? ALL_FIELDS_REMITO : ALL_FIELDS
  const capa = kind === 'remito' ? COUNTRY_FIELDS_REMITO : COUNTRY_FIELDS
  return [...new Set([...base, ...Object.values(capa).flat()])]
}

// Título canónico de cada campo = la etiqueta que muestra el mapeo. Es el contrato
// entre la app y las PLANTILLAS de tablero: al duplicar una plantilla los IDs de
// columna cambian, pero los títulos no. Por eso el mapeo se reconoce por título.
export function canonicalTitles(kind = 'fiscal') {
  const out = {}
  for (const lang of ['es', 'en']) {
    const t = makeT(lang)
    for (const f of todosLosCampos(kind)) {
      const label = t('field.' + f)
      if (label && label !== 'field.' + f) (out[norm(label)] ||= f)
    }
  }
  return out
}

// ─── Reconocer NUESTRA plantilla ─────────────────────────────────────────────
// El mapeo automático adivinando por parecido de nombres es peligroso: un sinónimo
// como "cliente" matchea con "Condición IVA cliente" y la app termina escribiendo
// la razón social adentro de la condición de IVA (pasó de verdad).
//
// Así que no adivinamos NUNCA. Solo hay dos estados:
//   · el tablero ES nuestra plantilla  → se mapea el 100%, con certeza
//   · cualquier otro tablero           → no se mapea nada, lo hace el usuario
//
// Para saber si es nuestra plantilla no miramos columna por columna sino el tablero
// ENTERO: una plantilla nuestra tiene TODOS los títulos canónicos. Que coincidan 40
// títulos exactos no es casualidad; que coincida uno, sí puede serlo.
export const MARCA_PLANTILLA = 'lector-pdf-ia:plantilla'

// Cuánto de nuestro catálogo tiene que estar presente para considerarlo plantilla.
// No pedimos el 100% porque el cliente puede haber borrado columnas que no usa
// (justamente lo que le decimos que haga) y aun así querer el resto mapeado.
const MINIMO_PLANTILLA = 0.8

export function esNuestraPlantilla(columns = [], kind = 'fiscal', descripcion = '') {
  // 1) La marca en la descripción del tablero: certeza, no heurística. Monday la
  //    copia al duplicar, así que sobrevive a "usar como plantilla".
  if (String(descripcion || '').includes(MARCA_PLANTILLA)) return true
  // 2) Sin marca (plantilla vieja, o monday no copió la descripción): que estén
  //    casi todos los CAMPOS. Dos detalles que importan:
  //    · se cuenta por CAMPO y no por título, porque cada campo tiene su título en
  //      los dos idiomas y el tablero trae uno solo;
  //    · se mide contra UN país por vez. Una plantilla argentina no tiene los campos
  //      de Chile ni de Uruguay, así que medirla contra el catálogo entero la
  //      dejaría siempre por debajo del umbral.
  const canon = canonicalTitles(kind)
  const titulos = new Set(columns.map((c) => norm(c.title)))
  const tiene = (f) => Object.entries(canon).some(([titulo, campo]) => campo === f && titulos.has(titulo))
  const capa = kind === 'remito' ? COUNTRY_FIELDS_REMITO : COUNTRY_FIELDS
  for (const pais of [null, ...Object.keys(capa)]) {
    const campos = fieldsForCountries(pais ? [pais] : [], kind)
    if (!campos.length) continue
    if (campos.filter(tiene).length / campos.length >= MINIMO_PLANTILLA) return true
  }
  return false
}

// ¿De qué TIPO es la plantilla? La marca lo dice ('...:plantilla:remito'); si no
// está, se deduce viendo contra cuál de los dos catálogos encajan más columnas.
// Sirve para que al instalar la app YA sepa si el tablero es de facturas o de
// remitos, sin preguntárselo al usuario.
export function tipoDePlantilla(columns = [], descripcion = '') {
  const d = String(descripcion || '')
  for (const k of DOC_KINDS) if (d.includes(MARCA_PLANTILLA + ':' + k)) return k
  const puntaje = (kind) => {
    if (!esNuestraPlantilla(columns, kind, '')) return -1
    const canon = canonicalTitles(kind)
    return columns.filter((c) => canon[norm(c.title)]).length
  }
  const [mejor] = DOC_KINDS.map((k) => [k, puntaje(k)]).sort((a, b) => b[1] - a[1])
  return mejor[1] > 0 ? mejor[0] : null
}

// ¿De qué PAÍS es la plantilla? Se deduce por sus columnas propias: una plantilla
// argentina tiene CAE, IVA 21% y percepciones, que ningún otro país tiene. Así el
// usuario no tiene que elegir el país de un tablero que ya es obviamente de ahí.
export function paisDePlantilla(columns = [], kind = 'fiscal') {
  const capa = kind === 'remito' ? COUNTRY_FIELDS_REMITO : COUNTRY_FIELDS
  const canon = canonicalTitles(kind)
  const titulos = new Set(columns.map((c) => norm(c.title)))
  const presentes = new Set()
  for (const [titulo, campo] of Object.entries(canon)) if (titulos.has(titulo)) presentes.add(campo)
  let mejor = null, max = 0
  for (const [pais, campos] of Object.entries(capa)) {
    const n = campos.filter((f) => presentes.has(f)).length
    // La mitad de los campos propios del país: suficiente para no confundirse con otro.
    if (n > max && n >= campos.length / 2) { max = n; mejor = pais }
  }
  return mejor
}

// ¿En qué idioma está escrita la plantilla? Se ve por los títulos de las columnas:
// si dicen "Fecha de emisión" es castellano, si dicen "Issue date" es inglés.
// Sirve para que la pantalla abra en el idioma del tablero y no en el default.
export function idiomaDePlantilla(columns = [], kind = 'fiscal') {
  const titulos = new Set(columns.map((c) => norm(c.title)))
  const campos = todosLosCampos(kind)
  const cuenta = (lang) => {
    const t = makeT(lang)
    return campos.filter((f) => {
      const l = t('field.' + f)
      return l && l !== 'field.' + f && titulos.has(norm(l))
    }).length
  }
  const es = cuenta('es'), en = cuenta('en')
  // Muchos títulos coinciden en los dos idiomas (Total, Subtotal): solo decidimos
  // cuando uno gana con claridad. Si empatan, no opinamos.
  if (es > en && es >= 5) return 'es'
  if (en > es && en >= 5) return 'en'
  return null
}

// Mapeo automático de los RENGLONES contra el tablero de subítems. Mismo criterio
// que el resto: título exacto, sin adivinar. description va al nombre del subítem.
export function autoMapLineItems(subColumns = [], kind = 'fiscal') {
  const t = [makeT('es'), makeT('en')]
  const out = { description: 'name' }
  const usados = new Set()
  for (const f of (LINE_ITEM_FIELDS_BY_KIND[kind] || [])) {
    const etiquetas = t.map((tt) => norm(tt('lineitems.' + f)))
    const hit = subColumns.find((c) => !usados.has(c.id) && etiquetas.includes(norm(c.title)))
    if (hit) { out[f] = hit.id; usados.add(hit.id) }
  }
  return out
}

// Mapeo automático. Devuelve {} salvo que el tablero sea nuestra plantilla.
// Cuando lo es, mapea por TÍTULO EXACTO: no hay interpretación posible.
export function autoMapColumns(columns = [], kind = 'fiscal', descripcion = '') {
  if (!esNuestraPlantilla(columns, kind, descripcion)) return {}
  const canon = canonicalTitles(kind)
  const mapping = {}
  const usados = new Set()
  for (const c of columns) {
    const f = canon[norm(c.title)]
    if (f && !mapping[f] && !usados.has(c.id) && typeOk(f, c.type)) { mapping[f] = c.id; usados.add(c.id) }
  }
  // El emisor va en el nombre del ítem cuando no tiene columna propia.
  if (!mapping.supplier_name) {
    const nameCol = columns.find((c) => c.type === 'name' && !usados.has(c.id))
    if (nameCol) mapping.supplier_name = nameCol.id
  }
  return mapping
}
