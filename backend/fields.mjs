// Catálogo INTERNACIONAL de campos de factura (universal, cualquier país).
// Mapea 1:1 con el núcleo de EN 16931. [id, descripción EN con sinónimos por país].
export const FIELDS = [
  ['document_type',    'Document type and series/letter if present (e.g. "Invoice", "Tax Invoice", "Credit Note", "Receipt", "Factura A/B/C", "Nota de Crédito").'],
  ['invoice_number',   'Invoice / document number or folio. Labels vary: Invoice No., Inv #, Factura N°, Número, Comprobante, Rechnungsnummer, N° facture, Folio.'],
  ['issue_date',       'Issue / invoice date. Return as YYYY-MM-DD.'],
  ['due_date',         'Payment due date. Return as YYYY-MM-DD.'],
  ['currency',         'Currency as a 3-letter ISO 4217 code (USD, EUR, ARS, BRL, GBP, MXN...). If only a symbol appears, infer it from the country.'],
  ['supplier_name',    'Seller / supplier / vendor legal or trade name (the party ISSUING the invoice). "From", "Bill from", "Razón social", "Emisor".'],
  ['supplier_tax_id',  'Seller tax identification number, however it is labeled locally: VAT / VAT No / Tax ID / EIN / CUIT / RFC / NIF / CIF / ABN / GSTIN / UID / TIN. Return as printed.'],
  ['supplier_address', 'Seller/issuer address ONLY (street, city, postal code, country of the SELLER). Do NOT include any part of the buyer address.'],
  ['customer_name',    'Buyer / customer / "Bill to" name (the party BEING invoiced). "Cliente", "Receptor".'],
  ['customer_tax_id',  'Buyer tax identification number (same kinds as supplier_tax_id; may be a personal ID/DNI for individuals).'],
  ['customer_address', 'Buyer/recipient address ONLY. Do NOT include any part of the seller address.'],
  ['subtotal',         'Net amount before taxes (taxable base / subtotal / net / Neto gravado). Number with a dot decimal, no thousands separator (e.g. 1234.56), no currency symbol.'],
  ['tax_amount',       'Total tax amount (VAT / GST / IVA / sales tax). If several rates, return the total. Number with a dot decimal.'],
  ['total_amount',     'Grand total (total payable, taxes included). Number with a dot decimal.'],
  ['payment_terms',    'Payment terms / method / conditions (e.g. "Net 30", "Contado", "Cuenta corriente").'],
]

