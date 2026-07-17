import Anthropic from '@anthropic-ai/sdk'
import { fieldsForCountries } from './fields.mjs'
import { reconcileCodes } from './pdfcodes.mjs'
import { config } from './config.mjs'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

// Esquema JSON (catálogo + detected_country) para el set de campos dado. Se arma
// por llamada porque los campos dependen de los países configurados en el tablero.
// lineItems: agrega el array de renglones (solo si el tablero activó los subítems
// — extraerlos cuesta tokens de salida extra, no se paga si nadie lo usa).
function buildSchema(fields, lineItems = false) {
  const props = Object.fromEntries(fields.map(([id]) => [id, { type: 'string' }]))
  props.detected_country = { type: 'string' }
  const required = [...fields.map(([id]) => id), 'detected_country']
  if (lineItems) {
    props.line_items = {
      type: 'array', // sin maxItems: structured outputs no lo soporta (el cap de 50 está al crear los subítems)
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          quantity:    { type: 'string' },
          unit_price:  { type: 'string' },
          total:       { type: 'string' },
        },
        required: ['description', 'quantity', 'unit_price', 'total'],
        additionalProperties: false,
      },
    }
    required.push('line_items')
  }
  return { type: 'object', properties: props, required, additionalProperties: false }
}

// Manda el archivo (PDF o imagen, base64) a Claude y devuelve { data, usage, model }.
// mediaType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'.
// hints = { country, currency } de la config, para desambiguar fecha/número/moneda.
export async function extractInvoice(fileBase64, mediaType = 'application/pdf', model = 'claude-haiku-4-5', hints = {}) {
  const { countries = [], lineItems = false } = hints
  // Campos = universales + capas de los países configurados (ej. AR agrega CAE, etc.).
  const fields = fieldsForCountries(countries)
  const schema = buildSchema(fields, lineItems)
  const fieldGuide = fields.map(([id, desc]) => `- ${id}: ${desc}`).join('\n')
  const lineItemsText = lineItems
    ? '\n\nLINE ITEMS: also return line_items — one entry per row of the invoice detail table, in order: ' +
      'description (as printed, concise), quantity, unit_price (price per unit) and total (line total), all ' +
      'as strings following the AMOUNTS rules ("" if that cell is not present). If the invoice has no ' +
      'itemized rows (e.g. a subscription or single-concept invoice), return [].'
    : ''
  const hintText = countries.length
    ? `\n\nThis board processes invoices from: ${countries.join(', ')}. Use this as context to resolve ` +
      `ambiguous date formats (US uses MM/DD/YYYY, most countries DD/MM/YYYY), number separators and ` +
      `currency symbols/codes. BUT an invoice may still be from another country, so always detect its actual country.`
    : ''

  const fileBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }

  const res = await client.messages.create({
    model,
    // 4000 con renglones (una factura de 30+ renglones no entra en 2000 y
    // truncaría el JSON). max_tokens es un tope, no se factura lo no usado.
    max_tokens: lineItems ? 4000 : 2000,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: [
          fileBlock,
          {
            type: 'text',
            text:
              'You are a UNIVERSAL invoice data extractor. The invoice can be from ANY country and in ANY ' +
              'language, and the file may be a PDF or a photo/scan. Extract each field by its MEANING, not by ' +
              'a specific label. If a field is NOT present, return an empty string "". Do not invent data. ' +
              'CRITICAL: keep seller and buyer strictly separate — supplier_* fields describe ONLY the party ' +
              'issuing the invoice, customer_* fields ONLY the party being billed. Never merge their names, ' +
              'tax IDs or addresses (e.g. do not append the buyer city to the seller address). ' +
              'Dates as YYYY-MM-DD. ' +
              'AMOUNTS: return the true numeric value with "." as the ONLY decimal separator, with NO thousands ' +
              'separators and NO currency symbol. Read the separators by locale — do NOT assume US format: ' +
              '"1.234.567,89" -> 1234567.89 and "1,234,567.89" -> 1234567.89 (if BOTH separators appear, the ' +
              'LAST one is the decimal). Zero-decimal currencies (CLP, JPY, COP, PYG, KRW, ISK, VND...) have NO ' +
              'cents, so "354.172" -> 354172 and "1.166.760" -> 1166760. A single separator followed by exactly ' +
              'THREE digits is a thousands separator, not a decimal. ' +
              'Currency as a 3-letter ISO 4217 code. ' +
              'Also return detected_country as an ISO 3166-1 alpha-2 code (or "" if unclear).' +
              hintText + lineItemsText + '\n\n' + fieldGuide,
          },
        ],
      },
    ],
  })

  const text = res.content.find((b) => b.type === 'text')?.text || '{}'
  const data = JSON.parse(text)

  // Capa determinística: en PDFs con texto, corrige los códigos largos (chave, CUFE,
  // CAE, UUID) que el LLM pudo transcribir mal. Gratis, exacto. No aplica a fotos.
  if (mediaType === 'application/pdf') {
    try {
      const fixed = await reconcileCodes(data, fileBase64, fields)
      if (fixed.length) console.log('[extractor] códigos corregidos desde el texto del PDF:', fixed.join(', '))
    } catch (e) { console.warn('[extractor] reconcile de códigos falló:', e.message) }
  }

  return { data, usage: res.usage, model }
}