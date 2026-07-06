import Anthropic from '@anthropic-ai/sdk'
import { FIELDS } from './fields.mjs'
import { config } from './config.mjs'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

// Esquema = catálogo + detected_country (meta, para normalización y log).
const props = Object.fromEntries(FIELDS.map(([id]) => [id, { type: 'string' }]))
props.detected_country = { type: 'string' }
const schema = {
  type: 'object',
  properties: props,
  required: [...FIELDS.map(([id]) => id), 'detected_country'],
  additionalProperties: false,
}

const fieldGuide = FIELDS.map(([id, desc]) => `- ${id}: ${desc}`).join('\n')

// Manda el archivo (PDF o imagen, base64) a Claude y devuelve { data, usage, model }.
// mediaType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'.
// hints = { country, currency } de la config, para desambiguar fecha/número/moneda.
export async function extractInvoice(fileBase64, mediaType = 'application/pdf', model = 'claude-haiku-4-5', hints = {}) {
  const { country = '', currency = '' } = hints
  const hintText = (country || currency)
    ? `\n\nThe account using this app is based in ${country || 'an unknown country'}` +
      `${currency ? ` and works in ${currency}` : ''}. Use this to resolve ambiguous date formats ` +
      `(US uses MM/DD/YYYY, most countries DD/MM/YYYY), number separators and currency symbols. ` +
      `BUT the invoice itself may come from another country, so detect its actual country.`
    : ''

  const fileBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }

  const res = await client.messages.create({
    model,
    max_tokens: 2000,
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
              hintText + '\n\n' + fieldGuide,
          },
        ],
      },
    ],
  })

  const text = res.content.find((b) => b.type === 'text')?.text || '{}'
  return { data: JSON.parse(text), usage: res.usage, model }
}