// ─── Capas de campos ESPECÍFICOS por país (opcionales) ───────────────────────
// Se agregan al esquema SOLO si el tablero configuró ese país. Van APARTE de los
// universales. Sistema de capas: agregar un país nuevo = sumar una entrada acá.
// Los IDs van prefijados con el código de país para no colisionar.
export const COUNTRY_FIELDS = {
  AR: [
    ['ar_tipo_comprobante', 'Argentine voucher type with its letter/code as printed (e.g. "Factura A", "Nota de Crédito B", "Factura C", "FCE MiPyME A"). Comprobante AFIP.'],
    ['ar_punto_venta',      'Point of sale / punto de venta (usually 4-5 digits, e.g. 0001, 00003). Keep leading zeros — return as text.'],
    ['ar_cae',              'CAE or CAI — the long electronic authorization number (usually 14 digits) near the bottom of the invoice. Labeled "CAE N°", "CAI". Return exactly as printed.'],
    ['ar_cae_vto',          'CAE/CAI expiration date (Fecha de Vto. de CAE / Vencimiento del CAE). Return as YYYY-MM-DD.'],
    ['ar_condicion_iva',          'ISSUER / supplier VAT condition — condición frente al IVA del EMISOR (e.g. "Responsable Inscripto", "Monotributo", "IVA Exento").'],
    ['ar_condicion_iva_receptor', 'BUYER / recipient VAT condition — condición frente al IVA del RECEPTOR/cliente (e.g. "Consumidor Final", "Responsable Inscripto", "Monotributo", "Exento", "IVA no alcanzado").'],
    ['ar_otros_tributos',         'Other taxes total — "Importe Otros Tributos": the sum of perceptions (IIBB/gross income, VAT, income tax) and internal taxes, shown as a line separate from VAT. Numeric value with a dot decimal, NO thousands separator, NO currency symbol. Return "" if the invoice has no such line.'],
  ],
  CL: [
    ['cl_tipo_dte',           'Chilean DTE type as printed (e.g. "Factura Electrónica", "Factura Exenta Electrónica", "Boleta Electrónica", "Nota de Crédito Electrónica"), with its SII code (33, 34, 39, 61…) if shown.'],
    ['cl_giro_emisor',        'Issuer business activity — "Giro" of the seller (e.g. "Instalación y fabricación de ventanas y puertas").'],
    ['cl_impuesto_adicional', 'Additional/specific tax — "Impuesto Adicional" (e.g. ILA on alcohol, luxury goods, fuel), shown as a line separate from IVA. Numeric value with a dot decimal, NO thousands separator, NO currency symbol. Return "" if not present.'],
    ['cl_monto_exento',       'Exempt amount — "Monto Exento" (exempt taxable base, separate from the affected net amount). Numeric value with a dot decimal, NO thousands separator, NO currency symbol. Return "" if not present.'],
  ],
  UY: [
    ['uy_tipo_cfe',          'Uruguayan CFE type as printed (e.g. "e-Factura", "e-Ticket", "e-Factura Nota de Crédito"), with its DGI code (111, 101, 112…) if shown.'],
    ['uy_serie',             'CFE series letter — "Serie" (e.g. "A", "B"). Just the series letter, separate from the number.'],
    ['uy_cae',               'CAE number — "Nº CAE / Constancia de Autorización de Emisión" issued by DGI (a long number). Return exactly as printed.'],
    ['uy_cae_vto',           'CAE expiration date — the "Fecha de Vencimiento" of the CAE (shown near the CAE number). Return as YYYY-MM-DD.'],
    ['uy_codigo_seguridad',  'Security code — "Código de seguridad" of the CFE (a short alphanumeric code). Return exactly as printed.'],
  ],
  MX: [
    ['mx_folio_fiscal',     'Fiscal folio / UUID — "Folio Fiscal" (a 36-character UUID: 32 hex digits in 5 groups separated by hyphens) assigned by the SAT. Return exactly as printed, every character.'],
    ['mx_uso_cfdi',         'CFDI use — "Uso del CFDI" / "UsoCFDI" code (e.g. "G01", "G03", "P01") with its description if shown.'],
    ['mx_regimen_fiscal',   'Issuer tax regime — "Régimen Fiscal" of the emisor (e.g. "601 General de Ley Personas Morales", "626 RESICO").'],
    ['mx_metodo_pago',      'Payment method — "Método de Pago": "PUE" (pago en una sola exhibición) or "PPD" (pago en parcialidades o diferido).'],
    ['mx_forma_pago',       'Payment form — "Forma de Pago" SAT code (e.g. "01 Efectivo", "03 Transferencia", "04 Tarjeta de crédito").'],
    ['mx_tipo_comprobante', 'CFDI type — "Tipo de Comprobante": I (Ingreso), E (Egreso), P (Pago), N (Nómina) or T (Traslado).'],
  ],
  BR: [
    ['br_chave_acesso',      'Access key — "Chave de Acesso" of the NF-e (a 44-digit number). Return exactly as printed, all 44 digits.'],
    ['br_serie',             'NF-e series — "Série" (separate from the number).'],
    ['br_natureza_operacao', 'Nature of the operation — "Natureza da Operação" (e.g. "Venda", "Remessa", "Devolução").'],
    ['br_protocolo',         'Authorization protocol — "Protocolo de Autorização" issued by SEFAZ (number, optionally with date/time). Return as printed.'],
    ['br_icms',              'ICMS tax amount — total "Valor do ICMS". Numeric value with a dot decimal, NO thousands separator, NO currency symbol. Return "" if not present.'],
    ['br_ipi',               'IPI tax amount — total "Valor do IPI". Numeric value with a dot decimal, NO thousands separator, NO currency symbol. Return "" if not present.'],
  ],
  CO: [
    ['co_cufe',             'CUFE — "Código Único de Factura Electrónica" (a ~96-character alphanumeric code / SHA hash) assigned by DIAN. Return exactly as printed, every character.'],
    ['co_resolucion_dian',  'DIAN numbering authorization — "Resolución DIAN" number, with authorized range/validity if shown.'],
    ['co_medio_pago',       'Payment means — "Medio de Pago" (e.g. "Efectivo", "Transferencia", "Tarjeta"), distinct from the payment condition (contado/crédito).'],
  ],
  PE: [
    ['pe_tipo_comprobante', 'SUNAT document type — "Tipo de Comprobante" code (01 Factura, 03 Boleta de Venta, 07 Nota de Crédito, 08 Nota de Débito) with its name if shown.'],
    ['pe_serie',            'Voucher series — "Serie" (4 alphanumeric characters, starting with F for facturas or B for boletas, e.g. "F001"). Separate from the correlative number.'],
    ['pe_codigo_hash',      'Security digest — the "Código Hash / Resumen" of the CPE (shown near the SUNAT barcode). Return exactly as printed.'],
  ],
  EC: [
    ['ec_clave_acceso',        'Access key — "Clave de Acceso" of the SRI electronic voucher (a 49-digit number). Return exactly as printed, all 49 digits.'],
    ['ec_numero_autorizacion', 'SRI authorization number — "Número de Autorización" (often identical to the 49-digit clave de acceso). Return exactly as printed.'],
    ['ec_ambiente',            'Environment — "Ambiente" of the voucher: "Producción" or "Pruebas".'],
    ['ec_tipo_emision',        'Emission type — "Tipo de Emisión" (e.g. "Normal", "Contingencia").'],
  ],
}

// Universales + capas de los países configurados (sin duplicar IDs). Orden estable.
export function fieldsForCountries(countries = []) {
  const seen = new Set(FIELDS.map(([id]) => id))
  const extra = []
  for (const c of (countries || [])) {
    for (const f of (COUNTRY_FIELDS[c] || [])) {
      if (!seen.has(f[0])) { seen.add(f[0]); extra.push(f) }
    }
  }
  return [...FIELDS, ...extra]
}

// Campos que se escriben como número en columnas numéricas de Monday.
export const NUMERIC_FIELDS = new Set(['subtotal', 'tax_amount', 'total_amount', 'ar_otros_tributos', 'cl_impuesto_adicional', 'cl_monto_exento', 'br_icms', 'br_ipi'])

// Campos que son fechas (Claude ya las devuelve YYYY-MM-DD; se escriben en columnas date).
export const DATE_FIELDS = new Set(['issue_date', 'due_date', 'ar_cae_vto', 'uy_cae_vto'])