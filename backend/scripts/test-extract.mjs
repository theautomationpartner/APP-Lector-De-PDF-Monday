// Test del extractor UNIVERSAL con facturas locales (Opción 2 — validación).
// Uso (desde backend/):
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/test-extract.mjs <archivo1.pdf> [archivo2.pdf ...]
// Hints opcionales:  --country=AR --currency=ARS --model=claude-haiku-4-5
import 'dotenv/config' // carga ANTHROPIC_API_KEY desde backend/.env
import { readFileSync } from 'node:fs'
import { extractInvoice } from '../extractor.mjs'
import { FIELDS } from '../fields.mjs'

const argv = process.argv.slice(2)
const files = argv.filter((a) => !a.startsWith('--'))
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')),
)
const model = opts.model || 'claude-haiku-4-5'

if (!files.length) {
  console.error('Uso: node scripts/test-extract.mjs <archivo.pdf> [...] [--country=AR] [--currency=ARS] [--model=...]')
  process.exit(1)
}

for (const file of files) {
  console.log('\n' + '='.repeat(72))
  console.log('Archivo:', file, `  (modelo: ${model})`)
  try {
    const b64 = readFileSync(file).toString('base64')
    const { data, usage } = await extractInvoice(b64, model, {
      country: opts.country || '', currency: opts.currency || '',
    })
    console.log(`País detectado: ${data.detected_country || '—'}   |   tokens in/out: ${usage.input_tokens}/${usage.output_tokens}`)
    console.log('-'.repeat(72))
    let filled = 0
    for (const [id] of FIELDS) {
      const v = (data[id] || '').toString().trim()
      if (v) filled++
      console.log(`  ${v ? '✓' : '·'} ${id.padEnd(18)} ${v || ''}`)
    }
    console.log('-'.repeat(72))
    console.log(`  → ${filled}/${FIELDS.length} campos extraídos`)
  } catch (e) {
    console.error('  ERROR:', e.message)
  }
}