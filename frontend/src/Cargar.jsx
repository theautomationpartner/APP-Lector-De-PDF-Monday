// Vista "Cargar comprobante" — la pantalla del operador (la de Configuración es del
// admin y se toca una vez). Se sirve en /cargar desde el mismo bundle.
//
// NO LEE NADA. Crea el ítem, le pone el archivo y le cambia el estado a la etiqueta
// que dispara la receta del tablero. De ahí en más es la lectura de siempre
// (/monday/extract): mismo motor, mismos logs, mismo antiduplicados.
//
// Límites de monday que definen el flujo (verificados, ver memoria del proyecto):
//  · El navegador no puede subir archivos con monday.api(): la subida es la ventana
//    nativa de monday (triggerFilesUpload), y esa ventana exige que el ítem EXISTA.
//    Por eso el archivo recién se ve después de crear el ítem; si no sirve, se borra.
//  · monday no expone las automatizaciones: la etiqueta que dispara se aprende (el
//    server la guarda cada vez que la receta corre), se deduce (las etiquetas de la
//    columna menos las nuestras) o, si hay dudas, se pregunta una vez.
import { useEffect, useMemo, useRef, useState } from 'react'
import mondaySdk from 'monday-sdk-js'
import { makeT } from './i18n.js'

const monday = mondaySdk()

// Lo mismo que acepta la lectura (backend/monday.mjs → SUPPORTED_MIME) y su tope.
const LEIBLES = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp'])
const MAX_MB = 20
// Si el ítem sigue en la etiqueta que dispara pasado este tiempo, la receta no corrió.
const SIN_ARRANCAR_MS = 30_000
// Estados en los que la lectura ya terminó: se deja de preguntar.
const FINALES = new Set(['done', 'warned', 'error', 'duplicate', 'ignored', 'gone'])
const MAX_RECIENTES = 12
// Nombre del ítem mientras espera el archivo, en los dos idiomas: así se reconocen
// las subidas a medias de cualquiera, no solo las de este navegador.
const PLACEHOLDERS = new Set([makeT('es')('up.placeholderName'), makeT('en')('up.placeholderName')])
// Una subida propia pasa a "abandonada" si su pestaña deja de latir este tiempo.
const LATIDO_MS = 2000
const SIN_LATIDO_MS = 6000
// Y una ajena, pasado este tiempo desde que se creó el ítem. Más que el tope de
// espera de la vista (15 min): a esa altura la dueña ya la dio por perdida.
const AJENA_VIEJA_MS = 16 * 60_000
// Identifica a ESTA pestaña: dos pestañas abiertas no se pisan las subidas.
const YO = Math.random().toString(36).slice(2)

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
// monday.api a veces RESUELVE con el error adentro en vez de fallar: sin este chequeo,
// un "no tenés permiso" pasaba como éxito y el flujo seguía con un ítem que no existe.
async function api(q, variables) {
  const r = await monday.api(q, variables ? { variables } : undefined)
  if (r?.errors?.length || r?.error_message) throw new Error(r.errors?.[0]?.message || r.error_message)
  return r
}
async function sessionToken() {
  try { return (await monday.get('sessionToken'))?.data || null } catch { return null }
}
const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def } catch { return def } }
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* noop */ } }
const msgDe = (e) => String(e?.message || e?.errors?.[0]?.message || e || '').slice(0, 160)

// Etiquetas definidas en una columna de estado (no el valor de un ítem).
function etiquetasDe(col) {
  try {
    const l = JSON.parse(col?.settings_str || '{}').labels || {}
    const vals = Array.isArray(l) ? l : Object.values(l)
    return [...new Set(vals.map((x) => String(typeof x === 'string' ? x : x?.name || '').trim()).filter(Boolean))]
  } catch { return [] }
}

