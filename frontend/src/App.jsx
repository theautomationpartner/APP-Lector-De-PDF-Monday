import { useEffect, useMemo, useRef, useState } from 'react'
import mondaySdk from 'monday-sdk-js'
import { makeT, LANGUAGES } from './i18n.js'
import { ALL_FIELDS, COUNTRIES, CURRENCIES } from './fields.js'

// Instancia única del SDK de monday. Dentro del iframe del board, monday.api()
// usa la sesión del usuario logueado — no hace falta token ni backend todavía.
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

// Config que se guarda por (cuenta, tablero). La columna de estado que dispara
// la lee el backend solo (auto-detección), no se configura acá.
// NOTA: hoy persiste en el Storage de monday (preview = localStorage). En deploy
// pasa a POST/GET contra el backend (Postgres) — saveConfig/loadConfig aislados.
const DEFAULT_CONFIG = {
  language: 'en',
  mapping: {},
  defaultCountry: '',
  defaultCurrency: '',
}

export default function App() {
  const [context, setContext] = useState(null)
  const [boardName, setBoardName] = useState('')
  const [columns, setColumns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [previewMode, setPreviewMode] = useState(false)

  const [language, setLanguage] = useState('en')
  const [mapping, setMapping] = useState({})
  const [defaultCountry, setDefaultCountry] = useState('')
  const [defaultCurrency, setDefaultCurrency] = useState('')

  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error
  const [dirty, setDirty] = useState(false)
  const contextArrived = useRef(false)

  const t = useMemo(() => makeT(language), [language])

  // 1) Escuchar el context de monday → de ahí sale el boardId.
  useEffect(() => {
    const unsubscribe = monday.listen('context', (res) => {
      contextArrived.current = true
      setPreviewMode(false)
      setContext(res.data)
    })
    let timer
    if (import.meta.env.DEV) {
      timer = setTimeout(() => {
        if (!contextArrived.current) setPreviewMode(true)
      }, 2500)
    }
    return () => {
      try { unsubscribe() } catch { /* noop */ }
      clearTimeout(timer)
    }
  }, [])

  const boardId = context?.boardId || context?.boardIds?.[0] || null

  // 2) Cargar columnas: de monday (boardId real) o de ejemplo (preview).
  useEffect(() => {
    if (previewMode) {
      setBoardName('Sample board')
      setColumns(MOCK_COLUMNS)
      setError(null)
      setLoading(false)
      return
    }
    if (!boardId) return
    setLoading(true)
    monday
      .api(`query { boards(ids: [${boardId}]) { name columns { id title type } } }`)
      .then((res) => {
        const board = res?.data?.boards?.[0]
        setBoardName(board?.name || '')
        setColumns(board?.columns || [])
        setError(null)
      })
      .catch((err) => setError(err?.message || 'Could not load columns'))
      .finally(() => setLoading(false))
  }, [boardId, previewMode])

  const ready = !loading && !error && (previewMode || boardId)
  const mappedCount = useMemo(() => ALL_FIELDS.filter((id) => mapping[id]).length, [mapping])

  // 3) Cargar la config guardada del board (backend/Postgres; localStorage en preview).
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const apply = (cfg) => {
      if (cancelled) return
      setLanguage(cfg.language || 'en')
      setMapping(cfg.mapping || {})
      setDefaultCountry(cfg.defaultCountry || '')
      setDefaultCurrency(cfg.defaultCurrency || '')
      setDirty(false)
    }
    ;(async () => {
      try {
        if (previewMode) {
          const raw = localStorage.getItem('config:preview')
          if (raw) apply({ ...DEFAULT_CONFIG, ...JSON.parse(raw) })
        } else if (boardId) {
          const token = await getSessionToken()
          const r = await fetch(`/api/config/${boardId}`, {
            headers: token ? { Authorization: token } : {},
          })
          if (r.ok) apply({ ...DEFAULT_CONFIG, ...(await r.json()) })
        }
      } catch { /* sin config previa, arranca vacío */ }
    })()
    return () => { cancelled = true }
  }, [ready, boardId, previewMode])

  const touch = () => { setDirty(true); setSaveState('idle') }
  const handleMap = (fieldId, value) => {
    setMapping((m) => ({ ...m, [fieldId]: value }))
    touch()
  }
  const changeLanguage = (lng) => { setLanguage(lng); touch() }

  // País y moneda son obligatorios para poder guardar.
  const canSave = dirty && !!defaultCountry && !!defaultCurrency && saveState !== 'saving'

  const saveConfig = async () => {
    if (!canSave) return
    setSaveState('saving')
    try {
      const cfg = { language, mapping, defaultCountry, defaultCurrency }
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
      } else {
        return
      }
      setSaveState('saved')
      setDirty(false)
    } catch {
      setSaveState('error')
    }
  }

  // Dropdown de mapeo: campo de factura → columna del board.
  const mapSel = (fieldId, placeholder) => (
    <select
      className={`map-select ${mapping[fieldId] ? 'mapped' : 'unmapped'}`}
      value={mapping[fieldId] || ''}
      onChange={(e) => handleMap(fieldId, e.target.value)}
    >
      <option value="">— {placeholder || t('placeholder.column')} —</option>
      {columns.map((c) => (
        <option key={c.id} value={c.id}>{c.title}</option>
      ))}
    </select>
  )

  const Field = ({ id }) => (
    <div className="field">
      <span className="field-label">{t(`field.${id}`)}</span>
      {mapSel(id)}
    </div>
  )

  return (
    <div className="app">
      <header className="header">
        <div className="logo">IR</div>
        <div className="header-text">
          <h1>{t('app.title')}</h1>
          <p className="subtitle">
            {boardName ? t('app.subtitleBoard', { name: boardName }) : t('app.subtitleMap')}
          </p>
        </div>
        <div className="lang-switch">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              className={language === l.code ? 'active' : ''}
              onClick={() => changeLanguage(l.code)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </header>

      {previewMode && <div className="preview-banner">{t('preview.banner')}</div>}

      {!context && !previewMode && <p className="muted">{t('state.connecting')}</p>}
      {context && !boardId && !previewMode && <p className="muted">{t('state.noBoard')}</p>}
      {!previewMode && boardId && loading && <p className="muted">{t('state.loadingColumns')}</p>}
      {error && <p className="error">⚠️ {error}</p>}

      {ready && (
        <>
          {/* ───── País / Moneda (obligatorios) ───── */}
          <div className="settings-card">
            <div className="settings-grid">
              <div className="settings-field">
                <label>{t('settings.country')} <span className="req">*</span></label>
                <select
                  className="plain-select"
                  value={defaultCountry}
                  onChange={(e) => { setDefaultCountry(e.target.value); touch() }}
                >
                  <option value="">{t('settings.select')}</option>
                  {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="settings-field">
                <label>{t('settings.currency')} <span className="req">*</span></label>
                <select
                  className="plain-select"
                  value={defaultCurrency}
                  onChange={(e) => { setDefaultCurrency(e.target.value); touch() }}
                >
                  <option value="">{t('settings.select')}</option>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* ───── Mapeo (facsímil de factura) ───── */}
          <div className="invoice-frame">
            <div className="invoice-frame-head">
              <div className="legend">
                <span><i className="swatch mapped" /> {t('legend.mapped')}</span>
                <span><i className="swatch unmapped" /> {t('legend.unmapped')}</span>
              </div>
            </div>

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
                  <div className="meta-row"><span>{t('field.po_number')}</span>{mapSel('po_number')}</div>
                  <div className="meta-row"><span>{t('field.currency')}</span>{mapSel('currency')}</div>
                </div>
              </div>

              <div className="invoice-parties">
                <div className="party">
                  <div className="party-title">{t('group.supplier')}</div>
                  <Field id="supplier_name" />
                  <Field id="supplier_tax_id" />
                  <Field id="supplier_address" />
                </div>
                <div className="party">
                  <div className="party-title">{t('group.customer')}</div>
                  <Field id="customer_name" />
                  <Field id="customer_tax_id" />
                  <Field id="customer_address" />
                </div>
              </div>

              {/* Tabla de renglones — llega en v2 (subítems) */}
              <table className="invoice-table">
                <thead>
                  <tr>
                    <th style={{ width: '40%' }}>{t('lineItems.concept')}</th>
                    <th>{t('lineItems.qty')}</th>
                    <th>{t('lineItems.unit')}</th>
                    <th>{t('lineItems.tax')}</th>
                    <th>{t('lineItems.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="ghost"><td colSpan="5">{t('lineItems.note')}</td></tr>
                </tbody>
              </table>

              <div className="invoice-totals">
                <div className="t-row"><span>{t('field.subtotal')}</span>{mapSel('subtotal')}</div>
                <div className="t-row"><span>{t('field.tax_amount')}</span>{mapSel('tax_amount')}</div>
                <div className="t-row"><span>{t('field.amount_due')}</span>{mapSel('amount_due')}</div>
                <div className="t-row total"><span>{t('field.total_amount')}</span>{mapSel('total_amount')}</div>
              </div>

              <div className="invoice-footer other-grid">
                <Field id="payment_terms" />
                <Field id="notes" />
              </div>
            </div>

            <div className="save-bar">
              <span className="map-counter">
                {t('save.counter', { n: mappedCount, total: ALL_FIELDS.length })}
              </span>
              <span className={`save-status ${saveState}`}>
                {saveState === 'saving' && t('save.saving')}
                {saveState === 'saved' && t('save.saved')}
                {saveState === 'error' && t('save.error')}
                {saveState === 'idle' && dirty && t('save.dirty')}
              </span>
              <button className="save-btn" onClick={saveConfig} disabled={!canSave}>
                {t('save.button')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}