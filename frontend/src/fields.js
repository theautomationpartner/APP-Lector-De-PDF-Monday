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
  AR: ['ar_tipo_comprobante', 'ar_punto_venta', 'ar_cae', 'ar_cae_vto', 'ar_condicion_iva', 'ar_condicion_iva_receptor', 'ar_otros_tributos'],
  CL: ['cl_tipo_dte', 'cl_giro_emisor', 'cl_impuesto_adicional', 'cl_monto_exento'],
  UY: ['uy_tipo_cfe', 'uy_serie', 'uy_cae', 'uy_cae_vto', 'uy_codigo_seguridad'],
  MX: ['mx_folio_fiscal', 'mx_uso_cfdi', 'mx_regimen_fiscal', 'mx_metodo_pago', 'mx_forma_pago', 'mx_tipo_comprobante'],
  BR: ['br_chave_acesso', 'br_serie', 'br_natureza_operacao', 'br_protocolo', 'br_icms', 'br_ipi'],
  CO: ['co_cufe', 'co_resolucion_dian', 'co_medio_pago'],
  PE: ['pe_tipo_comprobante', 'pe_serie', 'pe_codigo_hash'],
}

// Universales + capas de los países seleccionados (sin duplicar).
export function fieldsForCountries(countries = []) {
  const extra = (countries || []).flatMap((c) => COUNTRY_FIELDS[c] || [])
  return [...ALL_FIELDS, ...extra.filter((f) => !ALL_FIELDS.includes(f))]
}

// Listas curadas para los defaults (ISO). "" = auto-detect.
export const COUNTRIES = [
  'AR', 'AU', 'BR', 'CA', 'CL', 'CO', 'DE', 'ES', 'FR', 'GB', 'IT', 'MX', 'PE', 'PT', 'US', 'UY',
]
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
export const NUMERIC_FIELDS = ['subtotal', 'tax_amount', 'total_amount', 'ar_otros_tributos', 'cl_impuesto_adicional', 'cl_monto_exento', 'br_icms', 'br_ipi']
export const DATE_FIELDS = ['issue_date', 'due_date', 'ar_cae_vto', 'uy_cae_vto']

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
export function autoMapColumns(columns = []) {
  const cols = columns.map((c) => ({ ...c, n: norm(c.title) }))
  const used = new Set()
  const mapping = {}

  const pass = (minLen) => {
    for (const fieldId of ALL_FIELDS) {
      if (mapping[fieldId]) continue
      for (const syn of (FIELD_SYNONYMS[fieldId] || [])) {
        if (syn.length < minLen) continue
        const hit = cols.find((c) => !used.has(c.id) && typeOk(fieldId, c.type) && c.n.includes(syn))
        if (hit) { mapping[fieldId] = hit.id; used.add(hit.id); break }
      }
    }
  }
  pass(6) // 1) palabras específicas
  pass(0) // 2) genéricas para lo que quedó libre

  // Fallback: razón social del emisor → columna Name del ítem si quedó libre.
  if (!mapping.supplier_name) {
    const nameCol = cols.find((c) => c.type === 'name' && !used.has(c.id))
    if (nameCol) { mapping.supplier_name = nameCol.id; used.add(nameCol.id) }
  }
  return mapping
}