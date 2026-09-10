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
    ['ar_comprobante_asociado', 'ONLY on a Nota de Crédito or Nota de Débito: the invoice it corrects, from the ' +
      '"Comprobantes Asociados" / "Comprobante Asociado" block. Return ONLY the document number formatted as ' +
      'PointOfSale(4)-Number(8), e.g. "0032-00002468" — not the type, not the date, not the CUIT. If several ' +
      'documents are listed, join them with ", ". Return "" on a regular invoice or if the block is not printed.'],
    ['ar_punto_venta',      'Point of sale / punto de venta (usually 4-5 digits, e.g. 0001, 00003). Keep leading zeros — return as text.'],
    ['ar_cae',              'CAE or CAI — the long electronic authorization number (usually 14 digits) near the bottom of the invoice. Labeled "CAE N°", "CAI". Return exactly as printed.'],
    ['ar_cae_vto',          'CAE/CAI expiration date (Fecha de Vto. de CAE / Vencimiento del CAE). Return as YYYY-MM-DD.'],
    ['ar_periodo_desde',    'Service period start — "Período Facturado Desde" (only printed on service invoices). Return as YYYY-MM-DD. "" if not printed.'],
    ['ar_periodo_hasta',    'Service period end — "Período Facturado Hasta" (only printed on service invoices). Return as YYYY-MM-DD. "" if not printed.'],
    ['ar_cotizacion',       'Exchange rate — "Cotización" / "Tipo de cambio", ONLY when the invoice is in a foreign currency (e.g. "1 USD = 1350" -> 1350). Number with a dot decimal. "" if in ARS or not printed.'],
    ['ar_condicion_iva',          'ISSUER / supplier VAT condition — condición frente al IVA del EMISOR (e.g. "Responsable Inscripto", "Monotributo", "IVA Exento").'],
    ['ar_condicion_iva_receptor', 'BUYER / recipient VAT condition — condición frente al IVA del RECEPTOR/cliente (e.g. "Consumidor Final", "Responsable Inscripto", "Monotributo", "Exento", "IVA no alcanzado").'],
    ['ar_neto_no_gravado',        'Net non-taxable amount — "Neto No Gravado" / "Importe No Gravado" (base NOT subject to VAT), separate from the taxable net (subtotal). Number with a dot decimal, NO thousands separator, NO symbol. "" if not present.'],
    ['ar_exento',                 'Exempt amount — "Importe Exento" / "Op. Exentas" (VAT-exempt base). Number with a dot decimal. "" if not present.'],
    ['ar_iva_21',                 'VAT amount at 21% ONLY — the "IVA 21%" line. Number with a dot decimal. "" if there is no 21% line.'],
    ['ar_iva_105',               'VAT amount at 10.5% ONLY — the "IVA 10,5%" line. Number with a dot decimal. "" if there is no 10.5% line.'],
    ['ar_iva_27',                 'VAT amount at 27% ONLY — the "IVA 27%" line (typical of utilities/telecom billed to Responsables Inscriptos). Number with a dot decimal. "" if there is no 27% line.'],
    ['ar_percepcion_iva',         'VAT perception — "Percepción IVA" / "Percep. IVA" (RG 3337 and similar). ONLY the VAT perception. Number with a dot decimal. "" if not present.'],
    ['ar_percepcion_iibb',        'Gross-income perception — "Percepción IIBB" / "Percep. Ingresos Brutos" (provincial: ARBA, AGIP, etc.). If several jurisdictions, return their SUM. Number with a dot decimal. "" if not present.'],
    ['ar_percepcion_ganancias',   'Income-tax perception — "Percepción Ganancias" / "Percep. Impuesto a las Ganancias" (RG 830 and similar). Number with a dot decimal. "" if not present.'],
    ['ar_impuestos_internos',     'Internal taxes — "Impuestos Internos". Number with a dot decimal. "" if not present.'],
    ['ar_otros_tributos',         'RESIDUAL other taxes — only "Otros Tributos" that are NOT VAT perception, gross-income perception, income-tax perception nor internal taxes (e.g. municipal taxes/perceptions). Never duplicate here an amount already reported in ar_percepcion_* or ar_impuestos_internos. Number with a dot decimal. "" if none.'],
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

