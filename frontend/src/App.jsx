import { useEffect, useMemo, useRef, useState } from 'react'
import mondaySdk from 'monday-sdk-js'
import { makeT, LANGUAGES } from './i18n.js'
import { fieldsForCountries, fieldsForTier, fieldGroups, LAUNCH_COUNTRIES, autoMapColumns, tipoDePlantilla, paisDePlantilla, idiomaDePlantilla, autoMapLineItems, esNuestraPlantilla, neededColumns, NUMERIC_FIELDS, DATE_FIELDS } from './fields.js'

// Instancia única del SDK de monday. Dentro del iframe del board, monday.api()
// usa la sesión del usuario logueado.
const monday = mondaySdk()

// Token de sesión de Monday (JWT firmado con el Client Secret) → lo verifica el
// backend para saber qué cuenta es. En preview (localhost) no hay token.
async function getSessionToken() {
  try { const r = await monday.get('sessionToken'); return r?.data || null } catch { return null }
}

// Columnas de ejemplo para previsualizar el diseño fuera de monday (en localhost).
const MOCK_COLUMNS = [
  { id: 'name', title: 'Name', type: 'name' },
  { id: 'text_supplier', title: 'Supplier', type: 'text' },
  { id: 'text_taxid', title: 'Supplier Tax ID', type: 'text' },
  { id: 'date_issue', title: 'Issue date', type: 'date' },
  { id: 'text_number', title: 'Invoice #', type: 'text' },
  { id: 'numbers_subtotal', title: 'Subtotal', type: 'numbers' },
  { id: 'numbers_tax', title: 'Tax', type: 'numbers' },
  { id: 'numbers_total', title: 'Total', type: 'numbers' },
  { id: 'status_reading', title: 'Reading status', type: 'status' },
  { id: 'file_pdf', title: 'PDF', type: 'file' },
]

// Config que se guarda por (cuenta, tablero) contra el backend (Postgres).
const DEFAULT_CONFIG = {
  language: 'en',
  mapping: {},
  fileColumnId: '',        // vacío = auto-detectar la columna de archivo
  countries: [],           // vacío = solo campos universales
  dedupEnabled: false,
  // Renglones → subítems: vive en el MAPEO como el resto de los campos.
  // description 'name' = cargar (nombre del subítem); quantity/unit_price/total =
  // columnId del tablero de subítems | '__auto__' (crearla) | '' (no cargar).
  lineItemsMapping: {},
}

// Títulos de las columnas del subítem. TIENEN que coincidir exactamente con
// SUBITEM_COL_TITLES de backend/monday.mjs: el backend las busca por título antes de
// crearlas, así que si no coinciden crearía duplicadas en la primera lectura.
// Qué tipo de columna necesita cada campo del renglón. No todo es un número:
// el vencimiento de partida es una fecha, y unidad/código/lote/depósito son texto.
const LI_NUM = new Set(['quantity', 'unit_price', 'bonificacion', 'subtotal', 'iva', 'total', 'envases'])
const LI_DATE = new Set(['vto_partida'])
const liTipo = (k) => (LI_DATE.has(k) ? 'date' : LI_NUM.has(k) ? 'numbers' : 'text')
// Qué columnas del tablero de subítems se le pueden ofrecer a cada campo. Sin esto,
// un campo de fecha no encontraba su columna en la lista y la pantalla lo mostraba
// como "No cargar" aunque estuviera mapeado.
const liCompatible = (k, cols) => cols.filter((c) => (
  liTipo(k) === 'date' ? c.type === 'date'
    : liTipo(k) === 'numbers' ? ['numbers', 'numeric'].includes(c.type)
      : ['text', 'long-text', 'long_text'].includes(c.type)))

// Los campos del renglón dependen del tipo de documento: una factura carga precio
// e IVA por renglón; un remito carga unidad, lote y vencimiento de partida.
const SUB_METRICS_BY_KIND = {
  fiscal: ['quantity', 'unit_price', 'bonificacion', 'subtotal', 'iva', 'total'],
  remito: ['quantity', 'unidad', 'codigo', 'lote', 'vto_partida', 'deposito', 'envases'],
}
// El "vacío" también depende del tipo: antes era una constante con los campos de
// factura, así que en un tablero de remitos el mapeo se guardaba con las claves
// equivocadas (unidad, lote y vencimiento de partida ni aparecían).
const emptyLi = (kind) => Object.fromEntries(
  ['description', ...(SUB_METRICS_BY_KIND[kind] || SUB_METRICS_BY_KIND.fiscal)].map((k) => [k, '']))
// Default de renglones cuando NO está configurado: básico (descripción + total).
const BASIC_LI = { description: 'name', quantity: '', unit_price: '', bonificacion: '', subtotal: '', iva: '', total: '__auto__' }

// Valores de ejemplo para el preview del Paso 1 (ilustrativos, factura AR típica).
const EXAMPLE = {
  document_type: 'Factura A', invoice_number: '0032-00002468', issue_date: '2026-07-30', due_date: '2026-08-29',
  currency: 'ARS', supplier_name: 'PLASTIGAS S.A.', supplier_tax_id: '30-52333600-9', supplier_address: 'Mar del Plata',
  customer_name: 'Ferretería Ind. S.A.', customer_tax_id: '30-63766275-5', customer_address: 'Pilar, Bs.As.',
  subtotal: '4.238.266,32', tax_amount: '890.035,93', total_amount: '5.340.215,56', payment_terms: 'Contado',
  ar_tipo_comprobante: 'Factura A', ar_punto_venta: '0032', ar_cae: '86316077428028', ar_cae_vto: '2026-08-09',
  ar_condicion_iva: 'Resp. Inscripto', ar_condicion_iva_receptor: 'Resp. Inscripto',
  ar_neto_no_gravado: '—', ar_exento: '—', ar_iva_21: '890.035,93', ar_iva_105: '—', ar_iva_27: '—',
  ar_percepcion_iva: '—', ar_percepcion_iibb: '211.913,31', ar_percepcion_ganancias: '—', ar_impuestos_internos: '—', ar_otros_tributos: '—',
  ar_periodo_desde: '—', ar_periodo_hasta: '—', ar_cotizacion: '—',
}

// Ayudas en lenguaje humano (traducen la jerga fiscal). Bilingüe; "?" clickeable.
const HINTS = {
  supplier_tax_id: { es: 'El número de AFIP del emisor (CUIT)', en: 'The issuer’s tax ID (CUIT)' },
  customer_tax_id: { es: 'El número de AFIP del receptor', en: 'The recipient’s tax ID' },
  subtotal: { es: 'El monto antes de impuestos (Neto Gravado)', en: 'Amount before taxes (net)' },
  tax_amount: { es: 'El IVA total de la factura', en: 'Total VAT of the invoice' },
  ar_cae: { es: 'El código que AFIP le da a cada factura electrónica', en: 'AFIP e-invoice authorization code' },
  ar_cae_vto: { es: 'Hasta cuándo vale ese código', en: 'CAE expiry date' },
  ar_condicion_iva: { es: 'Si el emisor es Resp. Inscripto, Monotributo, etc.', en: 'Issuer VAT condition' },
  ar_condicion_iva_receptor: { es: 'La condición IVA del receptor', en: 'Recipient VAT condition' },
  ar_percepcion_iibb: { es: 'Adelanto de Ingresos Brutos que te cobran', en: 'Gross-income (IIBB) perception' },
  ar_percepcion_iva: { es: 'Adelanto de IVA que te cobran', en: 'VAT perception' },
  ar_percepcion_ganancias: { es: 'Adelanto de Ganancias que te cobran', en: 'Income-tax perception' },
  ar_punto_venta: { es: 'La sucursal/caja que emitió la factura', en: 'Point of sale' },
  ar_cotizacion: { es: 'El tipo de cambio, si la factura es en dólares', en: 'Exchange rate (if foreign currency)' },
}

// Renglones de ejemplo para el preview de subítems.
const SUB_EXAMPLE = [
  { name: 'Marco puerta rebatir', quantity: '15,26', unit_price: '14.724,60', bonificacion: '0', subtotal: '224.697,40', iva: '21', total: '271.883,85' },
  { name: 'Hoja puerta rebatir', quantity: '26,63', unit_price: '14.724,60', bonificacion: '0', subtotal: '392.116,10', iva: '21', total: '474.460,48' },
]
// Modo del picker de subítems a partir del liMap guardado.
const subModeFromLi = (li, SUB_METRICS = SUB_METRICS_BY_KIND.fiscal) => {
  if (!li?.description) return 'off'
  const on = SUB_METRICS.filter((k) => li[k])
  if (on.length === SUB_METRICS.length) return 'full'
  if (on.length === 1 && li.total) return 'basic'
  return 'custom'
}

