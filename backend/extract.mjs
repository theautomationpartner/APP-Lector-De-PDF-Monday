import 'dotenv/config'
import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'

// Lee ANTHROPIC_API_KEY del entorno (.env).
const client = new Anthropic()

// Catálogo de campos de una factura argentina (mismo set que la vista de mapeo).
// [id, descripción para guiar a Claude]
const FIELDS = [
  ['tipo_comprobante',      'Tipo de comprobante y letra (ej: "Factura A", "Factura B", "Nota de Crédito C")'],
  ['punto_venta',           'Punto de venta (suele ser 4 dígitos, ej: 0001)'],
  ['nro_comprobante',       'Número de comprobante'],
  ['fecha_emision',         'Fecha de emisión, formato DD/MM/AAAA'],
  ['cae',                   'CAE o CAI (número largo al pie del comprobante)'],
  ['vto_cae',               'Fecha de vencimiento del CAE, formato DD/MM/AAAA'],
  ['emisor_razon_social',   'Razón social del EMISOR (quien emite la factura)'],
  ['emisor_cuit',           'CUIT del emisor'],
  ['emisor_cond_iva',       'Condición frente al IVA del emisor (ej: Responsable Inscripto)'],
  ['emisor_domicilio',      'Domicilio comercial del emisor'],
  ['receptor_razon_social', 'Razón social o nombre del CLIENTE / receptor'],
  ['receptor_cuit',         'CUIT o DNI del cliente / receptor'],
  ['receptor_cond_iva',     'Condición frente al IVA del receptor'],
  ['condicion_venta',       'Condición de venta (Contado, Cuenta corriente, etc.)'],
  ['periodo_desde',         'Período facturado desde, formato DD/MM/AAAA'],
  ['periodo_hasta',         'Período facturado hasta, formato DD/MM/AAAA'],
  ['fecha_vto_pago',        'Fecha de vencimiento de pago, formato DD/MM/AAAA'],
  ['importe_neto',          'Importe neto gravado (subtotal sin IVA). Solo el número, sin símbolo $'],
  ['iva',                   'Importe total de IVA. Solo el número'],
  ['percepciones',          'Total de percepciones / otros tributos. Solo el número'],
  ['importe_total',         'Importe total final del comprobante. Solo el número'],
]

const schema = {
  type: 'object',
  properties: Object.fromEntries(FIELDS.map(([id]) => [id, { type: 'string' }])),
  required: FIELDS.map(([id]) => id),
  additionalProperties: false,
}

const fieldGuide = FIELDS.map(([id, desc]) => `- ${id}: ${desc}`).join('\n')

const pdfPath = process.argv[2]
if (!pdfPath) {
  console.error('Uso: npm run extract -- <ruta-al-archivo.pdf>')
  process.exit(1)
}

const pdfBase64 = fs.readFileSync(pdfPath).toString('base64')

// Modelo configurable: por defecto Opus 4.8 (máxima precisión, para la 1ª prueba).
// Para producción/comparar costo: poné MODEL=claude-sonnet-4-6 o claude-haiku-4-5.
const MODEL = process.env.MODEL || 'claude-opus-4-8'
console.log(`Leyendo ${pdfPath} (${(pdfBase64.length / 1024).toFixed(0)} KB base64) con ${MODEL}…\n`)

const res = await client.messages.create({
  model: MODEL,
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
            'Sos un extractor de datos de facturas argentinas. Leé esta factura ' +
            'y extraé los siguientes campos. Si un campo NO aparece en el documento, ' +
            'devolvé cadena vacía "". No inventes ni completes datos que no estén.\n\n' +
            fieldGuide,
        },
      ],
    },
  ],
})

const text = res.content.find((b) => b.type === 'text')?.text || '{}'
const data = JSON.parse(text)

console.log(JSON.stringify(data, null, 2))
console.log(
  `\n--- uso: ${res.usage.input_tokens} tokens entrada / ${res.usage.output_tokens} salida`,
)
