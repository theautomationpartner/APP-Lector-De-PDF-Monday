// i18n del backend: textos que la app ESCRIBE en el board (comentarios + estados),
// en el idioma de la instalación (EN por defecto).

const dict = {
  en: {
    noMapping: 'No columns are mapped for this board (set the mapping in the view). The AI was not called.',
    noBoard: ({ itemId }) => `Could not determine the board for item ${itemId}.`,
    noPdf: 'No PDF or image was found in a file column of this item. The AI was not called.',
    loaded: ({ model, n }) => `🤖 AI Invoice Reader (${model}) filled ${n} column(s):`,
    failed: ({ msg }) => `⚠️ AI Invoice Reader could not process the file: ${msg}`,
    duplicate: ({ itemId, date }) => `⏭️ Duplicate invoice — already loaded${date ? ` on ${date}` : ''} (item ${itemId}). Not loaded again.`,
    ignored: ({ taxid }) => `🚫 Ignored — tax ID ${taxid || '(unreadable)'} is not in this board's allowed list. Not loaded.`,
    fileTooBig: ({ mb }) => `The file is larger than ${mb} MB. Please upload a smaller PDF or image.`,
    internalError: 'temporary internal error — please try again in a few minutes.',
    busy: 'Too many invoices are being read at once. Please try this one again in a few minutes.',
    limitReached: ({ n }) => `This account reached its monthly limit of ${n} invoices. It resets next month.`,
    subitemsLoaded: ({ n }) => `• ${n} line item(s) loaded as subitems`,
    notFiscalDoc: ({ type }) => `🚫 Ignored — this looks like "${type}", not an invoice, credit note or debit note. Not loaded.`,
    statusAmbiguous: 'ℹ️ This board has more than one status column, so the reading status was not written (we never write in a column you didn’t pick). Choose it in the app → Rules → “Update the status”.',
    warnCae: ({ cae, n }) => `⚠️ Check the CAE: it has ${n} digits and it should have 14 — read as "${cae}". The QR code could not be read on this file, so it came from the image.`,
    warnSum: ({ sum, total, diff }) => `⚠️ Check the amounts: the breakdown adds up to ${sum} but the total is ${total} (off by ${diff}).`,
    warnCuit: ({ cuit, quien }) => `⚠️ Check the ${quien === 'emisor' ? 'issuer' : 'recipient'} tax ID: "${cuit}" fails its check digit, so those digits cannot be a real CUIT. It was read off the image — compare it with the document.`,
    warnFilterUnreadable: ({ id }) => `⚠️ Couldn't read the recipient's tax ID clearly${id ? ` (got "${id}")` : ''}, so the "only my invoices" rule was skipped and the invoice was loaded anyway. Please check it.`,
    warnFilterClose: ({ id, esperado }) => `⚠️ Read the tax ID as "${id}", which is almost your "${esperado}" — most likely a misread, so the invoice was loaded anyway. Please check it.`,
  },
  es: {
    noMapping: 'No hay columnas mapeadas para este tablero (configurá el mapeo en la vista). No se llamó a la IA.',
    noBoard: ({ itemId }) => `No pude determinar el tablero del ítem ${itemId}.`,
    noPdf: 'No encontré ningún PDF ni imagen en una columna de archivo de este ítem. No se llamó a la IA.',
    loaded: ({ model, n }) => `🤖 Lector de Facturas IA (${model}) cargó ${n} columna(s):`,
    failed: ({ msg }) => `⚠️ Lector de Facturas IA no pudo procesar el archivo: ${msg}`,
    duplicate: ({ itemId, date }) => `⏭️ Factura duplicada — ya cargada${date ? ` el ${date}` : ''} (ítem ${itemId}). No se cargó de nuevo.`,
    ignored: ({ taxid }) => `🚫 Ignorada — el ID fiscal ${taxid || '(ilegible)'} no está en la lista permitida de este tablero. No se cargó.`,
    fileTooBig: ({ mb }) => `El archivo pesa más de ${mb} MB. Subí un PDF o imagen más liviano.`,
    internalError: 'error interno temporal — probá de nuevo en unos minutos.',
    busy: 'Se están leyendo demasiados comprobantes a la vez. Probá este de nuevo en unos minutos.',
    limitReached: ({ n }) => `Esta cuenta llegó a su límite mensual de ${n} facturas. Se renueva el mes próximo.`,
    subitemsLoaded: ({ n }) => `• ${n} renglón(es) cargados como subelementos`,
    notFiscalDoc: ({ type }) => `🚫 Ignorada — parece "${type}", no una factura, nota de crédito o nota de débito. No se cargó.`,
    statusAmbiguous: 'ℹ️ Este tablero tiene más de una columna de estado, así que no escribí el estado de la lectura (nunca escribimos en una columna que no elegiste). Elegila en la app → Reglas → “Actualizar el estado”.',
    warnCae: ({ cae, n }) => `⚠️ Revisá el CAE: tiene ${n} dígitos y debería tener 14 — leí "${cae}". En este archivo no se pudo leer el código QR, así que salió de la imagen.`,
    warnSum: ({ sum, total, diff }) => `⚠️ Revisá los importes: el desglose suma ${sum} pero el total es ${total} (diferencia ${diff}).`,
    warnCuit: ({ cuit, quien }) => `⚠️ Revisá el CUIT del ${quien}: "${cuit}" no pasa el dígito verificador, así que esos números no pueden ser un CUIT real. Salió de la imagen — comparalo con el comprobante.`,
    warnFilterUnreadable: ({ id }) => `⚠️ No pude leer bien el CUIT del receptor${id ? ` (leí "${id}")` : ''}, así que no apliqué la regla "solo mis facturas" y cargué la factura igual. Revisala.`,
    warnFilterClose: ({ id, esperado }) => `⚠️ Leí el CUIT "${id}", que es casi igual al tuyo "${esperado}" — lo más probable es que esté mal leído, así que cargué la factura igual. Revisala.`,
  },
}

export function t(lang, key, vars) {
  const d = dict[lang] || dict.en
  const v = d[key] ?? dict.en[key]
  return typeof v === 'function' ? v(vars || {}) : v
}

// Etiquetas del ciclo de vida de la columna de estado.
const lifecycle = {
  en: { processing: 'Reading invoice', done: 'Invoice read', error: 'Error - see comments', duplicate: 'Duplicate', ignored: 'Ignored' },
  es: { processing: 'Leyendo Comprobante', done: 'Comprobante Leído', error: 'Error - Mirar Comentarios', duplicate: 'Duplicada', ignored: 'Ignorada' },
}
export function lifecycleLabels(lang) {
  return lifecycle[lang] || lifecycle.en
}