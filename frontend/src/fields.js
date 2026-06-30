// Catálogo internacional de campos de factura (sirve para cualquier país).
// El backend usa este mismo set + sinónimos por país en el prompt de la IA.

// document_type se muestra junto al título de la factura (aparte).
export const ALL_FIELDS = [
  'document_type',
  'invoice_number', 'issue_date', 'due_date', 'po_number', 'currency',
  'supplier_name', 'supplier_tax_id', 'supplier_address',
  'customer_name', 'customer_tax_id', 'customer_address',
  'subtotal', 'tax_amount', 'amount_due', 'total_amount',
  'payment_terms', 'notes',
]

// Listas curadas para los defaults (ISO). "" = auto-detect.
export const COUNTRIES = [
  'AR', 'AU', 'BR', 'CA', 'CL', 'CO', 'DE', 'ES', 'FR', 'GB', 'IT', 'MX', 'PT', 'US',
]
export const CURRENCIES = [
  'USD', 'EUR', 'ARS', 'BRL', 'CAD', 'CLP', 'COP', 'GBP', 'MXN', 'AUD',
]