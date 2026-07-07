// Test del extractor UNIVERSAL con facturas locales (validación).
// Uso (desde backend/):
//   node scripts/test-extract.mjs <archivo1.pdf> [archivo2.pdf ...]
// Opciones:  --countries=US,DE,FR   --model=claude-haiku-4-5
import 'dotenv/config' // carga ANTHROPIC_API_KEY desde backend/.env
import { readFileSync } from 'node:fs'
import { extname, basename } from 'node:path'
import { extractInvoice } from '../extractor.mjs'
import { fieldsForCountries } from '../fields.mjs'

// $/1M tokens (in/out) por modelo, para estimar costo del test.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5':  { in: 3, out: 15 },
  'claude-opus-4-8':  { in: 5, out: 25 },
}

const MEDIA = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
}

const argv = process.argv.slice(2)
const files = argv.filter((a) => !a.startsWith('--'))
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')),
)
const model = opts.model || 'claude-haiku-4-5'
const countries = (opts.countries || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)

if (!files.length) {
  console.error('Uso: node scripts/test-extract.mjs <archivo.pdf> [...] [--countries=US,DE] [--model=...]')
  process.exit(1)
}

const price = PRICES[model] || PRICES['claude-haiku-4-5']
let totIn = 0, totOut = 0
const activeFields = fieldsForCountries(countries)

for (const file of files) {
  console.log('\n' + '='.repeat(72))
  console.log('Archivo:', basename(file), `  (modelo: ${model}${countries.length ? `, países: ${countries.join(',')}` : ''})`)
  const mediaType = MEDIA[extname(file).toLowerCase()] || 'application/pdf'
  try {
    const b64 = readFileSync(file).toString('base64')
    const { data, usage } = await extractInvoice(b64, mediaType, model, { countries })
    totIn += usage.input_tokens; totOut += usage.output_tokens
    console.log(`País detectado: ${data.detected_country || '—'}   |   tokens in/out: ${usage.input_tokens}/${usage.output_tokens}`)
    console.log('-'.repeat(72))
    let filled = 0
    for (const [id] of activeFields) {
      const v = (data[id] || '').toString().trim()
      if (v) filled++
      console.log(`  ${v ? '✓' : '·'} ${id.padEnd(24)} ${v || ''}`)
    }
    console.log('-'.repeat(72))
    console.log(`  → ${filled}/${activeFields.length} campos extraídos`)
  } catch (e) {
    console.error('  ERROR:', e.message)
  }
}

const cost = (totIn / 1e6) * price.in + (totOut / 1e6) * price.out
console.log('\n' + '='.repeat(72))
console.log(`TOTAL: ${files.length} facturas · tokens ${totIn} in / ${totOut} out · costo estimado $${cost.toFixed(4)} USD`)
