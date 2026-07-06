import { NUMERIC_FIELDS, DATE_FIELDS } from './fields.mjs'

const MONDAY_API = 'https://api.monday.com/v2'

// Llamada GraphQL a la API de Monday con el token (shortLivedToken de la receta).
export async function gql(token, query, variables = {}) {
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  })
  const j = await r.json()
  if (j.errors) throw new Error('Monday API: ' + JSON.stringify(j.errors).slice(0, 400))
  return j.data
}

// Deduce el boardId a partir del item (el trigger "status changes" no manda boardId).
export async function getBoardIdFromItem(token, itemId) {
  const d = await gql(token, `query { items(ids: [${Number(itemId)}]) { board { id } } }`)
  return d?.items?.[0]?.board?.id || null
}

// Busca el PDF más reciente subido a alguna columna de archivo del item.
// Tipos de archivo que Claude puede leer (PDF + imágenes).
const SUPPORTED_MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp',
}
const mimeOf = (name = '') => {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/)
  return m ? (SUPPORTED_MIME[m[1]] || null) : null
}

// Devuelve { url, mediaType } del último archivo soportado (PDF o imagen/foto) del
// item. preferredColumnId = columna de archivo elegida en la config (si no, todas).
export async function getLatestFileUrl(token, itemId, preferredColumnId = '') {
  const d = await gql(token, `query { items(ids: [${Number(itemId)}]) { column_values { id type value } } }`)
  const allCols = d?.items?.[0]?.column_values || []
  const fileCols = allCols.filter((c) => c.type === 'file' && c.value)
  let cols = fileCols
  if (preferredColumnId) {
    const pref = fileCols.filter((c) => c.id === preferredColumnId)
    cols = pref.length ? pref : fileCols
  }
  const assetIds = []
  for (const c of cols) {
    try {
      const files = JSON.parse(c.value).files || []
      for (const f of files) if (f.assetId) assetIds.push(Number(f.assetId))
    } catch { /* value no parseable */ }
  }
  if (!assetIds.length) return null
  const ad = await gql(token, `query { assets(ids: [${assetIds.join(',')}]) { id name public_url } }`)
  const supported = (ad?.assets || [])
    .map((a) => ({ ...a, mime: mimeOf(a.name) || mimeOf(a.public_url) }))
    .filter((a) => a.mime)
  if (!supported.length) return null
  const pdfs = supported.filter((a) => a.mime === 'application/pdf')
  const chosen = (pdfs.length ? pdfs : supported).slice(-1)[0] // preferí PDF; si no, la última imagen
  return { url: chosen.public_url, mediaType: chosen.mime }
}

// Tipos de columna del board { columnId: type }.
export async function getColumnTypes(token, boardId) {
  const d = await gql(token, `query { boards(ids: [${Number(boardId)}]) { columns { id type } } }`)
  const cols = d?.boards?.[0]?.columns || []
  return Object.fromEntries(cols.map((c) => [c.id, c.type]))
}

// Normaliza montos de cualquier locale a número JS. Red de seguridad por si la IA
// devuelve el separador dudoso (ej. Chile "354.172" = 354172, no 354.172).
function toNumber(raw) {
  let s = String(raw).replace(/[^\d.,-]/g, '')
  if (!s) return null
  const hasDot = s.includes('.'), hasComma = s.includes(',')
  if (hasDot && hasComma) {
    // el separador que aparece ÚLTIMO es el decimal; el otro es de miles
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.') // 1.234,56
    else s = s.replace(/,/g, '')                                                            // 1,234.56
  } else if (hasComma) {
    const p = s.split(',')
    s = (p.length === 2 && p[1].length <= 2) ? p[0] + '.' + p[1] : s.replace(/,/g, '')       // 1234,56 vs 1,234 (miles)
  } else if (hasDot) {
    const p = s.split('.')
    if (!(p.length === 2 && p[1].length <= 2)) s = s.replace(/\./g, '')                      // 354.172 / 1.234.567 = miles
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function toDate(raw) {
  const s = String(raw).trim()
  // ISO YYYY-MM-DD (lo que ya devuelve Claude).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  // Fallback DD/MM/AAAA (o con - o .) por si llega sin normalizar.
  const m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
  if (!m) return null
  let [, d, mo, y] = m
  if (y.length === 2) y = '20' + y
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

// Arma el objeto column_values según el tipo de cada columna mapeada.
export function buildColumnValues(mapping, data, colTypes) {
  const cv = {}
  for (const [field, colId] of Object.entries(mapping || {})) {
    if (!colId) continue
    const raw = (data[field] ?? '').toString().trim()
    if (!raw) continue
    const type = colTypes[colId]
    if (type === undefined) continue // la columna ya no existe en el tablero → ignorar (no romper todo el write)
    if (NUMERIC_FIELDS.has(field) || type === 'numbers' || type === 'numeric') {
      const n = toNumber(raw)
      if (n != null) cv[colId] = String(n)
    } else if (DATE_FIELDS.has(field) || type === 'date') {
      const dd = toDate(raw)
      if (dd) cv[colId] = { date: dd }
    } else if (type === 'status' || type === 'color') {
      cv[colId] = { label: raw }
    } else if (type === 'dropdown') {
      cv[colId] = { labels: [raw] }
    } else {
      cv[colId] = raw // text, long_text, name, etc.
    }
  }
  return cv
}

// Escribe los valores en las columnas del item (crea labels de status/dropdown si faltan).
export async function writeColumns(token, boardId, itemId, cv) {
  if (!Object.keys(cv).length) return
  const m = `mutation ($b: ID!, $i: ID!, $cv: JSON!) {
    change_multiple_column_values(board_id: $b, item_id: $i, column_values: $cv, create_labels_if_missing: true) { id }
  }`
  await gql(token, m, { b: String(boardId), i: String(itemId), cv: JSON.stringify(cv) })
}

// Deja un comentario en el item con lo que se cargó.
export async function postComment(token, itemId, body) {
  const m = `mutation ($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }`
  await gql(token, m, { i: String(itemId), b: body })
}

// Encuentra la columna de estado del item (preferentemente la que disparó la receta).
export async function getStatusColumnId(token, itemId, preferredLabels = []) {
  const d = await gql(token, `query { items(ids: [${Number(itemId)}]) { column_values { id type text } } }`)
  const cols = (d?.items?.[0]?.column_values || []).filter((c) => c.type === 'status' || c.type === 'color')
  if (!cols.length) return null
  const preferred = cols.find((c) => preferredLabels.includes((c.text || '').trim()))
  return (preferred || cols[0]).id
}

// Setea una etiqueta en una columna de estado (la crea si no existe).
export async function setStatus(token, boardId, itemId, columnId, label) {
  if (!columnId || !label) return
  const m = `mutation ($b: ID!, $i: ID!, $c: String!, $v: String!) {
    change_simple_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v, create_labels_if_missing: true) { id }
  }`
  await gql(token, m, { b: String(boardId), i: String(itemId), c: String(columnId), v: String(label) })
}
