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
export async function getLatestPdfUrl(token, itemId) {
  const d = await gql(token, `query { items(ids: [${Number(itemId)}]) { column_values { id type value } } }`)
  const cols = d?.items?.[0]?.column_values || []
  const assetIds = []
  for (const c of cols) {
    if (c.type === 'file' && c.value) {
      try {
        const files = JSON.parse(c.value).files || []
        for (const f of files) if (f.assetId) assetIds.push(Number(f.assetId))
      } catch { /* value no parseable */ }
    }
  }
  if (!assetIds.length) return null
  const ad = await gql(token, `query { assets(ids: [${assetIds.join(',')}]) { id name public_url } }`)
  const assets = ad?.assets || []
  const pdfs = assets.filter((a) => /\.pdf$/i.test(a.name || ''))
  const chosen = (pdfs.length ? pdfs : assets).slice(-1)[0] // el último subido
  return chosen?.public_url || null
}

// Tipos de columna del board { columnId: type }.
export async function getColumnTypes(token, boardId) {
  const d = await gql(token, `query { boards(ids: [${Number(boardId)}]) { columns { id type } } }`)
  const cols = d?.boards?.[0]?.columns || []
  return Object.fromEntries(cols.map((c) => [c.id, c.type]))
}

function toNumber(raw) {
  let s = String(raw).replace(/[^\d.,-]/g, '')
  if (!s) return null
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.') // formato AR: 1.234,56
  } else if (s.includes(',')) {
    s = s.replace(',', '.') // 1234,56
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
