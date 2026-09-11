import Anthropic from '@anthropic-ai/sdk'
import { createReadStream, readFileSync } from 'node:fs'
import { fieldsForCountries, blankZeros, DATE_FIELDS, LINE_FIELDS } from './fields.mjs'
import { reconcileCodes } from './pdfcodes.mjs'
import { promptFor, enrichAll, anyPack, usaQr } from './countries/index.mjs'
import { decodeInvoiceQr } from './qr.mjs'
import { config } from './config.mjs'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

// Files API: se sube el archivo aparte y el mensaje lo referencia por id, en vez
// de mandar el base64 adentro del request. Sirve para los archivos GRANDES, que
// de la otra forma no entran en memoria: mandar un PDF de 9 MB en base64 son
// ~33 MB de heap (buffer + base64 + el body del request), y el proceso moria.
// Subiendolo desde disco con un stream, el base64 NUNCA pasa por la memoria.
//
// Es sin perdida: se sube el archivo original, byte por byte. No se re-comprime
// ni se baja resolucion, asi que la calidad de lectura es identica.
//
// En el SDK 0.70 la Files API todavia vive en el namespace beta y pide el header.
const FILES_BETA = 'files-api-2025-04-14'

// Sube el archivo desde DISCO (stream, no lo carga en memoria) y devuelve su id.
async function subirArchivo(filePath) {
  const { id } = await client.beta.files.upload({
    file: createReadStream(filePath),
    betas: [FILES_BETA],
  })
  return id
}

// Los archivos subidos quedan guardados en la cuenta de Anthropic y ocupan cuota.
// Como cada uno se usa para UNA lectura y nunca mas, se borra al terminar. Falla
// en silencio a proposito: si el borrado no sale, la factura ya se leyo bien y no
// vale la pena romper la lectura por una tarea de limpieza.
async function borrarArchivo(fileId) {
  try {
    await client.beta.files.delete(fileId, { betas: [FILES_BETA] })
  } catch (e) {
    console.warn('[files] no se pudo borrar el archivo subido:', e.message)
  }
}

// Parámetros que cambian según el modelo. Haiku 4.5 acepta temperature y no tiene
// thinking adaptativo. Los modelos nuevos (Sonnet 5, Opus 5, familia 4.6+) tiran
// 400 si les mandás temperature, y vienen con thinking prendido que consume el
// max_tokens razonando: el JSON sale truncado y la lectura se pierde entera.
// (Ese fue el motivo por el que la prueba de Sonnet de julio 2026 no funcionó.)
function paramsDelModelo(model) {
  const esHaikuOViejo = /haiku|claude-3|sonnet-4-5|sonnet-3/.test(String(model))
  return esHaikuOViejo
    ? { temperature: 0 }
    : { thinking: { type: 'disabled' } }
}

// Empareja el FORMATO del tipo de documento. Al modelo le pedimos el tipo "tal
// como está impreso" (y está bien: así no inventa un tipo que el papel no dice),
// pero cada proveedor lo imprime a su manera — "REMITO", "Remito", "FACTURA" — y
// la columna del tablero es un DROPDOWN: cada variante crea una opción distinta,
// así que "REMITO" y "Remito" quedan como dos categorías que no se agrupan ni se
// filtran juntas. Caso real (2026-09-10): 10 remitos, 3 formatos.
//
// Solo cambia mayúsculas/minúsculas. NO traduce ni reinterpreta: si el papel dice
// "Nota de Entrega", sigue diciendo "Nota de Entrega".
//
// Las facturas CON QR de AFIP no pasan por acá con formato raro: el pack de AR ya
// les pone el nombre canónico desde el código del comprobante. Esto arregla el
// resto — remitos (que no tienen QR) y cualquier país sin pack.
const MINUSCULAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e'])
export function normalizarTipoDoc(valor) {
  const s = String(valor || '').trim()
  if (!s) return s
  return s.split(/\s+/).map((palabra, i) => {
    // Letra sola = la letra fiscal del comprobante (A, B, C, E, M, R): va en
    // mayúscula siempre. "Factura a" sería un comprobante distinto al leerlo.
    if (palabra.length === 1) return palabra.toUpperCase()
    const baja = palabra.toLowerCase()
    if (i > 0 && MINUSCULAS.has(baja)) return baja
    return baja.charAt(0).toUpperCase() + baja.slice(1)
  }).join(' ')
}