export default function App() {
  const [context, setContext] = useState(null)
  const [boardName, setBoardName] = useState('')
  const [columns, setColumns] = useState([])
  // La descripción del tablero lleva la marca de nuestras plantillas. Monday la
  // copia al duplicar, así que es la señal confiable de "esto salió de nosotros".
  const [boardDesc, setBoardDesc] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [previewMode, setPreviewMode] = useState(false)

  const [step, setStep] = useState(1) // abre en Países (flujo país-first): elegís país → Preparar mi tablero
  const [language, setLanguage] = useState(() => {
    try { return localStorage.getItem('air_lang') || 'en' } catch { return 'en' }
  })
  const [mapping, setMapping] = useState({})
  const [fileColumnId, setFileColumnId] = useState('')
  // Columna de estado donde la app escribe leyendo / leído / error. La elige el
  // usuario: si no elige y el tablero tiene varias, la app NO escribe (nunca adivina).
  const [statusColumnId, setStatusColumnId] = useState('')
  const [statusEnabled, setStatusEnabled] = useState(true)
  const [countries, setCountries] = useState([])
  // Tipo de documento del tablero: 'fiscal' (facturas/NC/ND) o 'remito'. Un tablero,
  // un tipo — por eso vive acá arriba y no adentro del mapeo.
  const [docKind, setDocKind] = useState('fiscal')
  // Tipo al que se quiere cambiar, esperando confirmación. null = no hay pregunta.
  const [kindPend, setKindPend] = useState(null)
  // ¿El tipo ya lo eligió alguien (o lo sabemos por la plantilla)? En un tablero nuevo
  // que no es nuestro NO se asume "Facturas": el usuario elige, y hasta entonces no
  // se muestra ni el país ni el mapeo (un remito y una factura no comparten campos).
  const [kindElegido, setKindElegido] = useState(false)
  // Tablero sin mapeo guardado, esperando a que lleguen las columnas para premapear.
  const [porMapear, setPorMapear] = useState(null)
  const [dedupEnabled, setDedupEnabled] = useState(false)
  const [renameItemEnabled, setRenameItemEnabled] = useState(false)
  const [onlyFiscalDocs, setOnlyFiscalDocs] = useState(false)
  // Lista blanca de IDs fiscales: 'all' = cargar todo; 'customer'/'supplier' = solo
  // las facturas cuyo receptor/emisor esté en filterTaxIds.
  const [filterMode, setFilterMode] = useState('all')
  const [filterTaxIds, setFilterTaxIds] = useState([])
  const [taxIdDraft, setTaxIdDraft] = useState('')
  const [liMap, setLiMap] = useState(() => emptyLi('fiscal')) // mapeo de renglones → subítems
  const [subColumns, setSubColumns] = useState([])     // columnas del tablero de subítems
  // Qué renglones venían YA guardados. Sirve para distinguir "nunca se ofreció" de
  // "el usuario lo apagó": lo primero se puede completar solo, lo segundo no se toca.
  const savedLiRef = useRef(null)

  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error
  const [prepState, setPrepState] = useState('idle') // idle | working | done  ("Preparar mi tablero")
  const [dirty, setDirty] = useState(false)
  const [dirtySeq, setDirtySeq] = useState(0) // sube en cada cambio → reinicia el debounce
  const seqRef = useRef(0)     // misma cuenta, legible dentro de un guardado en vuelo
  const retryRef = useRef(0)   // reintentos consumidos del guardado actual
  // Selector "¿Qué querés cargar?": paquetes por capa (básico/contable/completo) + ajuste fino.
  const [selectedFields, setSelectedFields] = useState([])
  // 'custom' de entrada: en un tablero nuevo no se pre-elige ningún paquete (antes
  // venía "Contable" y al elegir el país medio mapeo aparecía como "Crear columna").
  const [preset, setPreset] = useState('custom')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [subMode, setSubMode] = useState('off') // subítems: off | basic | full | custom
  const [guideStep, setGuideStep] = useState(1) // pestaña de la guía visual del Paso 2
  // monday no expone si la receta existe: lo confirma el usuario. Sin esto el paso 2
  // decía "Listo" solo por haber mapeado campos, y el usuario creía que ya andaba.
  const [automationConfirmed, setAutomationConfirmed] = useState(false)
  const contextArrived = useRef(false)

  // Onboarding: welcome page para tableros sin configurar (descartable) +
  // valueCreatedForUser (requisito de review) al quedar configurado.
  const [hasSetup, setHasSetup] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    try { return localStorage.getItem('air_welcome_dismissed') === '1' } catch { return false }
  })
  const valueCreatedFired = useRef(false)

  // Contador de uso (facturas leídas) que ve el usuario. Solo el conteo.
  const [usage, setUsage] = useState(null)

  const t = useMemo(() => makeT(language), [language])

  // 1) context de monday → boardId.
  useEffect(() => {
    const unsubscribe = monday.listen('context', (res) => {
      contextArrived.current = true
      setPreviewMode(false)
      setContext(res.data)
    })
    let timer
    if (import.meta.env.DEV) {
      timer = setTimeout(() => { if (!contextArrived.current) setPreviewMode(true) }, 2500)
    }
    return () => { try { unsubscribe() } catch { /* noop */ } clearTimeout(timer) }
  }, [])

  const boardId = context?.boardId || context?.boardIds?.[0] || null

  // 2) Columnas: reales (monday) o de ejemplo (preview).
  useEffect(() => {
    if (previewMode) {
      setBoardName('Sample board'); setColumns(MOCK_COLUMNS); setError(null); setLoading(false)
      setSubColumns([{ id: 'numbers_qty', title: 'Qty', type: 'numbers' }, { id: 'numbers_price', title: 'Unit price', type: 'numbers' }])
      return
    }
    if (!boardId) return
    setLoading(true)
    monday
      .api(`query { boards(ids: [${boardId}]) { name description columns { id title type settings_str } } }`)
      .then((res) => {
        const board = res?.data?.boards?.[0]
        setBoardName(board?.name || ''); setColumns(board?.columns || [])
        setBoardDesc(board?.description || ''); setError(null)
        // Columnas del tablero de SUBÍTEMS (para mapear los renglones). El id del
        // tablero viene en los settings de la columna "Subitems" del tablero padre.
        let subBoardId = null
        try {
          const sub = (board?.columns || []).find((c) => c.type === 'subtasks')
          subBoardId = sub ? JSON.parse(sub.settings_str || '{}').boardIds?.[0] : null
        } catch { /* sin subítems */ }
        if (subBoardId) {
          monday.api(`query { boards(ids: [${subBoardId}]) { columns { id title type } } }`)
            .then((r) => setSubColumns(r?.data?.boards?.[0]?.columns || []))
            .catch(() => setSubColumns([]))
        } else setSubColumns([])
      })
      .catch((err) => setError(err?.message || 'Could not load columns'))
      .finally(() => setLoading(false))
  }, [boardId, previewMode])

  const ready = !loading && !error && (previewMode || boardId)
  // Campos activos = universales + capas de los países elegidos (ej. AR → CAE, etc.).
  const activeFields = useMemo(() => fieldsForCountries(countries), [countries])
  const mappedCount = useMemo(() => activeFields.filter((id) => mapping[id]).length, [mapping, activeFields])
  const fileColumns = useMemo(() => columns.filter((c) => c.type === 'file'), [columns])
  const statusColumns = useMemo(() => columns.filter((c) => c.type === 'status' || c.type === 'color'), [columns])

  // 3) Cargar la config guardada (backend/Postgres; localStorage en preview).
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const apply = (cfg) => {
      if (cancelled) return
      setLanguage(cfg.language || 'en')
      // El tipo de documento SE LEE de lo guardado. Sin esta línea, un tablero de
      // remitos volvía a "fiscal" al recargar: la pantalla se veía bien porque el
      // pre-mapeo ya había corrido, pero el autoguardado escribía docKind "fiscal"
      // y los renglones con las claves de factura.
      setDocKind(cfg.docKind === 'remito' ? 'remito' : 'fiscal')
      setKindElegido(!!cfg.docKindSet)
      setMapping(cfg.mapping || {})
      setFileColumnId(cfg.fileColumnId || '')
      setStatusColumnId(cfg.statusColumnId || '')
      setStatusEnabled(cfg.statusEnabled !== false)
      setAutomationConfirmed(!!cfg.automationConfirmed)
      setCountries(cfg.countries || [])
      setDedupEnabled(!!cfg.dedupEnabled)
      setRenameItemEnabled(!!cfg.renameItemEnabled)
      setOnlyFiscalDocs(!!cfg.onlyFiscalDocs)
      setFilterMode(cfg.filterMode || 'all')
      setFilterTaxIds(Array.isArray(cfg.filterTaxIds) ? cfg.filterTaxIds : [])
      // Renglones: si está configurado (description = 'name') respetamos lo guardado;
      // si NO está mapeado / primera vez, default = básico.
      // Respetamos lo GUARDADO, incluso si es "apagado". El default básico solo aplica
      // cuando el tablero nunca configuró renglones: si no, a un cliente que los tenía
      // apagados se le prendían solos al primer guardado.
      if (cfg.lineItemsMapping && Object.keys(cfg.lineItemsMapping).length) {
        savedLiRef.current = cfg.lineItemsMapping
        setLiMap({ ...emptyLi(cfg.docKind), ...cfg.lineItemsMapping })
        setSubMode(subModeFromLi(cfg.lineItemsMapping, SUB_METRICS_BY_KIND[cfg.docKind] || SUB_METRICS_BY_KIND.fiscal))
      } else { savedLiRef.current = null; setLiMap(emptyLi(cfg.docKind)); setSubMode('off') }
      // Sin mapeo guardado, NADA elegido: cada campo arranca en "No cargar" y el
      // usuario decide. (Antes se pre-elegía el paquete "Contable" y los campos sin
      // columna aparecían como "Crear columna nueva" sin que nadie lo pidiera.)
      const mapped = Object.keys(cfg.mapping || {})
      setSelectedFields(mapped)
      setPreset('custom')
      setDirty(false)
    }
    ;(async () => {
      let cfg = null
      try {
        if (previewMode) {
          const raw = localStorage.getItem('config:preview')
          cfg = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : null
        } else if (boardId) {
          const token = await getSessionToken()
          const r = await fetch(`/api/config/${boardId}`, { headers: token ? { Authorization: token } : {} })
          if (r.ok) cfg = { ...DEFAULT_CONFIG, ...(await r.json()) }
        }
      } catch { /* sin config previa */ }
      if (cancelled) return
      if (cfg) apply(cfg)
      else { savedLiRef.current = null; setSelectedFields([]); setLiMap(emptyLi('fiscal')); setSubMode('off') }
      const savedMapping = cfg?.mapping && Object.keys(cfg.mapping).length > 0
      setHasSetup(!!savedMapping)
      setConfigLoaded(true)
      // El pre-mapeo NO se hace acá: las columnas llegan de otra consulta y pueden
      // no haber llegado todavía. Si se hacía acá, el tablero abría sin mapear.
      // Se marca la intención y la resuelve el efecto de abajo cuando estén.
      setPorMapear(savedMapping ? null : { fileColumnId: cfg?.fileColumnId, statusColumnId: cfg?.statusColumnId })
    })()
    return () => { cancelled = true }
  }, [ready, boardId, previewMode])

  // valueCreatedForUser: Monday lo trackea la PRIMERA vez que la app entrega
  // valor. Para nosotros = el tablero quedó configurado (≥1 campo mapeado) y
  // guardado. Fire-and-forget; guardado con ref para no repetir.
  useEffect(() => {
    if (previewMode || valueCreatedFired.current) return
    const configuredAndSaved = mappedCount > 0 && !dirty && (saveState === 'saved' || saveState === 'idle')
    if (configuredAndSaved) {
      valueCreatedFired.current = true
      monday.execute('valueCreatedForUser').catch(() => {})
    }
  }, [mappedCount, dirty, saveState, previewMode])

  // Traer el contador de facturas leídas (para mostrarlo en la barra lateral).
  useEffect(() => {
    if (!ready) return
    if (previewMode) { setUsage({ month: 3, total: 27, plan: 'pro', planLabel: 'Pro', limit: 200 }); return }
    let cancelled = false
    ;(async () => {
      try {
        const token = await getSessionToken()
        const r = await fetch('/api/usage', { headers: token ? { Authorization: token } : {} })
        if (r.ok && !cancelled) setUsage(await r.json())
      } catch { /* sin datos de uso */ }
    })()
    return () => { cancelled = true }
  }, [ready, previewMode])

  const dismissWelcome = () => {
    try { localStorage.setItem('air_welcome_dismissed', '1') } catch { /* noop */ }
    setWelcomeDismissed(true)
  }

  // touch() marca "hay cambios" y dispara el auto-guardado (ver el efecto más abajo).
  // dirtySeq sube en cada cambio para poder reiniciar el debounce.
  const touch = () => { seqRef.current += 1; retryRef.current = 0; setDirty(true); setSaveState('idle'); setDirtySeq((n) => n + 1) }
  // El idioma es una preferencia: se aplica y AUTO-GUARDA al instante, sin marcar
  // el config como "sin guardar" ni pedir el botón Guardar.
  const changeLanguage = (lng) => {
    setLanguage(lng)
    try { localStorage.setItem('air_lang', lng) } catch { /* noop */ }
    if (previewMode || !boardId) return
    getSessionToken().then((token) =>
      fetch(`/api/config/${boardId}/language`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
        body: JSON.stringify({ language: lng }),
      }).catch(() => { /* best-effort */ }),
    )
  }
  // UN país por tablero. Antes era multi-selección: un tablero podía mezclar países y
  // se cargaban columnas comunes. En la práctica cada tablero es de un país (su
  // fiscalidad, sus columnas), así que elegir uno REEMPLAZA al anterior.
  const toggleCountry = (c) => {
    const next = countries.includes(c) && countries.length === 1 ? [] : [c]
    setCountries(next); touch()
    // Al cambiar el país, re-aplicamos el paquete para que aparezcan/desaparezcan sus
    // campos — y los pre-mapeamos, si no los nuevos quedarían todos como "crear".
    if (preset !== 'custom') {
      const fields = fieldsForTier(preset, next)
      setSelectedFields(fields); premap(fields)
    }
  }

  // Pre-mapeo: cada campo apunta a la columna que YA existe (match por nombre) o a
  // una nueva. Nunca pisa lo que el usuario eligió a mano.
  const premap = (fields) => setMapping((m) => {
    const next = { ...m }
    for (const f of fields) {
      if (next[f]) continue
      const nameCol = f === 'supplier_name' ? columns.find((c) => c.type === 'name')?.id : null
      next[f] = autoMap[f] || nameCol || '__new__'
    }
    return next
  })

  // ── Paquetes de campos (Paso 1) ──
  // Elegir un paquete PRE-MAPEA: cada campo del nivel apunta a la columna que ya
  // existe (match por nombre) o a una nueva. Así el usuario ve el mapeo resuelto y
  // solo cambia lo que quiera, en vez de arrancar de cero.
  const applyPreset = (p) => {
    setPreset(p)
    if (p === 'custom') { setShowAdvanced(true); return }
    const fields = fieldsForTier(p, countries)
    setSelectedFields(fields); premap(fields); touch()
  }
  // Un solo control por campo: elegir columna, crear una nueva, o no cargarlo.
  // "No cargar" ('') es lo mismo que destildarlo antes: sale del mapeo y no se escribe.
  const setFieldTarget = (f, v) => {
    if (!v) {
      setSelectedFields((s) => s.filter((x) => x !== f))
      setMapping((m) => { const n = { ...m }; delete n[f]; return n })
    } else {
      setSelectedFields((s) => (s.includes(f) ? s : [...s, f]))
      setMapping((m) => ({ ...m, [f]: v }))
    }
    setPreset('custom'); touch()
  }
  const SUB_METRICS = SUB_METRICS_BY_KIND[docKind] || SUB_METRICS_BY_KIND.fiscal
  const subCols = SUB_METRICS.filter((k) => liMap[k])
  // Los renglones son un grupo más del mapeo: mismo control, misma lógica.
  const LI_ALL = ['description', ...SUB_METRICS]
  const subCount = LI_ALL.filter((k) => liMap[k]).length
  // Cambiar el tipo de documento reinicia el mapeo: un remito no comparte campos
  // con una factura, así que dejar el mapeo viejo apuntaría a columnas que ya no
  // corresponden. Se avisa antes de borrar nada.
  const aplicarTipo = (k) => {
    setDocKind(k)
    setKindElegido(true)
    // El mapeo viejo no sirve (los campos son otros), pero si el tablero es nuestra
    // plantilla las columnas del tipo NUEVO ya existen: se mapean solas. Sin esto,
    // pasar la plantilla de remitos a "Remitos" la dejaba en cero.
    const auto = autoMapColumns(columns, k, boardDesc)
    setMapping(auto)
    setSelectedFields(Object.keys(auto).filter((f) => auto[f]))
    setLiMap({ ...emptyLi(k) })
    savedLiRef.current = null
    setSubMode('off')
    setKindPend(null)
    touch()
  }
  const cambiarTipo = (k) => {
    // Sin tipo elegido todavía, "Facturas" también se aplica (docKind arranca en
    // 'fiscal' por dentro, pero nadie lo eligió).
    if (kindElegido && k === docKind) return
    // Si todavía no mapeó nada, no hay nada que perder: se cambia sin preguntar.
    const hayMapeo = Object.values(mapping).some(Boolean) || Object.values(liMap).some(Boolean)
    if (!kindElegido || !hayMapeo) return aplicarTipo(k)
    setKindPend(k)
  }
  const setLi = (k, v) => {
    setLiMap((m) => { const next = { ...m, [k]: v }; setSubMode(subModeFromLi(next, SUB_METRICS)); return next })
    touch()
  }
  // Campos elegidos ordenados como una factura (para el preview y la confirmación).
  const orderedSelected = useMemo(
    () => fieldGroups(countries, docKind).flatMap((g) => g.fields).filter((f) => selectedFields.includes(f)),
    [countries, docKind, selectedFields],
  )
  // Auto-mapeo por nombre (para saber qué campos ya tienen columna vs cuáles se crearían).
  const autoMap = useMemo(() => autoMapColumns(columns, docKind, boardDesc), [columns, docKind, boardDesc])
  const hasNameCol = useMemo(() => columns.some((c) => c.type === 'name'), [columns])
  const isMapped = (f) => mapping[f] === '__new__' ? false : !!(mapping[f] || autoMap[f] || (f === 'supplier_name' && hasNameCol))
  // Campos elegidos que se van a CREAR (no tienen columna ni por mapeo ni por nombre).
  const newFields = useMemo(() => orderedSelected.filter((f) => !isMapped(f)), [orderedSelected, mapping, autoMap, hasNameCol])
  // "?" clickeable con un texto de ayuda (anda en touch; stopPropagation para no togglear).
  const tipEl = (text) => text ? (
    <span className="tt" tabIndex={0} role="button" aria-label="?" onClick={(e) => e.stopPropagation()}>?
      <span className="tt-b">{text}</span>
    </span>
  ) : null
  const fieldTip = (id) => tipEl(HINTS[id]?.[language])

  // "Preparar mi tablero": crea las columnas que faltan (universales + del/los país/es
  // elegidos) en el board y las mapea solas. Aditivo: no borra ni pisa nada existente
  // (conserva el mapeo que ya había y reusa columnas por nombre). Usa el token del
  // usuario (monday.api) → requiere permiso de edición del tablero.
  // Crea el tablero de subítems y sus columnas AHORA, para que el usuario las vea al
  // aplicar. Monday solo crea ese tablero cuando existe el primer subítem, así que
  // creamos uno temporal y lo borramos. Best-effort: si algo falla, el backend igual
  // las crea (por título) en la primera lectura.
  const ensureSubitemColumns = async () => {
    if (previewMode || !boardId) return
    // Campos del renglón que el usuario dejó en "crear automáticamente".
    const pend = ['description', ...SUB_METRICS].filter((k) => liMap[k] === '__auto__')
    if (!pend.length) return
    // 1) Ítem TEMPORAL propio. Antes colgábamos el subítem del primer ítem real del
    //    tablero: si el borrado fallaba, ese ítem quedaba con un subítem fantasma y la
    //    lectura lo tomaba como un renglón ya creado (se salteaba el renglón 1).
    //    Con un ítem propio, el usuario nunca queda con basura adentro de sus datos.
    const it = await monday.api(
      `mutation($b: ID!){ create_item(board_id:$b, item_name:"⏳ preparando columnas…"){ id } }`,
      { variables: { b: String(boardId) } },
    )
    const tmpItem = it?.data?.create_item?.id
    if (!tmpItem) return
    let subBoard = null
    try {
      // 2) Subítem sobre el temporal → nos devuelve el id del tablero de subítems.
      const cr = await monday.api(
        `mutation($p: ID!){ create_subitem(parent_item_id:$p, item_name:"—"){ id board { id } } }`,
        { variables: { p: String(tmpItem) } },
      )
      subBoard = cr?.data?.create_subitem?.board?.id
      if (!subBoard) return
      const ex = await monday.api(`query { boards(ids: [${Number(subBoard)}]) { columns { id title type } } }`)
      const have = ex?.data?.boards?.[0]?.columns || []
      const next = [...have]
      for (const k of pend) {
        // El título sale del diccionario: es el MISMO que usan las plantillas, así
        // que una columna creada a mano después se reconoce igual que una de fábrica.
        const title = t('lineitems.' + k)
        if (next.some((c) => c.title.toLowerCase() === title.toLowerCase())) continue
        const type = k === 'description' ? 'text' : liTipo(k)
        const r = await monday.api(
          `mutation($b: ID!, $t: String!, $ct: ColumnType!){ create_column(board_id:$b, title:$t, column_type:$ct){ id title type } }`,
          { variables: { b: String(subBoard), t: title, ct: type } },
        ).catch(() => null)
        const c = r?.data?.create_column
        if (c?.id) next.push(c)
      }
      setSubColumns(next)
    } finally {
      // 3) Fuera el ítem temporal (se lleva su subítem), pase lo que pase.
      await monday.api(`mutation($i: ID!){ delete_item(item_id:$i){ id } }`, { variables: { i: String(tmpItem) } }).catch(() => {})
    }
  }

  const prepareBoard = async () => {
    if (previewMode || !boardId || prepState === 'working') return
    setPrepState('working')
    try {
      const auto = autoMapColumns(columns, docKind, boardDesc) // reusa las de nuestra plantilla
      const cols = [...columns]
      const map = {}
      const mkCol = async (title, type) => {
        const r = await monday.api(
          `mutation($b: ID!, $t: String!, $ct: ColumnType!){ create_column(board_id:$b, title:$t, column_type:$ct){ id title type } }`,
          { variables: { b: String(boardId), t: title, ct: type } },
        )
        const c = r?.data?.create_column
        if (c?.id) cols.push(c)
        return c?.id || null
      }
      // SOLO los campos ELEGIDOS: reusa lo ya mapeado o por nombre, crea lo que falte.
      // supplier_name usa la columna Name del ítem si existe. Los deseleccionados
      // salen del mapeo (dejan de llenarse) pero su columna NO se borra.
      for (const { field, type } of neededColumns(selectedFields)) {
        const forceNew = mapping[field] === '__new__' // el usuario pidió columna nueva propia
        let colId = forceNew ? null : (mapping[field] || auto[field])
        if (!colId && !forceNew && field === 'supplier_name') { const n = cols.find((c) => c.type === 'name'); if (n) colId = n.id }
        if (!colId) colId = await mkCol(t(`field.${field}`), type).catch(() => null)
        if (colId) map[field] = colId
      }
      // Columna de archivo (de dónde sale el PDF) si el tablero no tiene ninguna.
      let fileCol = fileColumnId || cols.find((c) => c.type === 'file')?.id
      if (!fileCol) fileCol = await mkCol(t('prep.fileTitle'), 'file').catch(() => null)
      // Columnas del RENGLÓN. Antes se creaban recién en la primera lectura, así que
      // el usuario aplicaba y no veía nada: parecía que no funcionaba.
      if (liMap.description) await ensureSubitemColumns().catch(() => {})
      setColumns(cols)
      setMapping(map)
      if (fileCol) setFileColumnId(fileCol)
      // Auto-guardar la config recién creada (mapping + columna de archivo) para que
      // el pipeline de lectura la use ya, sin depender de que el usuario apriete "Guardar".
      await saveConfig({ mapping: map, fileColumnId: fileCol || fileColumnId })
      setPrepState('done'); setTimeout(() => setPrepState('idle'), 3200)
    } catch (e) { setError(e?.message || 'No se pudieron crear las columnas'); setPrepState('idle') }
  }

  // Nada es obligatorio: se puede guardar cualquier cambio.
  const canSave = dirty && saveState !== 'saving'

  // Lo que se persiste son SOLO los campos elegidos y con columna real. Sin esto se
  // guardaban campos que la pantalla mostraba como "No cargar" (auto-mapeados por
  // nombre pero nunca elegidos) y el centinela '__new__', que no es una columna.
  const cleanMapping = () => Object.fromEntries(
    Object.entries(mapping).filter(([f, v]) => v && v !== '__new__' && selectedFields.includes(f)),
  )

  const collectConfig = () => ({
    language, mapping: cleanMapping(), fileColumnId, statusColumnId, statusEnabled, countries, docKind,
    dedupEnabled, renameItemEnabled, onlyFiscalDocs, lineItemsMapping: liMap,
    filterMode, filterTaxIds, automationConfirmed,
  })

  const saveConfig = async (override = null) => {
    if (!override && !canSave) return
    // Versionamos el guardado: si mientras el POST viaja el usuario toca otra cosa,
    // NO podemos marcar "todo guardado" al volver — ese cambio nuevo no viajó.
    // Sin esto se perdían cambios en silencio y la barra decía "✓ Guardado".
    const seqAtSend = seqRef.current
    setSaveState('saving')
    try {
      const cfg = { ...collectConfig(), ...(override || {}) }
      if (previewMode) {
        localStorage.setItem('config:preview', JSON.stringify(cfg))
      } else if (boardId) {
        const token = await getSessionToken()
        const r = await fetch(`/api/config/${boardId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
          body: JSON.stringify(cfg),
        })
        if (!r.ok) throw new Error('save failed')
      } else { return }
      // Solo damos por guardado si NO hubo cambios nuevos mientras viajaba el POST.
      // Si los hubo, dejamos dirty=true y pedimos otro guardado.
      if (seqRef.current === seqAtSend) { setSaveState('saved'); setDirty(false) }
      else { setSaveState('idle'); setDirtySeq((n) => n + 1) }
    } catch {
      setSaveState('error')
      // Reintento acotado: sin botón de Guardar, un fallo de red dejaría la config
      // sin persistir para siempre. Reprogramamos hasta 3 veces.
      if (retryRef.current < 3) { retryRef.current += 1; setTimeout(() => setDirtySeq((n) => n + 1), 4000) }
    }
  }

  // ─── Auto-guardado ───
  // La config se guarda sola, como ya hacía el idioma. Pedirle al usuario que apriete
  // "Guardar" después de mover un interruptor era un paso de más (y convivía mal con
  // "Aplicar al tablero": no se entendía cuál apretar).
  // El debounce junta una ráfaga de cambios en un solo guardado; el ref asegura que se
  // guarde el estado ÚLTIMO y no el que había cuando arrancó el temporizador.
  const saveRef = useRef(null)
  saveRef.current = saveConfig
  useEffect(() => {
    if (!dirtySeq || previewMode || !boardId) return
    const id = setTimeout(() => { saveRef.current?.() }, 800)
    return () => clearTimeout(id)
  }, [dirtySeq, previewMode, boardId])


  // ─── Estado de los pasos (solo el mapeo es requerido; el resto opcional) ───
  const done1 = countries.length > 0 && mappedCount > 0
  const done2 = automationConfirmed
  const rulesTouched = dedupEnabled || renameItemEnabled || onlyFiscalDocs || !statusEnabled || !!statusColumnId || filterMode !== 'all'

  // Lista blanca de CUITs: se guardan solo los dígitos (así da igual con o sin guiones).
  const addTaxId = () => {
    const clean = taxIdDraft.replace(/[^0-9A-Za-z]/g, '')
    if (!clean || filterTaxIds.includes(clean)) { setTaxIdDraft(''); return }
    setFilterTaxIds([...filterTaxIds, clean]); setTaxIdDraft(''); touch()
  }
  const removeTaxId = (id) => { setFilterTaxIds(filterTaxIds.filter((x) => x !== id)); touch() }
  const completed = [done1, done2, rulesTouched].filter(Boolean).length
  const steps = [
    { n: 1, label: t('step1.label'), mark: done1 ? 'complete' : '', status: 'optional', statusText: t('status.optional') },
    { n: 2, label: t('step2.label'), mark: done2 ? 'complete' : 'pending', status: done2 ? 'complete' : 'pending', statusText: done2 ? t('status.done') : t('status.pending') },
    { n: 3, label: t('step3.label'), mark: rulesTouched ? 'complete' : '', status: 'optional', statusText: t('status.optional') },
  ]

  const allReq = done1 && done2
  const RING_R = 42
  const RING_C = 2 * Math.PI * RING_R

  // ─── Helpers de UI ───
  // Control ÚNICO del mapeo: reemplaza el "tildar campo" + "elegir columna" que
  // antes estaban separados. Acá se decide todo de una: a qué columna va, si se
  // crea una nueva, o si ese campo no se carga.
  // Aviso de autoguardado. En el Paso 1 vive dentro de la barra de aplicar (si no,
  // quedaban DOS barras pegadas abajo, una arriba de la otra).
  const saveStatusEl = (
    <span className={`save-status ${saveState === 'idle' && !dirty ? 'saved' : saveState}`}>
      {saveState === 'saving' && t('save.saving')}
      {saveState === 'saved' && t('save.saved')}
      {saveState === 'error' && t('save.error')}
      {saveState === 'idle' && (dirty ? t('save.saving') : t('save.auto'))}
    </span>
  )
  const fieldSel = (f) => (
    <select
      className={`map-select ${selectedFields.includes(f) ? 'mapped' : 'unmapped'}`}
      value={selectedFields.includes(f) ? (mapping[f] || '__new__') : ''}
      onChange={(e) => setFieldTarget(f, e.target.value)}
    >
      <option value="">{t('map.off')}</option>
      <option value="__new__">➕ {t('adv.new')}</option>
      <optgroup label={t('map.boardCols')}>
        {compatibleCols(f).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
      </optgroup>
    </select>
  )
  // Solo columnas donde el dato ENTRA. Ofrecer una fórmula o un espejo (que son de
  // solo lectura) hacía que monday rechazara la escritura de TODA la factura.
  const RO_TYPES = new Set(['formula', 'mirror', 'auto_number', 'creation_log', 'last_updated', 'subtasks', 'progress', 'button', 'doc', 'file'])
  const compatibleCols = (f) => columns.filter((c) => {
    if (RO_TYPES.has(c.type)) return false
    if (NUMERIC_FIELDS.includes(f)) return ['numbers', 'numeric'].includes(c.type)
    if (DATE_FIELDS.includes(f)) return ['date'].includes(c.type)
    return true
  })
  // Todos los campos del/los país/es elegidos, en orden de factura.
  const allFields = useMemo(() => fieldGroups(countries, docKind).flatMap((g) => g.fields), [countries, docKind])

  // Pre-mapeo de un tablero sin configurar. Espera a tener TODO: las columnas del
  // tablero, su descripción y las del tablero de subítems (tres consultas distintas
  // a monday). Después escribe una sola vez, con los valores EXPLÍCITOS.
  //
  // Lo de explícito no es un detalle: antes esto seteaba estado de React y confiaba
  // en que el autoguardado lo leyera después. Guardaba el tipo viejo — un tablero de
  // remitos quedaba grabado como "fiscal" aunque en pantalla se viera bien.
  useEffect(() => {
    if (!porMapear || !configLoaded || !columns.length) return
    // Si el tablero tiene subítems, esperamos sus columnas: si no, los renglones
    // quedarían sin mapear y habría que guardar dos veces.
    const tieneSub = columns.some((c) => c.type === 'subtasks')
    if (tieneSub && !subColumns.length) return

    // Si es una plantilla nuestra, sabemos qué lee, de qué país y en qué idioma
    // está, sin preguntar nada. En cualquier otro tablero esto devuelve vacío.
    const kind = tipoDePlantilla(columns, boardDesc) || 'fiscal'
    const auto = autoMapColumns(columns, kind, boardDesc)
    const hayMapeo = Object.keys(auto).length > 0
    const pais = hayMapeo ? paisDePlantilla(columns, kind) : null
    const idioma = hayMapeo ? idiomaDePlantilla(columns, kind) : null
    const liAuto = hayMapeo && tieneSub ? { ...emptyLi(kind), ...autoMapLineItems(subColumns, kind) } : null
    const fc = columns.filter((c) => c.type === 'file')
    const sc = columns.filter((c) => c.type === 'status' || c.type === 'color')
    const fileCol = fc.length === 1 && !porMapear.fileColumnId ? fc[0].id : porMapear.fileColumnId || ''
    const statusCol = sc.length === 1 && !porMapear.statusColumnId ? sc[0].id : porMapear.statusColumnId || ''

    setDocKind(kind)
    setFileColumnId(fileCol)
    setStatusColumnId(statusCol)
    if (hayMapeo) {
      // Plantilla nuestra: el tipo lo sabemos por sus columnas, no hace falta preguntar.
      setKindElegido(true)
      setMapping(auto)
      // selectedFields también: al guardar, cleanMapping() descarta lo que no esté acá.
      setSelectedFields(Object.keys(auto))
      setPreset('custom')
      if (pais) setCountries([pais])
      if (idioma) setLanguage(idioma)
      if (liAuto) { setLiMap(liAuto); setSubMode('custom') }
    }
    setPorMapear(null)
    // El guardado va con los valores en la mano, no con el estado de React.
    if (hayMapeo) {
      saveRef.current?.({
        docKind: kind,
        mapping: auto,
        countries: pais ? [pais] : [],
        language: idioma || language,
        lineItemsMapping: liAuto || liMap,
        fileColumnId: fileCol,
        statusColumnId: statusCol,
      })
    }
  }, [porMapear, configLoaded, columns, subColumns, boardDesc])

  // Red de seguridad de los RENGLONES. El pre-mapeo de arriba corre una sola vez, y
  // si en ese momento las columnas de subítems todavía no habían llegado, los
  // renglones quedaban a medias PARA SIEMPRE: el tablero se veía bien pero en la base
  // había dos campos en vez de ocho. Acá, en una plantilla nuestra, completamos los
  // que tienen columna con ese título exacto.
  // Solo las claves que NUNCA estuvieron guardadas: una que el usuario puso en
  // "no cargar" queda guardada como "" y esto no la revive.
  useEffect(() => {
    if (!configLoaded || !columns.length || !subColumns.length) return
    if (!esNuestraPlantilla(columns, docKind, boardDesc)) return
    const auto = autoMapLineItems(subColumns, docKind)
    const guardadas = savedLiRef.current || {}
    const faltan = Object.entries(auto).filter(([k, v]) => v && !(k in guardadas) && !liMap[k])
    if (!faltan.length) return
    const next = { ...liMap, ...Object.fromEntries(faltan) }
    console.warn('[renglones] completo lo que faltaba:', faltan.map(([k]) => k).join(', '))
    savedLiRef.current = next
    setLiMap(next)
    setSubMode('custom')
    saveRef.current?.({ lineItemsMapping: next })
    // liMap queda fuera a propósito: lo actualiza este mismo efecto y volvería a correr.
  }, [configLoaded, columns, subColumns, docKind, boardDesc]) // eslint-disable-line react-hooks/exhaustive-deps

  // Si alguien borró en monday una columna que estaba mapeada, ese mapeo apunta al
  // vacío: el campo dejaba de cargarse en silencio y el selector mostraba la primera
  // opción como si estuviera bien. Lo pasamos a "crear nueva" para que se vea.
  // El guard columns.length evita borrar el mapeo si la query de columnas falló.
  useEffect(() => {
    if (!columns.length || !configLoaded) return
    const vivas = new Set(columns.map((c) => c.id))
    const rotas = Object.entries(mapping).filter(([, v]) => v && v !== '__new__' && !vivas.has(v))
    if (!rotas.length) return
    console.warn('[map] columnas borradas del tablero:', rotas.map(([f]) => f).join(', '))
    setMapping((m) => {
      const next = { ...m }
      for (const [f] of rotas) next[f] = '__new__'
      return next
    })
  }, [columns, configLoaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const newCount = useMemo(() => orderedSelected.filter((f) => mapping[f] === '__new__').length, [orderedSelected, mapping])
  // Columnas del RENGLÓN que también se van a crear (las que quedaron en "automáticamente").
  const newSubCount = useMemo(
    () => ['description', ...SUB_METRICS].filter((k) => liMap[k] === '__auto__').length,
    [liMap],
  )

  // ─── Splash a pantalla completa: mientras conecta con monday O carga las
  // columnas del tablero. Mostramos SOLO el spinner centrado (sin el chrome del
  // wizard a medio armar). Sin texto: evita el flash de idioma equivocado. ───
  const booting = !previewMode && !error && (!context || (boardId && loading))
  if (booting) {
    return (
      <div className="splash">
        <div className="splash-logo">IR</div>
        <div className="splash-spinner" aria-label="Loading" />
      </div>
    )
  }

  // ─── Welcome page: para tableros sin configurar, descartable (localStorage). ───
  const showWelcome = ready && configLoaded && !hasSetup && !welcomeDismissed
  if (showWelcome) {
    return (
      <div className="welcome">
        <div className="welcome-lang">
          {LANGUAGES.map((l) => (
            <button key={l.code} className={language === l.code ? 'active' : ''} onClick={() => changeLanguage(l.code)}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="welcome-card">
          <div className="welcome-logo">IR</div>
          <div className="welcome-kicker">{t('welcome.kicker')}</div>
          <h1 className="welcome-title">{t('welcome.title')}</h1>
          <p className="welcome-sub">{t('welcome.sub')}</p>
          <div className="welcome-steps">
            <div className="welcome-step"><span className="welcome-step-n">1</span><span>{t('welcome.s1')}</span></div>
            <div className="welcome-step"><span className="welcome-step-n">2</span><span>{t('welcome.s2')}</span></div>
            <div className="welcome-step"><span className="welcome-step-n">3</span><span>{t('welcome.s3')}</span></div>
          </div>
          <button className="welcome-cta" onClick={dismissWelcome}>{t('welcome.cta')}</button>
          <a className="welcome-help" href="/onboarding" target="_blank" rel="noopener">{t('welcome.help')}</a>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {/* ───── Sidebar ───── */}
      <aside className="gd-sidebar">
        <div className="sb-brand">
          <div className="sb-logo">IR</div>
          <div>
            <div className="sb-brand-name">{t('brand.name')}</div>
            <div className="sb-brand-sub">{boardName || 'monday.com'}</div>
          </div>
        </div>

        <div>
          <div className="gd-checklist-heading">{t('wizard.heading')}</div>
          <nav className="gd-steps">
            {steps.map((s) => (
              <button
                key={s.n}
                className={`gd-check-item ${step === s.n ? 'active' : ''}`}
                onClick={() => setStep(s.n)}
                disabled={!ready}
              >
                <span className={`gd-check-mark ${s.mark}`}>{s.mark === 'complete' ? '✓' : s.n}</span>
                <span className="gd-check-text">
                  <span className="gd-check-label">{s.label}</span>
                  <span className={`gd-check-status ${s.status}`}>{s.statusText}</span>
                </span>
              </button>
            ))}
          </nav>
        </div>

        <div className="sb-foot">
          {usage && (
            <div className="sb-usage">
              <span className="sb-usage-label">{t('usage.label')}</span>
              <span className="sb-usage-val">
                {usage.limit != null
                  ? t('usage.valueLimited', { month: usage.month, limit: usage.limit })
                  : t('usage.value', { month: usage.month, total: usage.total })}
              </span>
              {usage.planLabel && <span className="sb-usage-plan">{t('usage.plan', { plan: usage.planLabel })}</span>}
            </div>
          )}
          <div className="lang-switch">
            {LANGUAGES.map((l) => (
              <button key={l.code} className={language === l.code ? 'active' : ''} onClick={() => changeLanguage(l.code)}>
                {l.label}
              </button>
            ))}
          </div>
          {/* Sello de compilación. Sin esto, cuando lo que se ve y lo que se guarda
              no coinciden, no hay forma de saber si el navegador cargó el código
              nuevo o uno viejo de caché — y se pierde el tiempo adivinando. */}
          <div className="build-tag" title="versión de la app">{__BUILD__}</div>
        </div>
      </aside>

      {/* ───── Main ───── */}
      <div className="gd-main">
        <header className="gd-header">
          <div className="gd-header-main">
            <h1 className="gd-header-title">
              {allReq ? t('hero.donePre') : t('hero.todoPre')}{' '}
              <span className="gd-header-accent">{allReq ? t('hero.doneAccent') : t('hero.todoAccent')}</span>
            </h1>
            <p className="gd-header-sub">{t('hero.sub')}</p>
          </div>
          <div className="gd-header-progress">
            <div className="gd-ring">
              <svg width="96" height="96" viewBox="0 0 96 96">
                <circle className="gd-ring-track" cx="48" cy="48" r={RING_R} fill="none" strokeWidth="8" />
                <circle
                  className="gd-ring-fill" cx="48" cy="48" r={RING_R} fill="none" strokeWidth="8"
                  strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - completed / 3)}
                />
              </svg>
              <div className="gd-ring-num">{completed}<small>/3</small></div>
            </div>
            <div className="gd-header-progress-label">{t('hero.progressLabel')}</div>
          </div>
        </header>

        {previewMode && <div className="preview-banner">{t('preview.banner')}</div>}
        {context && !boardId && !previewMode && <p className="muted">{t('state.noBoard')}</p>}
        {error && <p className="error">⚠️ {error}</p>}

        {ready && (
          <>
            <div className="gd-content">
              {/* ───── Paso 1 · Países ───── */}
              {step === 1 && (
                <section>
                  <h2 className="step-title">{t('step1.title')}</h2>
                  {/* Tipo de documento y país, sin rótulos: los chips se explican
                      solos y el subtítulo repetía lo que ya dice el chip elegido. */}
                  <div className="chip-select">
                    {['fiscal', 'remito'].map((k) => (
                      <button
                        type="button" key={k}
                        className={`chip ${kindElegido && docKind === k ? 'on' : ''}`}
                        onClick={() => cambiarTipo(k)}
                      >{t('kind.' + k)}{kindElegido && docKind === k && <span className="chip-ck">✓</span>}</button>
                    ))}
                  </div>
                  {/* Tablero nuevo: primero el tipo. Hasta elegirlo no hay país ni mapeo. */}
                  {!previewMode && !kindElegido && (
                    <div className="pick-country">{t('kind.pickFirst')}</div>
                  )}

                  {(kindElegido || previewMode) && (
                    <>
                      <div className="q-label" style={{ marginTop: 16 }}>
                        {t('step1.countries')} <span className="q-hint">{t('step1.countriesHint')}</span>
                        {tipEl(t('step1.countriesTip'))}
                      </div>
                      <div className="chip-select">
                        {[...new Set([...LAUNCH_COUNTRIES, ...countries])].map((c) => (
                          <button
                            type="button" key={c}
                            className={`chip ${countries.includes(c) ? 'on' : ''}`}
                            onClick={() => toggleCountry(c)}
                          >{t('country.' + c)}{countries.includes(c) && <span className="chip-ck">✓</span>}</button>
                        ))}
                      </div>
                    </>
                  )}
                  {/* Sin país elegido → no se muestra la config (el producto es por país). */}
                  {!previewMode && kindElegido && countries.length === 0 && (
                    <div className="pick-country">{t('step1.pickCountry')}</div>
                  )}
                  {/* ¿Qué querés cargar? — paquetes + preview + ajuste fino */}
                  {!previewMode && kindElegido && countries.length > 0 && (
                    <div style={{ marginTop: 18 }}>
                      {/* UNA sola lista: cada dato de la factura → su columna. Sin vista
                          previa alternativa, sin paquetes, sin bloque aparte de renglones.
                          El desplegable ES el control: elegís columna, creás una nueva, o
                          no cargás ese dato. Los renglones van como un grupo más al final
                          (sus columnas viven en el tablero de subítems, por eso el
                          desplegable ofrece otras opciones). */}
                      <div className="mapbar">
                        <span>{t('map.count', { n: selectedFields.length + subCount, total: allFields.length + LI_ALL.length })}</span>
                        <span className="maphelp">{t('map.help')}</span>
                      </div>
                      <div className="map-list">
                        <div className="map-cols">
                          {fieldGroups(countries, docKind).map((g) => (
                            <div className="fg" key={g.zone}>
                              <h4>{t('group.' + g.zone)}</h4>
                              {g.fields.map((f) => (
                                <div className={`map-row ${selectedFields.includes(f) ? '' : 'off'}`} key={f}>
                                  <span className="map-f">{t('field.' + f)}{fieldTip(f)}</span>
                                  <span className="map-ar">→</span>
                                  {fieldSel(f)}
                                </div>
                              ))}
                            </div>
                          ))}
                          {/* Renglones de la factura → subítems. Mismo formato. */}
                          <div className="fg">
                            <h4>{t('subitem.groupTitle')}</h4>
                            <div className={`map-row ${liMap.description ? '' : 'off'}`}>
                              <span className="map-f">{t('lineitems.description')}</span>
                              <span className="map-ar">→</span>
                              <select className="map-select" value={liMap.description || ''} onChange={(e) => setLi('description', e.target.value)}>
                                <option value="">{t('map.off')}</option>
                                <option value="name">{t('subitem.intoName')}</option>
                                <option value="__auto__">➕ {t('adv.new')}</option>
                                {!!subColumns.length && (
                                  <optgroup label={t('map.boardCols')}>
                                    {subColumns.filter((c) => ['text', 'long-text', 'long_text'].includes(c.type)).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                                  </optgroup>
                                )}
                              </select>
                            </div>
                            {SUB_METRICS.map((k) => (
                              <div className={`map-row ${liMap[k] ? '' : 'off'}`} key={k}>
                                <span className="map-f">{t('lineitems.' + k)}</span>
                                <span className="map-ar">→</span>
                                <select className="map-select" value={liMap[k] || ''} onChange={(e) => setLi(k, e.target.value)}>
                                  <option value="">{t('map.off')}</option>
                                  <option value="__auto__">➕ {t('adv.new')}</option>
                                  {!!subColumns.length && (
                                    <optgroup label={t('map.boardCols')}>
                                      {liCompatible(k, subColumns).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                                    </optgroup>
                                  )}
                                </select>
                              </div>
                            ))}
                            {liMap.description && liMap.description !== 'name' && (
                              <div className="gd-note soft" style={{ marginTop: 8 }}>{t('subitem.nameFree')}</div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Barra pegada al borde de abajo: el mapeo es largo y el botón
                          quedaba fuera de pantalla — se elegían columnas y se salían sin
                          aplicar. Ahora viaja con el scroll y se resalta mientras haya
                          columnas por crear. */}
                      <div className={`create-row apply-bar ${newCount + newSubCount ? 'hot' : ''}`}>
                        {saveStatusEl}
                        <button className="save-btn apply-btn" disabled={(!selectedFields.length && !newSubCount) || prepState === 'working'} onClick={() => setConfirmOpen(true)}>
                          {prepState === 'working' ? t('prep.working') : prepState === 'done' ? t('prep.done') : t('map.apply')}
                        </button>
                      </div>
                      {prepState === 'done' && (
                        <div className="done-next">
                          <span>{t('prep.doneNext')}</span>
                          <button className="save-btn" onClick={() => setStep(2)}>{t('prep.goActivate')}</button>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

              {/* ───── Paso 2 · Activar lectura ───── */}
              {step === 2 && (
                <section>
                  <h2 className="step-title">{t('activar.title')}</h2>
                  <p className="step-lead">{t('activar.lead')}</p>
                  <div className="gd-note soft" style={{ marginBottom: 18 }}>{t('activar.why')}</div>
                  {/* Guía visual: capturas REALES de monday con el botón señalado.
                      Un texto "apretá Automatizar arriba a la derecha" obliga a buscar;
                      la captura con el redondel dice exactamente dónde tocar. */}
                  <div className="gtabs">
                    {[1, 2, 3, 4].map((n) => (
                      <button type="button" key={n} className={`gtab ${guideStep === n ? 'on' : ''}`} onClick={() => setGuideStep(n)}>
                        <b>{n}</b> {t(`activar.tab${n}`)}
                      </button>
                    ))}
                  </div>
                  <div className="gshot">
                    <img src={`guia/paso${guideStep}.png`} alt={t(`activar.tab${guideStep}`)} />
                  </div>
                  <p className="gcap">{t(`activar.cap${guideStep}`)}</p>
                  <div className="usehint">
                    <span className="dz-ic">📄</span>
                    <div><b>{t('activar.useTitle')}</b><div className="gstep-sub">{t('activar.useSub')}</div></div>
                  </div>
                  <div className="create-row">
                    <span className="muted-sm">{automationConfirmed ? t('activar.confirmedNote') : t('activar.confirmNote')}</span>
                    <button
                      className="save-btn"
                      onClick={() => { setAutomationConfirmed((v) => !v); touch() }}
                    >{automationConfirmed ? t('activar.undo') : t('activar.confirm')}</button>
                  </div>
                </section>
              )}

              {/* ───── Paso 3 · Reglas ───── */}
              {step === 3 && (
                <section>
                  <h2 className="step-title">{t('step3.title')}</h2>
                  <p className="step-lead">{t('step3.lead')}</p>

                  {/* Dos grupos: la izquierda decide QUÉ entra al tablero, la derecha
                      CÓMO se escribe. Son preguntas distintas; juntas se leían como una
                      lista larga de 6 interruptores sueltos. */}
                  <div className="rgroup">{t('rules.groupWhat')}</div>

                  <div className="gd-card">
                    <div className="gd-card-head"><span className="gd-card-title">{t('rules.dedup.title')}</span></div>
                    <div className="gd-toggle-row">
                      <button
                        type="button"
                        className={`gd-switch ${dedupEnabled ? 'on' : ''}`}
                        aria-pressed={dedupEnabled}
                        onClick={() => { setDedupEnabled((v) => !v); touch() }}
                      />
                      <div className="gd-toggle-text">
                        <div className="gd-toggle-label">{dedupEnabled ? t('rules.dedup.onLabel') : t('rules.dedup.offLabel')}</div>
                        <div className="gd-toggle-help">{t('rules.dedup.help')}{tipEl(t('rules.dedup.detail'))}</div>
                      </div>
                    </div>
                  </div>

                  <div className="gd-card" style={{ marginTop: 18 }}>
                    <div className="gd-card-head"><span className="gd-card-title">{t('rules.fiscal.title')}</span></div>
                    <div className="gd-toggle-row">
                      <button
                        type="button"
                        className={`gd-switch ${onlyFiscalDocs ? 'on' : ''}`}
                        aria-pressed={onlyFiscalDocs}
                        onClick={() => { setOnlyFiscalDocs((v) => !v); touch() }}
                      />
                      <div className="gd-toggle-text">
                        <div className="gd-toggle-label">{onlyFiscalDocs ? t('rules.fiscal.onLabel') : t('rules.fiscal.offLabel')}</div>
                        <div className="gd-toggle-help">{t('rules.fiscal.help')}{tipEl(t('rules.fiscal.detail'))}</div>
                      </div>
                    </div>
                  </div>

                  {/* Lista blanca de IDs fiscales: cargar SOLO las facturas cuyo
                      receptor (o emisor) esté en la lista. Pedido concreto: un
                      tablero de compras que solo debe registrar lo emitido a MI CUIT. */}
                  <div className="gd-card" style={{ marginTop: 18 }}>
                    <div className="gd-card-head"><span className="gd-card-title">{t('rules.taxid.title')}</span></div>
                    <div className="gd-toggle-row">
                      <button
                        type="button"
                        className={`gd-switch ${filterMode !== 'all' ? 'on' : ''}`}
                        aria-pressed={filterMode !== 'all'}
                        onClick={() => { setFilterMode(filterMode === 'all' ? 'customer' : 'all'); touch() }}
                      />
                      <div className="gd-toggle-text">
                        <div className="gd-toggle-label">{filterMode !== 'all' ? t('rules.taxid.onLabel') : t('rules.taxid.offLabel')}</div>
                        <div className="gd-toggle-help">{t('rules.taxid.help')}{tipEl(t('rules.taxid.detail'))}</div>
                      </div>
                    </div>
                    {filterMode !== 'all' && (
                      <>
                        <div className="gd-subrow">
                          <label className="gd-sublabel" htmlFor="fmode">{t('rules.taxid.whose')}</label>
                          <select id="fmode" className="gd-select" value={filterMode}
                            onChange={(e) => { setFilterMode(e.target.value); touch() }}>
                            <option value="customer">{t('rules.taxid.customer')}</option>
                            <option value="supplier">{t('rules.taxid.supplier')}</option>
                          </select>
                        </div>
                        <div className="gd-subrow">
                          <label className="gd-sublabel" htmlFor="taxid">{t('rules.taxid.list')}</label>
                          <input
                            id="taxid" className="gd-input" style={{ width: 'auto', minWidth: 170 }}
                            value={taxIdDraft} placeholder={t('rules.taxid.placeholder')}
                            onChange={(e) => setTaxIdDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTaxId() } }}
                          />
                          <button type="button" className="gd-btn-ghost" onClick={addTaxId}>{t('rules.taxid.add')}</button>
                          {!filterTaxIds.length && <div className="gd-subwarn">{t('rules.taxid.empty')}</div>}
                        </div>
                        {!!filterTaxIds.length && (
                          <div className="taxid-chips">
                            {filterTaxIds.map((id) => (
                              <span key={id} className="taxid-chip">{id}
                                <button type="button" onClick={() => removeTaxId(id)} aria-label={`Quitar ${id}`}>×</button>
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="rgroup">{t('rules.groupHow')}</div>

                  {/* Actualizar el estado. Prendida por defecto. La columna la elige el
                      usuario: sin elección y con varias columnas de estado, la app NO
                      escribe (antes adivinaba y le pisaba columnas propias). */}
                  <div className="gd-card">
                    <div className="gd-card-head"><span className="gd-card-title">{t('rules.status.title')}</span></div>
                    <div className="gd-toggle-row">
                      <button
                        type="button"
                        className={`gd-switch ${statusEnabled ? 'on' : ''}`}
                        aria-pressed={statusEnabled}
                        onClick={() => { setStatusEnabled((v) => !v); touch() }}
                      />
                      <div className="gd-toggle-text">
                        <div className="gd-toggle-label">{statusEnabled ? t('rules.status.onLabel') : t('rules.status.offLabel')}</div>
                        <div className="gd-toggle-help">{t('rules.status.help')}{tipEl(t('rules.status.detail'))}</div>
                      </div>
                    </div>
                    {statusEnabled && (
                      <div className="gd-subrow">
                        <label className="gd-sublabel" htmlFor="statusCol">{t('rules.status.column')}</label>
                        <select
                          id="statusCol"
                          className="gd-select"
                          value={statusColumnId}
                          onChange={(e) => { setStatusColumnId(e.target.value); touch() }}
                        >
                          <option value="">{t('rules.status.pick')}</option>
                          {statusColumns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                        </select>
                        {!statusColumnId && statusColumns.length > 1 && (
                          <div className="gd-subwarn">{t('rules.status.needPick')}</div>
                        )}
                        {!statusColumns.length && (
                          <div className="gd-subwarn">{t('rules.status.none')}</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="gd-card" style={{ marginTop: 18 }}>
                    <div className="gd-card-head"><span className="gd-card-title">{t('rules.rename.title')}</span></div>
                    <div className="gd-toggle-row">
                      <button
                        type="button"
                        className={`gd-switch ${renameItemEnabled ? 'on' : ''}`}
                        aria-pressed={renameItemEnabled}
                        onClick={() => { setRenameItemEnabled((v) => !v); touch() }}
                      />
                      <div className="gd-toggle-text">
                        <div className="gd-toggle-label">{renameItemEnabled ? t('rules.rename.onLabel') : t('rules.rename.offLabel')}</div>
                        <div className="gd-toggle-help">{t('rules.rename.help')}{tipEl(t('rules.rename.detail'))}</div>
                      </div>
                    </div>
                  </div>

                  <div className="gd-note">{t('rules.savedNote')}</div>
                </section>
              )}

            </div>

            {/* ───── Barra de estado ─────
                Ya no tiene botón: la config se guarda sola. Queda solo para que el
                usuario SEPA que se guardó (si no, no hay señal de nada). El Paso 2 es
                una guía, no hay nada que guardar. */}
            {step !== 2 && !(step === 1 && !previewMode && countries.length > 0) && (
              <div className="gd-savebar">{saveStatusEl}</div>
            )}

            {/* Cambiar de tipo de documento borra el mapeo: se pregunta adentro de la
                vista y no con un alert del navegador, que se ve como un error del sitio. */}
            {kindPend && (
              <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) setKindPend(null) }}>
                <div className="modal" role="dialog" aria-modal="true">
                  <h3>{t('kind.switchTitle', { tipo: t('kind.' + kindPend) })}</h3>
                  <div className="msub">{t('kind.switchWarn')}</div>
                  <div className="m-btns">
                    <button className="m-cancel" onClick={() => setKindPend(null)}>{t('confirm.cancel')}</button>
                    <button className="m-confirm" onClick={() => aplicarTipo(kindPend)}>{t('kind.switchOk')}</button>
                  </div>
                </div>
              </div>
            )}

            {/* Confirmación informativa al crear columnas */}
            {confirmOpen && (
              <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) setConfirmOpen(false) }}>
                <div className="modal" role="dialog" aria-modal="true">
                  {newFields.length > 0 ? (
                    <>
                      <h3>{t('confirm.title', { n: newFields.length })}</h3>
                      <div className="msub">{t('confirm.sub')}{orderedSelected.length > newFields.length ? ' ' + t('confirm.reuse', { m: orderedSelected.length - newFields.length }) : ''}</div>
                      <div className="m-list">{newFields.map((f) => <span key={f}>{t('field.' + f)}</span>)}</div>
                    </>
                  ) : (
                    <>
                      <h3>{t('confirm.allExist')}</h3>
                      <div className="msub">{t('confirm.allExistSub')}</div>
                    </>
                  )}
                  <div className="m-ok">{t('confirm.noDelete')}</div>
                  <div className="m-btns">
                    <button className="m-cancel" onClick={() => setConfirmOpen(false)}>{t('confirm.cancel')}</button>
                    <button className="m-confirm" onClick={() => { setConfirmOpen(false); prepareBoard() }}>{newFields.length > 0 ? t('confirm.create', { n: newFields.length }) : t('confirm.done')}</button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