// ─── REMITOS ─────────────────────────────────────────────────────────────────
// Un remito NO es una factura sin importes: es otro documento. Se va TODO lo de
// plata (neto, IVA, percepciones, total) y entra lo de logística y trazabilidad.
// Definido sobre 192 remitos reales de dos clientes y dos rubros (aberturas y
// agroquímicos); ver [[remitos-argentina]] en la memoria del proyecto.
// El único importe que aparece es el "valor declarado", que NO es un precio a
// pagar sino la base del seguro del flete — por eso su descripción lo aclara.
const FIELDS_REMITO = [
  ['document_type',    'Document type as printed — for a delivery note: "Remito", "Remito R", "Nota de Entrega".'],
  ['invoice_number',   'Delivery-note number, point of sale + number as printed (e.g. "0028-01105914").'],
  ['issue_date',       'Issue date of the delivery note. Return as YYYY-MM-DD.'],
  ['supplier_name',    'Issuer / shipper legal or trade name (the party SENDING the goods).'],
  ['supplier_tax_id',  'Issuer tax identification number, as printed.'],
  ['supplier_address', 'Issuer address ONLY. Do NOT include any part of the recipient address.'],
  ['customer_name',    'Recipient / customer name ("Señor(es)", "Cliente", "SR/ES").'],
  ['customer_tax_id',  'Recipient tax identification number.'],
  ['customer_address', 'Recipient fiscal address ONLY (their registered address, not necessarily where the goods go).'],
  ['payment_terms',    'Sale conditions if printed ("Cuenta corriente", "Contado", "CONDICIONES").'],
]

const COUNTRY_FIELDS_REMITO = {
  AR: [
    ['ar_punto_venta',        'Point of sale, 4 or 5 digits AS PRINTED (0028, 00202). Keep leading zeros — return as text.'],
    ['ar_cae',                'The long authorization code printed at the bottom, usually labelled "C.A.I." on a remito (14 digits). Return exactly as printed. "" if not printed.'],
    ['ar_cae_vto',            'Expiry of that authorization code ("Fecha de Vto.", "Vto."). Return as YYYY-MM-DD. ONLY if printed — never compute it.'],
    ['ar_domicilio_entrega',  'DELIVERY address — where the goods are actually dropped off. Labels: "Entregar en", "Domicilio de entrega", "DOM. ENTREGA", "Dirección destino". It is often DIFFERENT from the recipient fiscal address. "" if not printed.'],
    ['ar_transportista',      'Carrier name — "Transporte", "Transportista", "TPTE.", "Remitido por transporte". "" if not printed.'],
    ['ar_transportista_cuit', 'Carrier tax ID, when the carrier block prints its own CUIT. "" if not printed.'],
    ['ar_bultos',             'Number of packages — "Bultos", "Cantidad de Bultos", "Se reciben N bultos". A count, not an amount. "" if not printed.'],
    ['ar_peso',               'Total weight — "Peso", "Kilos". Number with a dot decimal. "" if not printed.'],
    ['ar_valor_declarado',    'Declared value — "Valor Declarado", "V. Aprox", "Valor para Flete". ⚠️ This is the insured value for freight, NOT a price to pay and NOT a total: never treat it as an invoice total. Number with a dot decimal. "" if not printed.'],
    ['ar_orden_compra',       'Purchase-order reference of the BUYER, when the supplier prints it — "Orden de compra", "Pedido N°", "Órdenes de compra de cliente", "N° Pedido". Return exactly as printed. "" if not printed.'],
    ['ar_comprobante_asociado', 'Invoice this delivery note is linked to, when printed — "Factura Nro.", "Fac. N°". Return the document number as printed. "" if not printed.'],
    ['ar_cot',                'Código de Operación de Traslado (ARBA) — "N° C.O.T.". Only on some provincial shipments. "" if not printed.'],
  ],
}

