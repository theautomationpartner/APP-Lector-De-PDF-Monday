import { NUMERIC_FIELDS, DATE_FIELDS } from './fields.mjs'

const MONDAY_API = 'https://api.monday.com/v2'

// Llamada GraphQL a la API de Monday con el token (shortLivedToken de la receta).
export async function gql(token, query, variables = {}) {
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': '2025-04', // 2024-01 quedó deprecada; nuestras queries son compatibles (verificado contra la guía de migración)
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

// Renombra el ítem (su Name). change_multiple_column_values acepta la
// pseudo-columna "name". Cap 255 (límite de monday). No hace nada si name vacío.
export async function renameItem(token, boardId, itemId, name) {
  const n = String(name || '').trim().slice(0, 255)
  if (!n) return
  const m = `mutation ($b: ID!, $i: ID!, $cv: JSON!) {
    change_multiple_column_values(board_id: $b, item_id: $i, column_values: $cv) { id }
  }`
  await gql(token, m, { b: String(boardId), i: String(itemId), cv: JSON.stringify({ name: n }) })
}

// Nombre y slug de la cuenta dueña del tablero. Sirve para soporte: sin esto solo
// tenemos el ID numérico y no se puede ni armar el link al tablero del cliente
// (https://<slug>.monday.com/boards/<id>). Best-effort: si falla, devuelve null.
export async function getAccountInfo(token) {
  try {
    const d = await gql(token, 'query { me { account { id name slug } } }')
    const a = d?.me?.account
    return a?.id ? { id: String(a.id), name: a.name || '', slug: a.slug || '' } : null
  } catch (e) {
    console.warn('[account] no se pudo leer la cuenta:', e.message)
    return null
  }
}

// Deja un comentario en el item con lo que se cargó.
export async function postComment(token, itemId, body) {
  const m = `mutation ($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }`
  await gql(token, m, { i: String(itemId), b: body })
}

// Resuelve la columna de estado donde la app escribe leyendo / leído / error.
//
// REGLA DE ORO: NUNCA adivinar. Antes esto caía a `cols[0]` (la primera columna de
// estado del ítem) y si el usuario agregaba una columna propia, la app le escribía
// encima y le creaba nuestras etiquetas adentro (bug reportado 2026-08).
//
// Orden: 1) la elegida en el mapeo → 2) si el tablero tiene UNA sola columna de
// estado, esa (no hay nada que adivinar) → 3) ambiguo: no se escribe.
// Devuelve { id, adopted } — adopted = se resolvió por (2) y conviene fijarla.
export async function getStatusColumnId(token, itemId, configuredId = '', ourLabels = [], boardId = null) {
  const d = await gql(token, `query { items(ids: [${Number(itemId)}]) { column_values { id type text } } }`)
  const cols = (d?.items?.[0]?.column_values || []).filter((c) => c.type === 'status' || c.type === 'color')
  if (!cols.length) return { id: null, adopted: false }
  // 1) La elegida por el usuario. Si la eligió y ya NO existe (la borró), no caemos a
  //    otra: sería volver a escribir en una columna que no eligió. Mejor no escribir.
  if (configuredId) {
    return cols.some((c) => c.id === configuredId)
      ? { id: configuredId, adopted: false }
      : { id: null, adopted: false, ambiguous: true }
  }
  // 2) Una sola columna de estado = no hay ambigüedad posible.
  if (cols.length === 1) return { id: cols[0].id, adopted: true }
  // 3) Varias, ninguna elegida: si UNA ya tiene puesta una etiqueta NUESTRA, es esa.
  const conNuestroTexto = cols.filter((c) => ourLabels.includes(String(c.text || '').trim()))
  if (conNuestroTexto.length === 1) return { id: conNuestroTexto[0].id, adopted: true }
  // 4) Si no, miramos las etiquetas DEFINIDAS en cada columna (no el valor de este
  //    ítem). La columna que tiene "Leyendo Comprobante"/"Comprobante Leído" entre sus
  //    opciones es la nuestra, aunque este ítem esté en otro valor. Sin esto, un
  //    tablero con 2 columnas de estado dejaba de escribir el estado en los ítems
  //    nuevos y quedaban trabados en "Leyendo" (caso real, 2026-08).
  if (boardId) {
    try {
      const b = await gql(token, `query { boards(ids: [${Number(boardId)}]) { columns { id type settings_str } } }`)
      const ids = new Set(cols.map((c) => c.id))
      const nuestras = (b?.boards?.[0]?.columns || []).filter((c) => {
        if (!ids.has(c.id)) return false
        const labels = Object.values(JSON.parse(c.settings_str || '{}').labels || {}).map((x) => String(x).trim())
        return ourLabels.some((l) => labels.includes(l))
      })
      if (nuestras.length === 1) return { id: nuestras[0].id, adopted: true }
    } catch { /* si falla, seguimos al caso ambiguo */ }
  }
  // 5) Genuinamente ambiguo: no tocamos nada.
  return { id: null, adopted: false, ambiguous: true }
}

// Setea una etiqueta en una columna de estado (la crea si no existe).
export async function setStatus(token, boardId, itemId, columnId, label) {
  if (!columnId || !label) return
  const m = `mutation ($b: ID!, $i: ID!, $c: String!, $v: String!) {
    change_simple_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v, create_labels_if_missing: true) { id }
  }`
  await gql(token, m, { b: String(boardId), i: String(itemId), c: String(columnId), v: String(label) })
}

// ─── Renglones → subítems ────────────────────────────────────────────────────
// Crea un subítem por renglón de la factura: el NOMBRE es la descripción y las
// columnas Cantidad / Precio unitario / Total van en el tablero de subítems
// (se crean por título si faltan, según el idioma del tablero).
// Las claves son los campos del renglón TAL COMO viajan en el mapeo. Antes eran
// abreviaturas propias (qty, unit…) y solo existían las de factura: un renglón de
// remito nunca escribía unidad, lote ni vencimiento de partida, mapeado o no.
const SUBITEM_COL_TITLES = {
  en: {
    description: 'Description', quantity: 'Qty', unit_price: 'Unit price', bonificacion: 'Discount %',
    subtotal: 'Subtotal', iva: 'VAT %', total: 'Total',
    unidad: 'Unit of measure', codigo: 'Item code', lote: 'Batch / lot',
    vto_partida: 'Batch expiry', deposito: 'Warehouse', envases: 'Containers',
  },
  es: {
    description: 'Descripción', quantity: 'Cantidad', unit_price: 'Precio unitario', bonificacion: 'Bonificación %',
    subtotal: 'Subtotal', iva: 'IVA %', total: 'Total',
    unidad: 'Unidad de medida', codigo: 'Código de artículo', lote: 'Lote',
    vto_partida: 'Vencimiento de partida', deposito: 'Depósito', envases: 'Envases',
  },
}
// Importes y conteos son números, el vencimiento de partida es fecha, el resto texto.
const LI_NUM = new Set(['quantity', 'unit_price', 'bonificacion', 'subtotal', 'iva', 'total', 'envases'])
const LI_DATE = new Set(['vto_partida'])
const liTipo = (f) => (LI_DATE.has(f) ? 'date' : LI_NUM.has(f) ? 'numbers' : 'text')
// Nombre del subítem cuando la descripción va a una columna propia: el usuario
// quiere el Name libre para su nomenclatura, así que ponemos algo neutro.
const LINE_WORD = { en: 'Line', es: 'Renglón' }

// Busca (o crea) por título las columnas pedidas del tablero de subítems.
// keys = campos del renglón ('quantity', 'lote'…). Devuelve { campo: columnId }.
async function ensureSubitemCols(token, subBoardId, lang, keys) {
  const titles = SUBITEM_COL_TITLES[lang] || SUBITEM_COL_TITLES.en
  const d = await gql(token, `query { boards(ids: [${Number(subBoardId)}]) { columns { id title type } } }`)
  const existing = d?.boards?.[0]?.columns || []
  const ids = {}
  for (const key of keys) {
    if (!titles[key]) continue
    const found = existing.find((c) => c.title.toLowerCase() === titles[key].toLowerCase())
    if (found) { ids[key] = found.id; continue }
    const r = await gql(token,
      `mutation ($b: ID!, $t: String!, $y: ColumnType!) { create_column(board_id: $b, title: $t, column_type: $y) { id } }`,
      { b: String(subBoardId), t: titles[key], y: liTipo(key) })
    ids[key] = r.create_column.id
  }
  return ids
}

// Crea los subítems del item según el mapeo del tablero (liMap):
//   quantity/unit_price/total = columnId elegido | '__auto__' (crear por título) | '' (no cargar).
// IDEMPOTENTE: si el item ya tiene subítems (re-disparo), no crea nada.
// Devuelve { created, skipped }.
export async function writeLineItemSubitems(token, itemId, lines, lang = 'en', liMap = {}) {
  const items = (Array.isArray(lines) ? lines : []).filter((l) => (l?.description || '').trim()).slice(0, 50)
  if (!items.length) return { created: 0, skipped: false }
  // Destino de cada métrica según el mapeo ('' = el usuario no la mapeó → no se carga).
  // description = 'name' (default) pone la descripción en el NOMBRE del subítem; si
  // apunta a una columna, el nombre queda neutro ("Renglón 1") para que el usuario
  // use el Name con su propia nomenclatura, y la descripción va a esa columna.
  const descCol = liMap.description && liMap.description !== 'name' ? liMap.description : ''
  const word = LINE_WORD[lang] || LINE_WORD.en
  const nombreDe = (ln, idx) => (descCol ? `${word} ${idx + 1}` : String(ln.description).trim().slice(0, 255))

  // Qué renglones faltan. Comparamos POR NOMBRE, no por cantidad: si el ítem tiene un
  // subítem ajeno (uno que puso el usuario, o basura de otro proceso), contar habría
  // corrido la numeración y se habría salteado el primer renglón real.
  // Esto también permite completar una corrida que se cortó a mitad.
  const pre = await gql(token, `query { items(ids: [${Number(itemId)}]) { subitems { id name } } }`)
  const yaEstan = new Set((pre?.items?.[0]?.subitems || []).map((s) => String(s.name || '').trim()))
  const faltan = items.map((ln, idx) => [idx, ln]).filter(([idx, ln]) => !yaEstan.has(nombreDe(ln, idx)))
  if (!faltan.length) return { created: 0, skipped: true }
  if (yaEstan.size) console.warn(`[subitems] item=${itemId}: ${faltan.length} de ${items.length} renglones faltantes (el ítem ya tenía ${yaEstan.size} subítem(s))`)

  // Todo lo que el usuario mapeó, sea de factura o de remito. 'description' aparte:
  // su destino por defecto es el NOMBRE del subítem, no una columna.
  const want = { description: descCol }
  for (const f of Object.keys(SUBITEM_COL_TITLES.es)) {
    if (f === 'description') continue
    want[f] = liMap[f] || ''
  }
  const autoKeys = Object.entries(want).filter(([, v]) => v === '__auto__').map(([k]) => k)
  let subBoardId = null, autoCols = {}, created = 0
  // Solo los que faltan, cada uno con su índice ORIGINAL (así "Renglón 7" sigue siendo el 7).
  for (const [idx, ln] of faltan) {
    // create_subitem crea la columna "Subitems" en el tablero padre si no existe;
    // la respuesta trae el board del subítem (recién ahí conocemos su id).
    const r = await gql(token,
      `mutation ($p: ID!, $n: String!) { create_subitem(parent_item_id: $p, item_name: $n) { id board { id } } }`,
      { p: String(itemId), n: nombreDe(ln, idx) })
    const subId = r?.create_subitem?.id
    if (!subId) continue
    if (!subBoardId) {
      subBoardId = r.create_subitem.board?.id
      if (subBoardId && autoKeys.length) autoCols = await ensureSubitemCols(token, subBoardId, lang, autoKeys)
    }
    const colOf = (k) => (want[k] === '__auto__' ? autoCols[k] : want[k]) || null
    const cv = {}
    const dc = colOf('description'); if (dc) cv[dc] = String(ln.description).trim().slice(0, 255)
    for (const f of Object.keys(want)) {
      if (f === 'description') continue
      const col = colOf(f); if (!col) continue
      const crudo = ln[f]
      if (crudo == null || String(crudo).trim() === '') continue
      if (LI_NUM.has(f)) { const n = toNumber(crudo); if (n != null) cv[col] = String(n); continue }
      // Fecha: monday la quiere como objeto y solo acepta AAAA-MM-DD.
      if (LI_DATE.has(f)) { const d = String(crudo).trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) cv[col] = { date: d }; continue }
      cv[col] = String(crudo).trim().slice(0, 255)
    }
    if (Object.keys(cv).length && subBoardId) {
      await gql(token,
        `mutation ($b: ID!, $i: ID!, $cv: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $cv) { id } }`,
        { b: String(subBoardId), i: String(subId), cv: JSON.stringify(cv) })
    }
    created++
  }
  return { created, skipped: false }
}
