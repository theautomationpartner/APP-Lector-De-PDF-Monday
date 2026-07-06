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
  },
  es: {
    noMapping: 'No hay columnas mapeadas para este tablero (configurá el mapeo en la vista). No se llamó a la IA.',
    noBoard: ({ itemId }) => `No pude determinar el tablero del ítem ${itemId}.`,
    noPdf: 'No encontré ningún PDF ni imagen en una columna de archivo de este ítem. No se llamó a la IA.',
    loaded: ({ model, n }) => `🤖 Lector de Facturas IA (${model}) cargó ${n} columna(s):`,
    failed: ({ msg }) => `⚠️ Lector de Facturas IA no pudo procesar el archivo: ${msg}`,
    duplicate: ({ itemId, date }) => `⏭️ Factura duplicada — ya cargada${date ? ` el ${date}` : ''} (ítem ${itemId}). No se cargó de nuevo.`,
    ignored: ({ taxid }) => `🚫 Ignorada — el ID fiscal ${taxid || '(ilegible)'} no está en la lista permitida de este tablero. No se cargó.`,
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