// El rol va en el system prompt (recomendación de Anthropic) y explica el PORQUÉ
// de la regla principal: un dato inventado es peor que uno vacío. Con el motivo
// el modelo generaliza a los casos que no enumeramos. Exportado para que el banco
// de prueba use EXACTAMENTE el mismo texto que producción.
export const SYSTEM_PROMPT =
  'You are a fiscal-document data extractor working for an accounting firm. What you return is loaded ' +
  'straight into the client\'s books, unreviewed. A blank field is visible and gets filled in by hand; ' +
  'a wrong number gets booked and nobody ever notices. So an invented value is far worse than an empty ' +
  'one. Never guess, never infer, never compute: if you cannot SEE it printed on the document, leave it ' +
  'empty. Accuracy of transcription matters more than completeness.'

// Esquema JSON (catálogo + detected_country) para el set de campos dado. Se arma
// por llamada porque los campos dependen de los países configurados en el tablero.
// lineItems: agrega el array de renglones (solo si el tablero activó los subítems
// — extraerlos cuesta tokens de salida extra, no se paga si nadie lo usa).
export function buildSchema(fields, lineItems = false, kind = 'fiscal') {
  // PRIMERA propiedad a propósito: structured outputs genera las claves en el orden
  // del esquema, así que acá el modelo transcribe los renglones críticos ANTES de
  // completar nada. Es la técnica de "citar antes de responder" que recomienda
  // Anthropic para documentos: mirar el dato y copiarlo textual baja muchísimo el
  // error de transcripción (los CUIT y números mal leídos que encontramos en prod).
  const props = { lineas_clave: { type: 'string' } }
  for (const [id] of fields) props[id] = { type: 'string' }
  props.detected_country = { type: 'string' }
  // Clasificación del documento (para el filtro "solo facturas/NC/ND"). Siempre
  // presente; el gate se aplica o no según la config del tablero.
  props.document_class = { type: 'string' }
  const required = ['lineas_clave', ...fields.map(([id]) => id), 'detected_country', 'document_class']
  if (lineItems) {
    // Los campos del renglón cambian con el tipo: una factura trae precio e IVA,
    // un remito trae unidad, lote y vencimiento de partida.
    const cols = LINE_FIELDS[kind] || LINE_FIELDS.fiscal
    props.line_items = {
      type: 'array', // sin maxItems: structured outputs no lo soporta (el cap de 50 está al crear los subítems)
      items: {
        type: 'object',
        properties: Object.fromEntries(cols.map(([id]) => [id, { type: 'string' }])),
        required: cols.map(([id]) => id),
        additionalProperties: false,
      },
    }
    required.push('line_items')
  }
  return { type: 'object', properties: props, required, additionalProperties: false }
}