// Renglones: en una factura interesa la plata; en un remito, QUÉ y CUÁNTO llegó.
// unidad/lote/vencimiento de partida son trazabilidad obligatoria en agroquímicos.
export const LINE_FIELDS = {
  fiscal: [
    ['description',  'the row description, as printed, concise'],
    ['quantity',     'quantity'],
    ['unit_price',   'price per unit'],
    ['bonificacion', 'the row discount PERCENT if shown, e.g. "10"'],
    ['subtotal',     'row net amount, before VAT'],
    ['iva',          'the row VAT RATE percent if shown, e.g. "21"'],
    ['total',        'row total'],
  ],
  remito: [
    ['description',  'the article / description, as printed'],
    ['quantity',     'quantity delivered. Watch the separators: "1.000,000" is one thousand and "11,900" is 11.9'],
    ['unidad',       'unit of measure as printed ("Lts.", "Kgs.", "Unidad", "Mts."). "" if the table has no unit column'],
    ['codigo',       'the article/product code, when the table has a code column'],
    ['lote',         'batch / lot number, when printed (agrochemicals, food)'],
    ['vto_partida',  'batch expiry date, when printed. Return as YYYY-MM-DD'],
    ['deposito',     'source warehouse, when printed'],
    ['envases',      'number of containers/packages for the row, when printed'],
  ],
}

// Universales + capas de los países configurados (sin duplicar IDs). Orden estable.
// kind: 'fiscal' (facturas/NC/ND) | 'remito'. Un tablero es de UN tipo.
export function fieldsForCountries(countries = [], kind = 'fiscal') {
  const base = kind === 'remito' ? FIELDS_REMITO : FIELDS
  const capa = kind === 'remito' ? COUNTRY_FIELDS_REMITO : COUNTRY_FIELDS
  const seen = new Set(base.map(([id]) => id))
  const extra = []
  for (const c of (countries || [])) {
    for (const f of (capa[c] || [])) {
      if (!seen.has(f[0])) { seen.add(f[0]); extra.push(f) }
    }
  }
  return [...base, ...extra]
}

// Los tipos de documento que sabe leer la app. Un tablero elige uno.
export const DOC_KINDS = ['fiscal', 'remito']

// Campos que se escriben como número en columnas numéricas de Monday.
export const NUMERIC_FIELDS = new Set(['subtotal', 'tax_amount', 'total_amount',
  'ar_neto_no_gravado', 'ar_exento', 'ar_iva_21', 'ar_iva_105', 'ar_iva_27',
  'ar_percepcion_iva', 'ar_percepcion_iibb', 'ar_percepcion_ganancias', 'ar_impuestos_internos', 'ar_otros_tributos',
  'ar_cotizacion', 'ar_peso', 'ar_valor_declarado', 'ar_bultos', 'cl_impuesto_adicional', 'cl_monto_exento', 'br_icms', 'br_ipi'])

// Campos donde un 0 significa "esta factura NO tiene ese impuesto", no un importe
// real. El prompt pide devolver vacío, pero el LLM a veces igual manda "0.00" y
// entonces el tablero muestra un 0 que parece un dato leído: ensucia la contabilidad
// (ej. "IVA 10,5%: 0" en una factura que solo tiene IVA 21%). Acá lo limpiamos de
// forma determinística en vez de confiar en el prompt.
// subtotal y total_amount NO están: ahí un 0 es un error que conviene ver.
export const ZERO_IS_EMPTY = new Set(['tax_amount',
  'ar_neto_no_gravado', 'ar_exento', 'ar_iva_21', 'ar_iva_105', 'ar_iva_27',
  'ar_percepcion_iva', 'ar_percepcion_iibb', 'ar_percepcion_ganancias',
  'ar_impuestos_internos', 'ar_otros_tributos', 'ar_cotizacion',
  'cl_impuesto_adicional', 'cl_monto_exento', 'br_icms', 'br_ipi'])

// Pasa a "" los importes que vinieron en 0 pero significan "no aplica".
// Devuelve la lista de campos limpiados (para loguear).
export function blankZeros(data) {
  const cleared = []
  for (const f of ZERO_IS_EMPTY) {
    const v = data[f]
    if (v === undefined || v === null || v === '') continue
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'))
    if (Number.isFinite(n) && n === 0) { data[f] = ''; cleared.push(f) }
  }
  return cleared
}

// Campos que son fechas (Claude ya las devuelve YYYY-MM-DD; se escriben en columnas date).
export const DATE_FIELDS = new Set(['issue_date', 'due_date', 'ar_cae_vto', 'ar_periodo_desde', 'ar_periodo_hasta', 'uy_cae_vto'])