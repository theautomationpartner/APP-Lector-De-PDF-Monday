import { useEffect, useMemo, useRef, useState } from 'react'
import mondaySdk from 'monday-sdk-js'
import { makeT, LANGUAGES } from './i18n.js'
import { ALL_FIELDS, COUNTRY_FIELDS, fieldsForCountries, COUNTRIES, autoMapColumns } from './fields.js'

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
}

export default function App() {
  const [context, setContext] = useState(null)
  const [boardName, setBoardName] = useState('')
  const [columns, setColumns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [previewMode, setPreviewMode] = useState(false)

  const [step, setStep] = useState(2) // abre en Mapeo (el paso esencial); Países/Reglas son opcionales
  const [language, setLanguage] = useState('en')
  const [mapping, setMapping] = useState({})
  const [fileColumnId, setFileColumnId] = useState('')
  const [countries, setCountries] = useState([])
  const [dedupEnabled, setDedupEnabled] = useState(false)

  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error
  const [dirty, setDirty] = useState(false)
  const [autoMappedCount, setAutoMappedCount] = useState(0)
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
      setBoardName('Sample board'); setColumns(MOCK_COLUMNS); setError(null); setLoading(false); return
    }
    if (!boardId) return
    setLoading(true)
    monday
      .api(`query { boards(ids: [${boardId}]) { name columns { id title type } } }`)
      .then((res) => {
        const board = res?.data?.boards?.[0]
        setBoardName(board?.name || ''); setColumns(board?.columns || []); setError(null)
      })
      .catch((err) => setError(err?.message || 'Could not load columns'))
      .finally(() => setLoading(false))
  }, [boardId, previewMode])

  const ready = !loading && !error && (previewMode || boardId)
  // Campos activos = universales + capas de los países elegidos (ej. AR → CAE, etc.).
  const activeFields = useMemo(() => fieldsForCountries(countries), [countries])
  const mappedCount = useMemo(() => activeFields.filter((id) => mapping[id]).length, [mapping, activeFields])
  const fileColumns = useMemo(() => columns.filter((c) => c.type === 'file'), [columns])
  // Columnas usadas por más de un campo (se pisan entre sí).
  const dupColumns = useMemo(() => {
    const seen = new Set(), dups = new Set()
    for (const f of activeFields) { const c = mapping[f]; if (c) { if (seen.has(c)) dups.add(c); else seen.add(c) } }
    return dups.size
  }, [mapping, activeFields])

  // 3) Cargar la config guardada (backend/Postgres; localStorage en preview).
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const apply = (cfg) => {
      if (cancelled) return
      setLanguage(cfg.language || 'en')
      setMapping(cfg.mapping || {})
      setFileColumnId(cfg.fileColumnId || '')
      setCountries(cfg.countries || [])
      setDedupEnabled(!!cfg.dedupEnabled)
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
      // Si no hay mapeo guardado, pre-mapeamos las columnas por nombre/tipo.
      const savedMapping = cfg?.mapping && Object.keys(cfg.mapping).length > 0
      setHasSetup(!!savedMapping)
      setConfigLoaded(true)
      if (!savedMapping && columns.length) {
        const auto = autoMapColumns(columns)
        const n = Object.keys(auto).length
        if (n > 0) { setMapping(auto); setDirty(true); setSaveState('idle'); setAutoMappedCount(n) }
        // Si hay UNA sola columna de archivo, la preseleccionamos.
        const fc = columns.filter((c) => c.type === 'file')
        if (fc.length === 1 && !cfg?.fileColumnId) setFileColumnId(fc[0].id)
      }
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

  const touch = () => { setDirty(true); setSaveState('idle') }
  const handleMap = (fieldId, value) => { setMapping((m) => ({ ...m, [fieldId]: value })); touch() }
  const changeLanguage = (lng) => { setLanguage(lng); touch() }
  const toggleCountry = (c) => { setCountries((a) => a.includes(c) ? a.filter((x) => x !== c) : [...a, c]); touch() }

  // Nada es obligatorio: se puede guardar cualquier cambio.
  const canSave = dirty && saveState !== 'saving'

  const collectConfig = () => ({
    language, mapping, fileColumnId, countries,
    dedupEnabled,
  })

  const saveConfig = async () => {
    if (!canSave) return
    setSaveState('saving')
    try {
      const cfg = collectConfig()
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
      setSaveState('saved'); setDirty(false)
    } catch { setSaveState('error') }
  }


  // ─── Estado de los pasos (solo el mapeo es requerido; el resto opcional) ───
  const done1 = countries.length > 0
  const done2 = mappedCount > 0
  const rulesTouched = dedupEnabled
  const completed = [done1, done2, rulesTouched].filter(Boolean).length
  const steps = [
    { n: 1, label: t('step1.label'), mark: done1 ? 'complete' : '', status: 'optional', statusText: t('status.optional') },
    { n: 2, label: t('step2.label'), mark: done2 ? 'complete' : 'pending', status: done2 ? 'complete' : 'pending', statusText: done2 ? t('status.done') : t('status.pending') },
    { n: 3, label: t('step3.label'), mark: rulesTouched ? 'complete' : '', status: 'optional', statusText: t('status.optional') },
  ]

  const allReq = done2
  const RING_R = 42
  const RING_C = 2 * Math.PI * RING_R

  // ─── Helpers de UI ───
  const mapSel = (fieldId, placeholder) => (
    <select
      className={`map-select ${mapping[fieldId] ? 'mapped' : 'unmapped'}`}
      value={mapping[fieldId] || ''}
      onChange={(e) => handleMap(fieldId, e.target.value)}
    >
      <option value="">— {placeholder || t('placeholder.column')} —</option>
      {columns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
    </select>
  )
  const Field = ({ id }) => (
    <div className="field"><span className="field-label">{t(`field.${id}`)}</span>{mapSel(id)}</div>
  )

  // ─── Splash neutro: mientras conecta con monday, SIN texto (evita el flash de
  // idioma equivocado que el reviewer no debe ver). ───
  if (!context && !previewMode) {
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
        {!context && !previewMode && <p className="muted">{t('state.connecting')}</p>}
        {context && !boardId && !previewMode && <p className="muted">{t('state.noBoard')}</p>}
        {!previewMode && boardId && loading && <p className="muted">{t('state.loadingColumns')}</p>}
        {error && <p className="error">⚠️ {error}</p>}

        {ready && (
          <>
            <div className="gd-content">
              {/* ───── Paso 1 · Países ───── */}
              {step === 1 && (
                <section>
                  <div className="step-eyebrow">{t('step1.eyebrow')}</div>
                  <h2 className="step-title">{t('step1.title')}</h2>
                  <p className="step-lead">{t('step1.lead')}</p>
                  <div className="gd-card">
                    <div className="field-block">
                      <label className="gd-label">{t('step1.countries')}</label>
                      <div className="chip-select">
                        {COUNTRIES.map((c) => (
                          <button
                            type="button" key={c}
                            className={`chip ${countries.includes(c) ? 'on' : ''}`}
                            onClick={() => toggleCountry(c)}
                          >{t('country.' + c)}</button>
                        ))}
                      </div>
                    </div>
                    <div className="gd-note soft">{t('step1.allNote')}</div>
                  </div>
                </section>
              )}

              {/* ───── Paso 2 · Mapeo ───── */}
              {step === 2 && (
                <section>
                  <div className="step-eyebrow">{t('step2.eyebrow')}</div>
                  <h2 className="step-title">{t('step2.title')}</h2>
                  <p className="step-lead">{t('step2.lead')}</p>

                  <div className="gd-card" style={{ marginBottom: 18 }}>
                    <label className="gd-label">📎 {t('step2.fileColumn')}</label>
                    <select
                      className="gd-select"
                      value={fileColumnId}
                      onChange={(e) => { setFileColumnId(e.target.value); touch() }}
                    >
                      <option value="">{t('step2.fileAuto')}</option>
                      {fileColumns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                    </select>
                    {fileColumns.length === 0 && <div className="gd-note">{t('step2.fileNone')}</div>}
                  </div>
                  <div className="legend">
                    <span><i className="swatch mapped" /> {t('legend.mapped')}</span>
                    <span><i className="swatch unmapped" /> {t('legend.unmapped')}</span>
                  </div>
                  {autoMappedCount > 0 && <div className="gd-note soft" style={{ marginTop: 0, marginBottom: 16 }}>{t('automap.banner', { n: autoMappedCount })}</div>}
                  {dupColumns > 0 && <div className="gd-note warn" style={{ marginTop: 0, marginBottom: 16 }}>{t('map.dupWarn', { n: dupColumns })}</div>}

                  <div className="invoice">
                    <div className="invoice-head">
                      <div className="invoice-id">
                        <div className="invoice-title">{t('invoice.title')}</div>
                        <div className="invoice-type-sel">{mapSel('document_type', t('placeholder.type'))}</div>
                      </div>
                      <div className="invoice-meta">
                        <div className="meta-row"><span>{t('field.invoice_number')}</span>{mapSel('invoice_number')}</div>
                        <div className="meta-row"><span>{t('field.issue_date')}</span>{mapSel('issue_date')}</div>
                        <div className="meta-row"><span>{t('field.due_date')}</span>{mapSel('due_date')}</div>
                        <div className="meta-row"><span>{t('field.currency')}</span>{mapSel('currency')}</div>
                      </div>
                    </div>

                    <div className="invoice-parties">
                      <div className="party">
                        <div className="party-title">{t('group.supplier')}</div>
                        <Field id="supplier_name" /><Field id="supplier_tax_id" /><Field id="supplier_address" />
                      </div>
                      <div className="party">
                        <div className="party-title">{t('group.customer')}</div>
                        <Field id="customer_name" /><Field id="customer_tax_id" /><Field id="customer_address" />
                      </div>
                    </div>

                    <div className="invoice-totals">
                      <div className="t-row"><span>{t('field.subtotal')}</span>{mapSel('subtotal')}</div>
                      <div className="t-row"><span>{t('field.tax_amount')}</span>{mapSel('tax_amount')}</div>
                      <div className="t-row total"><span>{t('field.total_amount')}</span>{mapSel('total_amount')}</div>
                    </div>

                    <div className="invoice-footer other-grid">
                      <Field id="payment_terms" />
                    </div>
                  </div>

                  {/* Capas de campos específicos por país (solo los países configurados) */}
                  {countries.filter((c) => COUNTRY_FIELDS[c]?.length).map((c) => (
                    <div className="gd-card country-card" style={{ marginTop: 18 }} key={c}>
                      <div className="gd-card-head">
                        <span className="gd-card-title">{t(`countryGroup.${c}`)}</span>
                        <span className="gd-card-tag">{t('countryGroup.tag')}</span>
                      </div>
                      <div className="country-grid">
                        {COUNTRY_FIELDS[c].map((id) => <Field id={id} key={id} />)}
                      </div>
                    </div>
                  ))}
                </section>
              )}

              {/* ───── Paso 3 · Reglas ───── */}
              {step === 3 && (
                <section>
                  <div className="step-eyebrow">{t('step3.eyebrow')}</div>
                  <h2 className="step-title">{t('step3.title')}</h2>
                  <p className="step-lead">{t('step3.lead')}</p>

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
                        <div className="gd-toggle-help">{t('rules.dedup.help')}</div>
                      </div>
                    </div>
                  </div>

                  <div className="gd-note">{t('rules.savedNote')}</div>
                </section>
              )}

            </div>

            {/* ───── Save bar ───── */}
            <div className="gd-savebar">
              <span className="map-counter">{t('save.counter', { n: mappedCount, total: activeFields.length })}</span>
              <span className={`save-status ${saveState === 'idle' && dirty ? 'idle' : saveState}`}>
                {saveState === 'saving' && t('save.saving')}
                {saveState === 'saved' && t('save.saved')}
                {saveState === 'error' && t('save.error')}
                {saveState === 'idle' && dirty && t('save.dirty')}
              </span>
              <button className="save-btn" onClick={saveConfig} disabled={!canSave}>{t('save.button')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