// Arma el texto del prompt. Es una función exportada A PROPÓSITO: así lo que se
// inspecciona es exactamente lo que se manda, sin copias que se desactualicen.
// Estructura (guía de Anthropic): datos largos arriba, consigna al final, y cada
// bloque en su etiqueta XML para que no se mezclen instrucciones con catálogo.
export function buildPrompt(countries = [], lineItems = false, kind = 'fiscal') {
  const fields = fieldsForCountries(countries, kind)
  const fieldGuide = fields.map(([id, desc]) => `- ${id}: ${desc}`).join('\n')
  // Los campos del renglón cambian con el tipo de documento: una factura trae
  // precio e IVA por renglón; un remito trae unidad, lote y vencimiento de partida.
  const cols = LINE_FIELDS[kind] || LINE_FIELDS.fiscal
  const lineItemsText = lineItems
    ? '\n\n<renglones>\nAlso return line_items — one entry per row of the document detail table, in order. ' +
      'Per row return, all as strings following the AMOUNTS rules and "" if that cell is not printed:\n' +
      cols.map(([id, d]) => `- ${id}: ${d}`).join('\n') +
      '\nExtract ONLY what is printed on the row; do not compute values. If the document has no ' +
      'itemized rows, return []. Column order changes from one supplier to the next — read each column ' +
      'by its HEADER, never by its position.\n</renglones>'
    : ''
  const hintText = countries.length
    ? `\n\n<contexto_del_tablero>\nThis board processes invoices from: ${countries.join(', ')}. Use this as ` +
      `context for number separators and currency symbols/codes. DATES: unless the invoice is from the US, ` +
      `a printed date like "02/09/2026" is DAY/MONTH/YEAR — the FIRST number is the DAY, so it means ` +
      `2 September 2026 (2026-09-02), NEVER 9 February. Only US invoices use MM/DD/YYYY. BUT an invoice may ` +
      `still be from another country, so always detect its actual country.\n</contexto_del_tablero>`
    : ''
  return (
    '<instrucciones>\n' +
    'The invoice can be from ANY country and in ANY language, and the file may be a PDF or a ' +
    'photo/scan. Extract each field by its MEANING, not by a specific label. If a field is NOT ' +
    'present, return an empty string "". Do not invent data.\n\n' +
    'CRITICAL: keep seller and buyer strictly separate — supplier_* fields describe ONLY the party ' +
    'issuing the invoice, customer_* fields ONLY the party being billed. Never merge their names, ' +
    'tax IDs or addresses (e.g. do not append the buyer city to the seller address).\n\n' +
    'Dates as YYYY-MM-DD.\n\n' +
    'AMOUNTS — this rule applies to EVERY numeric field without exception (totals, taxes, ' +
    'perceptions, exchange rates, line rows): return the true numeric value with "." as the ONLY ' +
    'decimal separator, with NO thousands separators and NO currency symbol. A returned value must ' +
    'never contain more than one "." and never a ",".\n' +
    'Read the separators by locale — do NOT assume US format: "1.234.567,89" -> 1234567.89 and ' +
    '"1,234,567.89" -> 1234567.89 (if BOTH separators appear, the LAST one is the decimal). ' +
    'A single separator followed by exactly THREE digits is a thousands separator, not a decimal: ' +
    '"1.350,00" -> 1350 and "1.350" -> 1350, NEVER 1.35. Zero-decimal currencies (CLP, JPY, COP, ' +
    'PYG, KRW, ISK, VND...) have NO cents, so "354.172" -> 354172 and "1.166.760" -> 1166760.\n' +
    'Before returning each amount, re-read it: if what you are about to write still carries a comma, ' +
    'or a dot with three digits after it, you have copied the printed text instead of converting it.\n\n' +
    'Currency as a 3-letter ISO 4217 code.\n\n' +
    'TAX IDs: copy every digit exactly as printed. On a scan this line is small and faint — it is ' +
    'the single most misread field, and a tax ID with one wrong digit is worthless, so read it ' +
    'digit by digit. Return only the number and its separators; never include the label ' +
    '("CUIT", "VAT", "RFC") inside the value.\n\n' +
    'Also return detected_country as an ISO 3166-1 alpha-2 code (or "" if unclear). CLASSIFY the ' +
    'document in document_class as EXACTLY one of: "invoice" (a tax invoice / factura / bill), ' +
    '"credit_note" (nota de crédito), "debit_note" (nota de débito), "delivery_note" (a delivery ' +
    'note / remito / nota de entrega: it lists goods and quantities but NO prices to pay, and usually ' +
    'states it is not valid as an invoice), or "other" for anything else — a receipt / ticket, a quote / ' +
    'presupuesto, a purchase order / orden de compra, or an account statement. The tell between an ' +
    'invoice and a delivery note is the money: an invoice has unit prices and a total payable, a ' +
    'delivery note does not.\n' +
    '</instrucciones>' +
    // Guía específica por país (packs) — solo para los países del tablero.
    (promptFor(countries, kind) ? '\n\n<pais>' + promptFor(countries, kind) + '\n</pais>' : '') +
    hintText + lineItemsText +
    '\n\n<campos>\n' + fieldGuide + '\n</campos>' +
    // La consigna va ÚLTIMA: con documentos largos, la pregunta al final
    // mejora bastante la respuesta (guía de long-context de Anthropic).
    '\n\n<tarea>\n' +
    'Work in two steps, in this order.\n\n' +
    'STEP 1 — lineas_clave. Before filling anything else, COPY VERBATIM, character by character ' +
    'exactly as printed, the lines of the document that carry: (a) the document type and its ' +
    'number, (b) the issue date, (c) the issuer tax ID, (d) the recipient tax ID, (e) the ' +
    'authorization code and its expiry. One per line, each prefixed with the label you actually ' +
    'read on the page. Copy what you SEE: do not normalize, do not reorder, do not pad, do not ' +
    'correct anything. Skip any that is not printed.\n\n' +
    'STEP 2 — fill the fields, reading them OFF your own transcription rather than off the image ' +
    'again. This is why step 1 exists: it is the difference between transcribing a number and ' +
    'remembering it.\n' +
    '</tarea>'
  )
}