export default function Cargar() {
  const [ctx, setCtx] = useState(null)
  const [board, setBoard] = useState(null)     // { name, columns }
  const [cfg, setCfg] = useState(null)         // GET /api/config
  const [usage, setUsage] = useState(null)     // GET /api/usage
  const [falla, setFalla] = useState('')       // no se pudo cargar la vista
  const [paso, setPaso] = useState(null)       // null | creating | waiting | checking
  const [aviso, setAviso] = useState(null)     // { tipo: ok|err|info, texto }
  const [recientes, setRecientes] = useState([])
  const [labelElegida, setLabelElegida] = useState('')
  const [ahora, setAhora] = useState(Date.now())
  const cancelado = useRef(false)
  const itemEnCurso = useRef(null)

  const boardId = ctx?.boardId || ctx?.boardIds?.[0] || null
  const lang = cfg?.language || leer('air_lang', null) || (ctx?.user?.currentLanguage === 'es' ? 'es' : 'en')
  const t = useMemo(() => makeT(lang), [lang])
  const kind = cfg?.docKind === 'remito' ? 'remito' : 'fiscal'
  const kPend = `air_up_pend:${boardId}`
  const kRec = `air_up_rec:${boardId}`

  // 1) Contexto de monday.
  useEffect(() => {
    const off = monday.listen('context', (r) => setCtx(r.data))
    return () => { try { off() } catch { /* noop */ } }
  }, [])

  // Soltar un archivo sobre la vista: el navegador lo abriría ENCIMA de la vista (y
  // se pierde la pantalla). No se puede subir desde acá — el archivo va directo a
  // monday por su ventana —, así que se frena y se explica dónde soltarlo.
  useEffect(() => {
    const frenar = (e) => { e.preventDefault() }
    const soltar = (e) => { e.preventDefault(); setAviso({ tipo: 'info', texto: 'drop' }) }
    window.addEventListener('dragover', frenar)
    window.addEventListener('drop', soltar)
    return () => { window.removeEventListener('dragover', frenar); window.removeEventListener('drop', soltar) }
  }, [])

  // 2) Tablero + config + uso. Todo antes de dejar subir nada.
  useEffect(() => {
    if (!boardId) return
    let vivo = true
    ;(async () => {
      try {
        const [b, tok] = await Promise.all([
          api(`query { boards(ids: [${Number(boardId)}]) { name columns { id title type settings_str } } }`),
          sessionToken(),
        ])
        const h = tok ? { Authorization: tok } : {}
        const [rc, ru] = await Promise.all([fetch(`/api/config/${boardId}`, { headers: h }), fetch('/api/usage', { headers: h })])
        if (!vivo) return
        setBoard(b?.data?.boards?.[0] || { name: '', columns: [] })
        setCfg(rc.ok ? await rc.json() : { mapping: {} })
        setUsage(ru.ok ? await ru.json() : null)
        setRecientes(leer(kRec, []))
      } catch (e) { if (vivo) setFalla(msgDe(e)) }
    })()
    return () => { vivo = false }
  }, [boardId])

  // 3) Qué columna, qué etiqueta, y si hay algo que impida subir. Cada chequeo que
  //    se puede hacer ANTES de crear el ítem se hace acá: si falla, no se crea nada.
  const plan = useMemo(() => {
    if (!board || !cfg) return null
    const cols = board.columns || []
    const bloqueo = (key, vars) => ({ bloqueo: { key, vars } })
    if (ctx?.user?.isViewOnly) return bloqueo('up.blk.viewOnly')
    if (!Object.values(cfg.mapping || {}).some(Boolean)) return bloqueo('up.blk.config')

    const archivos = cols.filter((c) => c.type === 'file')
    const fileCol = archivos.find((c) => c.id === cfg.fileColumnId) || (archivos.length === 1 ? archivos[0] : null)
    if (!fileCol) return bloqueo(archivos.length ? 'up.blk.manyFile' : 'up.blk.noFile')

    // Misma lógica que el server (getStatusColumnId): la elegida, la única, o la que
    // tiene nuestras etiquetas entre sus opciones. Nunca se adivina entre varias.
    const nuestras = cfg.ourLabels || {}
    const estados = cols.filter((c) => c.type === 'status' || c.type === 'color')
    const conNuestras = estados.filter((c) => etiquetasDe(c).some((l) => l in nuestras))
    const statusCol = estados.find((c) => c.id === cfg.statusColumnId)
      || (estados.length === 1 ? estados[0] : conNuestras.length === 1 ? conNuestras[0] : null)
    if (!statusCol) return bloqueo(estados.length ? 'up.blk.manyStatus' : 'up.blk.noStatus')

    // Etiqueta: la aprendida (si sigue existiendo) → la única que no es nuestra → preguntar.
    const opciones = etiquetasDe(statusCol)
    const candidatas = opciones.filter((l) => !(l in nuestras))
    let label = opciones.includes(cfg.triggerLabel) ? cfg.triggerLabel : ''
    if (!label && candidatas.length === 1) label = candidatas[0]
    if (!label && !candidatas.length) return bloqueo('up.blk.noLabel', { col: statusCol.title })

    if (usage?.limit != null && usage.month >= usage.limit) return bloqueo('up.blk.limit', { month: usage.month, limit: usage.limit })
    return { fileCol, statusCol, label, preguntar: label ? null : candidatas }
  }, [board, cfg, usage, ctx])

  // ── Estado de un ítem → qué le mostramos al usuario ──
  const clasificar = (texto) => {
    const nuestras = cfg?.ourLabels || {}
    if (texto in nuestras) return nuestras[texto]
    if (texto && texto === plan?.label) return 'sent'
    return 'other'
  }

  // 4) Subidas que quedaron a medias. Pasa cuando alguien se va de la vista con la
  //    ventana de subida abierta (monday recarga la vista al volver) o cierra el
  //    navegador. Dos fuentes:
  //    · las de ESTE navegador cuya pestaña dejó de latir (se fue a mitad de camino);
  //    · cualquier "⏳ Subiendo…" del tablero con más de 16 min (otra persona, otra
  //      computadora, o alguien que nunca volvió).
  //    Sin archivo o con uno que no sirve → se borra. Con un archivo que sirve → se
  //    termina: nombre + etiqueta, y arranca la lectura. Nunca queda a medias.
  const barrido = useRef(false)
  useEffect(() => {
    if (!plan?.label || barrido.current) return
    barrido.current = true
    ;(async () => {
      const propias = leer(kPend, [])
        .filter((p) => p.owner !== YO && Date.now() - (p.beat || p.at) > SIN_LATIDO_MS)
        .map((p) => p.id)
      let ajenas = []
      try {
        const r = await api(`query { boards(ids: [${Number(boardId)}]) { items_page(limit: 50, query_params: { rules: [{ column_id: "name", compare_value: ["⏳"], operator: contains_text }] }) { items { id name created_at } } } }`)
        ajenas = (r?.data?.boards?.[0]?.items_page?.items || [])
          .filter((i) => PLACEHOLDERS.has(i.name) && Date.now() - new Date(i.created_at).getTime() > AJENA_VIEJA_MS)
          .map((i) => String(i.id))
      } catch { /* sin barrido del tablero: igual se atienden las de este navegador */ }
      const ids = [...new Set([...propias, ...ajenas])]
      if (!ids.length) return
      const terminados = []
      let borrados = 0
      for (const id of ids) {
        const res = await terminar(id).catch(() => null)
        if (res?.ok) terminados.push(res.ok)
        else if (res?.borrado) borrados++
      }
      guardar(kPend, leer(kPend, []).filter((p) => !ids.includes(p.id)))
      if (terminados.length) setAviso({ tipo: 'info', texto: t('up.resumed', { names: terminados.join(', ') }) })
      else if (borrados) setAviso({ tipo: 'info', texto: t('up.cleaned', { n: borrados }) })
    })()
  }, [plan?.label])

  // Latido de la subida en curso: mientras esta pestaña espera el archivo, marca que
  // sigue viva. Si deja de marcar, la próxima vez que se abra la vista se la atiende.
  useEffect(() => {
    if (paso !== 'waiting' && paso !== 'checking') return
    const latir = () => {
      const id = itemEnCurso.current
      if (id) guardar(kPend, leer(kPend, []).map((p) => (p.id === id ? { ...p, beat: Date.now() } : p)))
    }
    latir()
    const h = setInterval(latir, LATIDO_MS)
    return () => clearInterval(h)
  }, [paso])

  // 5) Seguimiento de los últimos cargados: pregunta el estado cada 4 s mientras
  //    alguno siga en curso (y como mucho 10 min después de mandarlo).
  useEffect(() => {
    if (!plan?.statusCol) return
    const activos = recientes.filter((r) => !FINALES.has(r.kind) && Date.now() - r.sentAt < 10 * 60_000)
    if (!activos.length) return
    const id = setTimeout(async () => {
      try {
        const r = await api(`query { items(ids: [${activos.map((a) => Number(a.id)).join(',')}]) { id name column_values(ids: ["${plan.statusCol.id}"]) { text } } }`)
        const vivos = Object.fromEntries((r?.data?.items || []).map((i) => [String(i.id), i]))
        setRecientes((prev) => {
          const next = prev.map((x) => {
            if (!activos.some((a) => a.id === x.id)) return x
            const it = vivos[x.id]
            if (!it) return { ...x, kind: 'gone' }
            const texto = String(it.column_values?.[0]?.text || '').trim()
            return { ...x, name: it.name || x.name, texto, kind: clasificar(texto) }
          })
          guardar(kRec, next)
          return next
        })
      } catch { /* se reintenta en la próxima vuelta */ }
      setAhora(Date.now())
    }, 4000)
    return () => clearTimeout(id)
  }, [recientes, plan?.statusCol?.id, ahora])

  // ── Archivos de la columna del ítem: [{ name, ext, size }] · [] sin archivo · null si el ítem ya no existe.
  async function archivosDe(itemId) {
    const r = await api(`query { items(ids: [${Number(itemId)}]) { id column_values(ids: ["${plan.fileCol.id}"]) { value } } }`)
    const it = r?.data?.items?.[0]
    if (!it) return null
    let files = []
    try { files = JSON.parse(it.column_values?.[0]?.value || '{}').files || [] } catch { /* vacío */ }
    if (!files.length) return []
    const ids = files.map((f) => f.assetId).filter(Boolean)
    // Un link (Drive, Dropbox) no es un archivo subido: la lectura no lo puede bajar.
    if (!ids.length) return files.map((f) => ({ name: f.name || 'link', ext: 'link', size: 0 }))
    const a = await api(`query { assets(ids: [${ids.map(Number).join(',')}]) { id name file_extension file_size } }`)
    return (a?.data?.assets || []).map((x) => ({
      name: x.name,
      ext: String(x.file_extension || String(x.name).split('.').pop() || '').replace('.', '').toLowerCase(),
      size: Number(x.file_size) || 0,
    }))
  }

  const olvidarPendiente = (id) => guardar(kPend, leer(kPend, []).filter((p) => p.id !== id))
  const borrar = (id) => api(`mutation { delete_item(item_id: ${Number(id)}) { id } }`).catch(() => {})

  async function descartar(id, texto) {
    await borrar(id)
    olvidarPendiente(id)
    itemEnCurso.current = null
    setPaso(null)
    setAviso({ tipo: 'err', texto })
  }

  async function cancelar() {
    const id = itemEnCurso.current
    cancelado.current = true
    itemEnCurso.current = null
    setPaso(null)
    if (id) { await borrar(id); olvidarPendiente(id) }
    setAviso({ tipo: 'info', texto: t('up.cancelled') })
  }

  // ── El flujo: crear → ventana de monday → revisar el archivo → disparar ──
  async function subir() {
    if (!plan?.label || paso) return
    setAviso(null)
    cancelado.current = false
    setPaso('creating')
    let id
    try {
      const r = await api(`mutation ($b: ID!, $n: String!) { create_item(board_id: $b, item_name: $n) { id } }`,
        { b: String(boardId), n: t('up.placeholderName') })
      id = String(r?.data?.create_item?.id || '')
      if (!id) throw new Error('sin id')
    } catch (e) {
      setPaso(null)
      setAviso({ tipo: 'err', texto: t('up.err.create', { msg: msgDe(e) }) })
      return
    }
    itemEnCurso.current = id
    guardar(kPend, [...leer(kPend, []), { id, at: Date.now(), beat: Date.now(), owner: YO }])
    setPaso('waiting')

    // La ventana de subida es de monday. Si no se puede abrir, no queda nada creado.
    monday.execute('triggerFilesUpload', { boardId: Number(boardId), itemId: Number(id), columnId: plan.fileCol.id })
      .catch(() => { if (itemEnCurso.current === id) descartar(id, t('up.err.modal')) })

    // Esperar el archivo. Se pregunta cada 1,5 s; cuando aparece, se espera a que la
    // cantidad deje de cambiar (si eligió varios, monday los sube de a uno).
    const inicio = Date.now()
    let visto = -1
    while (!cancelado.current && itemEnCurso.current === id && Date.now() - inicio < 15 * 60_000) {
      await dormir(1500)
      if (cancelado.current || itemEnCurso.current !== id) return
      let arch
      try { arch = await archivosDe(id) } catch { continue }
      if (arch === null) { itemEnCurso.current = null; olvidarPendiente(id); setPaso(null); return } // lo borraron
      if (!arch.length) continue
      if (arch.length !== visto) { visto = arch.length; setPaso('checking'); continue }
      return revisarYDisparar(id, arch)
    }
    if (!cancelado.current && itemEnCurso.current === id) descartar(id, t('up.err.timeout'))
  }

  // El archivo recién se ve después de la ventana de monday. Devuelve el motivo por
  // el que NO se puede leer, o null si sirve. Lo que no sirve se borra en vez de
  // dejar un ítem que va a terminar en error.
  function problemaDe(arch) {
    if (arch.length > 1) return t('up.err.many', { n: arch.length })
    const f = arch[0]
    if (f.ext === 'link') return t('up.err.link')
    if (f.ext === 'heic' || f.ext === 'heif') return t('up.err.heic', { name: f.name })
    if (!LEIBLES.has(f.ext)) return t('up.err.type', { name: f.name })
    if (f.size > MAX_MB * 1048576) return t('up.err.big', { name: f.name, mb: (f.size / 1048576).toFixed(1) })
    return null
  }

  // Nombre del archivo + etiqueta que dispara, en UNA sola escritura (nunca queda
  // renombrado sin disparar, ni disparado con "⏳ Subiendo…"). Sin
  // create_labels_if_missing: si la etiqueta no existe, inventarla no dispararía nada.
  async function disparar(id, f) {
    await api(`mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
      { b: String(boardId), i: id, v: JSON.stringify({ name: f.name, [plan.statusCol.id]: { label: plan.label } }) })
    setRecientes((prev) => {
      const next = [{ id, name: f.name, sentAt: Date.now(), texto: plan.label, kind: 'sent' }, ...prev.filter((x) => x.id !== id)].slice(0, MAX_RECIENTES)
      guardar(kRec, next)
      return next
    })
  }

  // Cierra una subida a medias: { ok: nombre } si se mandó a leer, { borrado } si se
  // borró (vacía o con un archivo que no sirve), null si el ítem ya no existe.
  async function terminar(id) {
    const arch = await archivosDe(id)
    if (arch === null) return null
    if (!arch.length || problemaDe(arch)) { await borrar(id); return { borrado: true } }
    await disparar(id, arch[0])
    return { ok: arch[0].name }
  }

  async function revisarYDisparar(id, arch) {
    const problema = problemaDe(arch)
    if (problema) return descartar(id, problema)
    const f = arch[0]
    try {
      await disparar(id, f)
    } catch (e) {
      // El archivo es válido: el ítem se deja (tiene el archivo del usuario) y se avisa.
      olvidarPendiente(id); itemEnCurso.current = null; setPaso(null)
      return setAviso({ tipo: 'err', texto: t('up.err.status', { label: plan.label, msg: msgDe(e) }) })
    }
    olvidarPendiente(id)
    itemEnCurso.current = null
    setPaso(null)
    setAviso({ tipo: 'ok', texto: t('up.sentOk', { name: f.name }) })
  }

  async function usarEtiqueta() {
    if (!labelElegida) return
    const tok = await sessionToken()
    await fetch(`/api/config/${boardId}/trigger-label`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: tok } : {}) },
      body: JSON.stringify({ label: labelElegida }),
    }).catch(() => {})
    setCfg((c) => ({ ...c, triggerLabel: labelElegida }))
  }

  // ── Pantalla ──
  if (!ctx) return <div className="splash"><div className="splash-logo">AI</div><div className="splash-spinner" /></div>
  if (!boardId) return <div className="up"><div className="up-card up-blk">{t('up.blk.noBoard')}</div></div>
  if (falla) return <div className="up"><div className="up-card up-blk err">{t('up.err.load', { msg: falla })}</div></div>
  if (!plan) return <div className="splash"><div className="splash-logo">AI</div><div className="splash-spinner" /></div>

  const usoTxt = usage ? (usage.limit != null ? t('up.usage', { month: usage.month, limit: usage.limit }) : t('up.usageUnlimited', { month: usage.month })) : ''

  return (
    <div className="up">
      <div className="up-head">
        <div className="up-brand"><span className="sb-logo">AI</span><span>{t(kind === 'remito' ? 'up.title.remito' : 'up.title.fiscal')}</span></div>
        {usoTxt && <span className="up-usage">{usoTxt}</span>}
      </div>

      {plan.bloqueo && <div className="up-card up-blk">{t(plan.bloqueo.key, plan.bloqueo.vars)}</div>}

      {plan.preguntar && (
        <div className="up-card">
          <div className="up-ask-title">{t('up.ask.title')}</div>
          <div className="up-ask-help">{t('up.ask.help', { col: plan.statusCol.title })}</div>
          <div className="up-ask-row">
            <select className="gd-select" value={labelElegida} onChange={(e) => setLabelElegida(e.target.value)}>
              <option value="">—</option>
              {plan.preguntar.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <button className="btn-primary" disabled={!labelElegida} onClick={usarEtiqueta}>{t('up.ask.save')}</button>
          </div>
        </div>
      )}

      {plan.label && (
        <div className="up-card up-drop">
          {!paso && (
            <>
              <button className="up-btn" onClick={subir}>
                <span className="up-btn-ic" aria-hidden>↑</span>
                {t(kind === 'remito' ? 'up.btn.remito' : 'up.btn.fiscal')}
              </button>
              <div className="up-formats">{t('up.formats')}</div>
            </>
          )}
          {paso && (
            <div className="up-progress">
              <div className="splash-spinner" />
              <div className="up-progress-txt">{t(paso === 'creating' ? 'up.creating' : paso === 'checking' ? 'up.checking' : 'up.waiting')}</div>
              {paso !== 'creating' && <button className="btn-secondary" onClick={cancelar}>{t('up.cancel')}</button>}
            </div>
          )}
        </div>
      )}

      {aviso && <div className={`up-aviso ${aviso.tipo}`}>{aviso.texto === 'drop' ? t('up.dropHint', { btn: t(kind === 'remito' ? 'up.btn.remito' : 'up.btn.fiscal') }) : aviso.texto}</div>}

      {recientes.length > 0 && (
        <div className="up-card up-list">
          <div className="up-list-title">{t('up.recent')}</div>
          {recientes.map((r) => {
            const trabado = r.kind === 'sent' && ahora - r.sentAt > SIN_ARRANCAR_MS
            return (
              <div key={r.id} className="up-row">
                <div className="up-row-main">
                  <span className="up-row-name" title={r.name}>{r.name}</span>
                  <span className={`up-pill k-${r.kind}`}>{r.kind === 'other' ? r.texto : t(`up.st.${r.kind}`)}</span>
                  {r.kind !== 'gone' && (
                    <button className="up-open" onClick={() => monday.execute('openItemCard', { itemId: Number(r.id) }).catch(() => {})}>{t('up.open')}</button>
                  )}
                </div>
                {trabado && <div className="up-row-warn">{t('up.noFire', { label: r.texto || plan.label })}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
