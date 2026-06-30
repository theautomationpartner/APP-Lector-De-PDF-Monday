import Anthropic from '@anthropic-ai/sdk'
import { FIELDS } from './fields.mjs'

const client = new Anthropic() // lee ANTHROPIC_API_KEY del entorno

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

// Manda el PDF (base64) a Claude y devuelve { data, usage, model }.
// hints = { country, currency } de la config, para desambiguar fecha/número/moneda.
export async function extractInvoice(pdfBase64, model = 'claude-haiku-4-5', hints = {}) {
  const { country = '', currency = '' } = hints
  const hintText = (country || currency)
    ? `\n\nThe account using this app is based in ${country || 'an unknown country'}` +
      `${currency ? ` and works in ${currency}` : ''}. Use this to resolve ambiguous date formats ` +
      `(US uses MM/DD/YYYY, most countries DD/MM/YYYY), number separators and currency symbols. ` +
      `BUT the invoice itself may come from another country, so detect its actual country.`
    : ''

  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text:
              'You are a UNIVERSAL invoice data extractor. The invoice can be from ANY country and ' +
              'in ANY language. Extract each field by its MEANING, not by a specific label. ' +
              'If a field is NOT present, return an empty string "". Do not invent or guess data. ' +
              'Dates as YYYY-MM-DD. Amounts as plain numbers with a dot decimal and NO thousands ' +
              'separator and NO currency symbol (e.g. 1234.56). Currency as a 3-letter ISO 4217 code. ' +
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