// Manda el archivo (PDF o imagen, base64) a Claude y devuelve { data, usage, model }.
// mediaType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'.
// hints = { country, currency } de la config, para desambiguar fecha/número/moneda.
export async function extractInvoice(fileBase64, mediaType = 'application/pdf', model = 'claude-sonnet-5', hints = {}) {
  // qrBase64/qrMediaType = el archivo ORIGINAL. A la IA le mandamos las fotos
  // achicadas (no necesita más), pero el QR sí necesita la resolución original.
  const { countries = [], lineItems = false, qrBase64, qrMediaType, docKind = 'fiscal', filePath } = hints
  // Con filePath, los bytes viven en DISCO y no en memoria. Las dos capas que
  // corren DESPUES de la IA (los codigos desde el texto del PDF y el QR) igual
  // necesitan los bytes: se leen del disco una sola vez, y recien cuando se usan.
  // Una copia de 9 MB, contra las tres (~33 MB) del camino base64.
  let bytesCache
  const bytes = () => {
    if (bytesCache === undefined) bytesCache = filePath ? readFileSync(filePath) : fileBase64
    return bytesCache
  }
  // El QR se decodifica DESPUÉS de la llamada a la IA, no en paralelo. En paralelo
  // era más rápido, pero los dos picos de memoria se sumaban y en un archivo pesado
  // el proceso moría. Secuencial, el pico es el mayor de los dos, no la suma.
  // Cuesta ~1-2 s más por factura; vale la pena a cambio de no perder la lectura.
  // Campos = universales + capas de los países configurados (ej. AR agrega CAE, etc.).
  const fields = fieldsForCountries(countries, docKind)
  const schema = buildSchema(fields, lineItems, docKind)

  // Camino GRANDE (filePath): el archivo se subio a disco en vez de venir en
  // memoria. Se sube por la Files API y el mensaje lo referencia por id.
  // Camino CHICO (fileBase64): el de siempre, intacto — es el 95% de los casos y
  // no se toca para no arriesgar lo que ya funciona.
  let uploadedFileId = null
  if (filePath) uploadedFileId = await subirArchivo(filePath)

  // Desde aca va todo en try/finally: si la lectura falla a mitad, el archivo
  // subido tiene que borrarse igual. Sin esto cada error dejaria un archivo
  // colgado en la cuenta de Anthropic, ocupando cuota, para siempre.
  try {

    const fileBlock = uploadedFileId
      ? (mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'file', file_id: uploadedFileId } }
          : { type: 'image', source: { type: 'file', file_id: uploadedFileId } })
      : (mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
          : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } })

    // El endpoint beta se usa SOLO cuando hace falta el header de la Files API. Con
    // base64 seguimos por el estable, para no cambiarle el camino a lo que anda.
    const api = uploadedFileId ? client.beta.messages : client.messages
    const betaOpts = uploadedFileId ? { betas: [FILES_BETA] } : {}

    const res = await api.create({
      ...betaOpts,
      model,
      // 4000 con renglones (una factura de 30+ renglones no entra en 2000 y
      // truncaría el JSON). max_tokens es un tope, no se factura lo no usado.
      max_tokens: lineItems ? 4000 : 2000,
      // Leer una factura es una tarea determinística: el mismo papel tiene que dar
      // siempre el mismo resultado. Por defecto la API va en 1.0 (con variabilidad),
      // que es lo que se quiere para escribir, no para transcribir.
      //
      // OJO: los modelos nuevos (Sonnet 5, Opus 5, la familia 4.6+) RECHAZAN
      // temperature con un 400, y traen "thinking" adaptativo prendido que se come
      // el max_tokens razonando y devuelve el JSON truncado. Por eso van sin
      // temperature y con el thinking apagado explícitamente. Haiku 4.5 no: usa
      // temperature normal y no tiene thinking adaptativo.
      ...paramsDelModelo(model),
      output_config: { format: { type: 'json_schema', schema } },
      // El rol va en el system prompt (recomendación de Anthropic) y explica el PORQUÉ
      // de la regla principal: un dato inventado es peor que uno vacío. Con el motivo
      // el modelo generaliza a los casos que no enumeramos.
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            {
              type: 'text',
              text: buildPrompt(countries, lineItems, docKind),
            },
          ],
        },
      ],
    })

    const text = res.content.find((b) => b.type === 'text')?.text || '{}'
    const data = JSON.parse(text)

    const { warnings } = await postProcesar(data, { mediaType, countries, docKind, leerBytes: bytes, qrBase64, qrMediaType })
    return { data, usage: res.usage, model, warnings }
  } finally {
    if (uploadedFileId) await borrarArchivo(uploadedFileId)
  }
}

