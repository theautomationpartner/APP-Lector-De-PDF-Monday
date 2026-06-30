// Catálogo INTERNACIONAL de campos de factura (universal, cualquier país).
// Mapea 1:1 con el núcleo de EN 16931. [id, descripción EN con sinónimos por país].
export const FIELDS = [
  ['document_type',    'Document type and series/letter if present (e.g. "Invoice", "Tax Invoice", "Credit Note", "Receipt", "Factura A/B/C", "Nota de Crédito").'],
  ['invoice_number',   'Invoice / document number or folio. Labels vary: Invoice No., Inv #, Factura N°, Número, Comprobante, Rechnungsnummer, N° facture, Folio.'],
  ['issue_date',       'Issue / invoice date. Return as YYYY-MM-DD.'],
  ['due_date',         'Payment due date. Return as YYYY-MM-DD.'],
  ['po_number',        'Purchase order number / PO / Order ref / Orden de compra.'],
  ['currency',         'Currency as a 3-letter ISO 4217 code (USD, EUR, ARS, BRL, GBP, MXN...). If only a symbol appears, infer it from the country.'],
  ['supplier_name',    'Seller / supplier / vendor legal or trade name (the party ISSUING the invoice). "From", "Bill from", "Razón social", "Emisor".'],
  ['supplier_tax_id',  'Seller tax identification number, however it is labeled locally: VAT / VAT No / Tax ID / EIN / CUIT / RFC / NIF / CIF / ABN / GSTIN / UID / TIN. Return as printed.'],
  ['supplier_address', 'Seller address (street, city, country).'],
  ['customer_name',    'Buyer / customer / "Bill to" name (the party BEING invoiced). "Cliente", "Receptor".'],
  ['customer_tax_id',  'Buyer tax identification number (same kinds as supplier_tax_id; may be a personal ID/DNI for individuals).'],
  ['customer_address', 'Buyer address.'],
  ['subtotal',         'Net amount before taxes (taxable base / subtotal / net / Neto gravado). Number with a dot decimal, no thousands separator (e.g. 1234.56), no currency symbol.'],
  ['tax_amount',       'Total tax amount (VAT / GST / IVA / sales tax). If several rates, return the total. Number with a dot decimal.'],
  ['amount_due',       'Amount due / balance to pay, if shown separately from the total. Number with a dot decimal.'],
  ['total_amount',     'Grand total (total payable, taxes included). Number with a dot decimal.'],
  ['payment_terms',    'Payment terms / method / conditions (e.g. "Net 30", "Contado", "Cuenta corriente").'],
  ['notes',            'Notes / observations / comments free text, if present.'],
]

// Campos que se escriben como número en columnas numéricas de Monday.
export const NUMERIC_FIELDS = new Set(['subtotal', 'tax_amount', 'amount_due', 'total_amount'])

// Campos que son fechas (Claude ya las devuelve YYYY-MM-DD; se escriben en columnas date).
export const DATE_FIELDS = new Set(['issue_date', 'due_date'])