// Todo lo que corre DESPUÉS de la IA: capas determinísticas (sin costo) que
// corrigen o completan lo que leyó el modelo. Está separado de extractInvoice para
// que el banco de prueba pueda pasar la salida de CUALQUIER lector —la API real o
// un agente de Claude Code— por exactamente el mismo camino que producción. Si no,
// se compararía lo crudo del agente contra lo corregido de producción.
// Modifica `data` en el lugar. leerBytes() devuelve el archivo (Buffer o base64).
export async function postProcesar(data, { mediaType, countries = [], docKind = 'fiscal', leerBytes, qrBase64, qrMediaType }) {
  const fields = fieldsForCountries(countries, docKind)

  // Los impuestos que no existen en la factura van vacíos, NUNCA en 0 (un 0 en el
  // tablero parece un dato leído). El prompt ya lo pide; esto lo garantiza.
  const zeroed = blankZeros(data)
  if (zeroed.length) console.log('[extractor] impuestos en 0 → vacío:', zeroed.join(', '))

  // Capa determinística: en PDFs con texto, corrige los códigos largos (chave, CUFE,
  // CAE, UUID) que el LLM pudo transcribir mal y las fechas que pudo dar vuelta
  // (02/09 leído como 9 de febrero). Gratis, exacto. No aplica a fotos.
  if (mediaType === 'application/pdf') {
    try {
      const { codes, dates, pv } = await reconcileCodes(data, leerBytes(), fields, [...DATE_FIELDS])
      if (codes.length) console.log('[extractor] códigos corregidos desde el texto del PDF:', codes.join(', '))
      if (dates.length) console.log('[extractor] fechas dadas vuelta corregidas desde el texto del PDF:', dates.join(', '))
      if (pv) console.log(`[extractor] punto de venta ajustado al ancho impreso: ${pv}`)
    } catch (e) { console.warn('[extractor] reconcile contra el PDF falló:', e.message) }
  }

  // Enriquecimiento por país (packs): el QR de la factura pisa los campos fiscales
  // con el dato EXACTO (ej. AR: CUIT, número, total, CAE del QR de AFIP). Ground
  // truth determinístico. El QR se decodifica recién acá (después de la IA) para no
  // sumar los dos picos de memoria.
  // Un remito no tiene QR de AFIP (lleva CAI de imprenta), así que ni se intenta:
  // decodificarlo cuesta memoria y tiempo a cambio de nada.
  const qr = anyPack(countries, docKind) && usaQr(docKind)
    ? await decodeInvoiceQr(qrBase64 || leerBytes(), qrMediaType || mediaType).catch(() => null)
    : null
  const enriched = await enrichAll(data, countries, { fileBase64: qrBase64 || leerBytes(), mediaType: qrMediaType || mediaType, qr }, docKind)

  // Al final de todo: después del enrich, para que si el pack del país ya le puso
  // el nombre canónico (facturas con QR), esto no lo pise con otra cosa — solo
  // empareja el formato de lo que haya quedado.
  data.document_type = normalizarTipoDoc(data.document_type)

  return { warnings: enriched?.warnings || [] }
}