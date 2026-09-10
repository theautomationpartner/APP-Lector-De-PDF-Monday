// gen-ar-fixtures.mjs — Genera FACTURAS ARGENTINAS SINTÉTICAS de prueba (todos los
// casos de uso) para validar el extractor SIN depender de facturas reales.
// Cada caso produce: <id>.pdf (con QR formato AFIP válido) + <id>.truth.json (lo que
// la extracción DEBERÍA dar). No gasta API. Uso:  node scripts/gen-ar-fixtures.mjs
//
// Las facturas son CLARAMENTE DE PRUEBA (entidades ficticias, CAE inválido, leyenda
// "SIN VALIDEZ FISCAL"): sirven solo como fixtures de QA, no son comprobantes reales.
import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ar')
mkdirSync(OUT, { recursive: true })

// ── Helpers ──────────────────────────────────────────────────────────────────
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const fmtMoney = (n) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pad = (n, l) => String(n || 0).padStart(l, '0')
const fmtCuit = (c) => { const s = String(c).replace(/\D/g, '').padStart(11, '0'); return `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` }
const fmtDate = (iso) => iso.slice(0, 10).split('-').reverse().join('/') // YYYY-MM-DD → DD/MM/YYYY
// CUIT válido (dígito verificador módulo 11) a partir de 10 dígitos (prefijo+base).
function mkCuit(pre10) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const s = String(pre10).padStart(10, '0').slice(0, 10)
  let dv = 11 - (w.reduce((a, d, i) => a + d * Number(s[i]), 0) % 11); if (dv === 11) dv = 0; if (dv === 10) dv = 9
  return s + String(dv)
}
// Tipo AFIP (código → [base, letra]) — igual que el pack ar.mjs.
const TIPO = {
  1: ['Factura', 'A'], 2: ['Nota de Débito', 'A'], 3: ['Nota de Crédito', 'A'],
  6: ['Factura', 'B'], 8: ['Nota de Crédito', 'B'], 11: ['Factura', 'C'], 19: ['Factura', 'E'],
}
const classOf = (base) => base.includes('Crédito') ? 'credit_note' : base.includes('Débito') ? 'debit_note' : 'invoice'

// QR con formato AFIP (base64(JSON) en arca.gob.ar/fe/qr) — lo que decodifica qr.mjs.
async function qrPng(q) {
  const url = `https://www.afip.gob.ar/fe/qr/?p=${Buffer.from(JSON.stringify(q)).toString('base64')}`
  return QRCode.toBuffer(url, { type: 'png', width: 600, margin: 4, errorCorrectionLevel: 'M' })
}

// ── Cálculo de totales de un caso ────────────────────────────────────────────
function compute(s) {
  const letra = TIPO[s.cbteTipo][1]
  const iva = { '27': 0, '21': 0, '10.5': 0 }
  let neto = 0
  const items = s.lineas.map((l) => {
    const sub = round2(l.qty * l.price)
    neto = round2(neto + sub)
    if (letra === 'A') iva[l.ali] = round2(iva[l.ali] + sub * (Number(l.ali) / 100))
    return { ...l, sub }
  })
  const ivaTotal = round2(iva['27'] + iva['21'] + iva['10.5'])
  const p = s.percep || {}
  const percepTotal = round2((p.iva || 0) + (p.iibb || 0) + (p.ganancias || 0) + (p.internos || 0) + (p.otros || 0))
  const noGravado = s.noGravado || 0, exento = s.exento || 0
  const total = letra === 'A'
    ? round2(neto + noGravado + exento + ivaTotal + percepTotal)
    : round2(neto + percepTotal)
  return { items, neto, iva, ivaTotal, percepTotal, noGravado, exento, total }
}

// ── Render del PDF (layout tipo ARCA, foco en el TEXTO correcto) ──────────────
async function renderPdf(s, c) {
  const [base, letra] = TIPO[s.cbteTipo]
  const titulo = base === 'Factura' ? 'FACTURA' : base.toUpperCase()
  const isA = letra === 'A', isExt = s.moneda === 'DOL'
  const sym = isExt ? 'USD' : '$'
  const qr = await qrPng({
    ver: 1, fecha: s.fecha, cuit: Number(s.emisor.cuit), ptoVta: Number(s.ptoVta), tipoCmp: s.cbteTipo,
    nroCmp: Number(s.nroCmp), importe: c.total, moneda: s.moneda, ctz: s.ctz || 1,
    tipoDocRec: s.receptor.cuit ? 80 : 99, nroDocRec: s.receptor.cuit ? Number(s.receptor.cuit) : 0,
    tipoCodAut: 'E', codAut: Number(s.cae),
  })

  const doc = new PDFDocument({ size: 'A4', margin: 40 })
  const bufs = []; doc.on('data', (b) => bufs.push(b))
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(bufs))))
  const M = 40, W = 595.28 - M * 2, Lx = M, Rx = M + W
  let y = M

  // Cabecera: letra + emisor + comprobante
  doc.rect(Lx, y, W, 72).stroke()
  doc.rect(Lx + W / 2 - 22, y, 44, 44).stroke()
  doc.font('Helvetica-Bold').fontSize(26).text(letra, Lx + W / 2 - 22, y + 6, { width: 44, align: 'center' })
  doc.fontSize(7).text('COD. ' + pad(s.cbteTipo, 2), Lx + W / 2 - 22, y + 34, { width: 44, align: 'center' })
  doc.font('Helvetica-Bold').fontSize(12).text(s.emisor.name, Lx + 8, y + 6, { width: W / 2 - 40 })
  doc.font('Helvetica').fontSize(8)
  doc.text('Razón Social: ' + s.emisor.name, Lx + 8, y + 28, { width: W / 2 - 30 })
  doc.text('Domicilio: ' + s.emisor.address, Lx + 8, y + 40, { width: W / 2 - 30 })
  doc.text('Condición frente al IVA: ' + s.emisor.cond, Lx + 8, y + 52, { width: W / 2 - 30 })
  const rx = Lx + W / 2 + 32
  doc.font('Helvetica-Bold').fontSize(13).text(titulo, rx, y + 6, { width: W / 2 - 40 })
  doc.font('Helvetica').fontSize(8)
  doc.text(`Punto de Venta: ${pad(s.ptoVta, 5)}    Comp. Nro: ${pad(s.nroCmp, 8)}`, rx, y + 28)
  doc.text(`Fecha de Emisión: ${fmtDate(s.fecha)}`, rx, y + 40)
  doc.text(`CUIT: ${fmtCuit(s.emisor.cuit)}`, rx, y + 52)
  doc.text(`Ingresos Brutos: ${s.emisor.ib}    Inicio de Actividades: ${fmtDate(s.emisor.inicio)}`, rx, y + 62, { width: W / 2 - 20 })
  y += 80

  // Período (solo servicios)
  if (s.periodo) {
    doc.rect(Lx, y, W, 16).stroke()
    doc.font('Helvetica').fontSize(8).text(
      `Período Facturado Desde: ${fmtDate(s.periodo.desde)}    Hasta: ${fmtDate(s.periodo.hasta)}    Fecha de Vto. para el pago: ${fmtDate(s.periodo.vto)}`,
      Lx + 8, y + 4)
    y += 18
  }

  // Receptor
  doc.rect(Lx, y, W, 42).stroke()
  doc.fontSize(8)
  doc.text(`CUIT: ${s.receptor.cuit ? fmtCuit(s.receptor.cuit) : '-'}`, Lx + 8, y + 5)
  doc.text(`Apellido y Nombre / Razón Social: ${s.receptor.name}`, Lx + W / 2, y + 5, { width: W / 2 - 10 })
  doc.text(`Condición frente al IVA: ${s.receptor.cond}`, Lx + 8, y + 18)
  doc.text(`Domicilio: ${s.receptor.address}`, Lx + W / 2, y + 18, { width: W / 2 - 10 })
  doc.text('Condición de venta: Contado', Lx + 8, y + 31)
  y += 44

  // Comprobante asociado (NC/ND)
  if (s.compAsociado) {
    doc.rect(Lx, y, W, 14).stroke()
    doc.fontSize(8).text(`Comprobante Asociado: ${s.compAsociado}`, Lx + 8, y + 3)
    y += 16
  }

  // Tabla de ítems
  const cols = isA
    ? [['Código', 0.07], ['Producto / Servicio', 0.33], ['Cant.', 0.07], ['Precio Unit.', 0.13], ['Subtotal', 0.13], ['Alíc. IVA', 0.10], ['Subtotal c/IVA', 0.17]]
    : [['Código', 0.08], ['Producto / Servicio', 0.44], ['Cant.', 0.08], ['Precio Unit.', 0.18], ['Subtotal', 0.22]]
  doc.rect(Lx, y, W, 16).fill('#eee').stroke(); doc.fillColor('#000')
  let cx = Lx
  for (const [label, w] of cols) { doc.font('Helvetica-Bold').fontSize(7).text(label, cx + 2, y + 5, { width: W * w - 4, align: 'center' }); cx += W * w }
  y += 16
  for (let i = 0; i < c.items.length; i++) {
    const it = c.items[i]
    const cells = isA
      ? [String(i + 1).padStart(3, '0'), it.desc, String(it.qty), fmtMoney(it.price), fmtMoney(it.sub), `${it.ali}%`, fmtMoney(round2(it.sub * (1 + Number(it.ali) / 100)))]
      : [String(i + 1).padStart(3, '0'), it.desc, String(it.qty), fmtMoney(it.price), fmtMoney(it.sub)]
    doc.rect(Lx, y, W, 14).stroke()
    cx = Lx
    for (let k = 0; k < cols.length; k++) { doc.font('Helvetica').fontSize(7).text(cells[k], cx + 2, y + 4, { width: W * cols[k][1] - 4, align: k === 1 ? 'left' : 'right' }); cx += W * cols[k][1] }
    y += 14
  }

  // Totales (derecha)
  y += 10
  const line = (label, val) => { doc.font('Helvetica-Bold').fontSize(8).text(`${label} ${sym} ${fmtMoney(val)}`, Rx - 260, y, { width: 260, align: 'right' }); y += 12 }
  if (isA) {
    line('Importe Neto Gravado:', c.neto)
    if (c.noGravado) line('Importe Neto No Gravado:', c.noGravado)
    if (c.exento) line('Importe Exento:', c.exento)
    for (const a of ['27', '21', '10.5']) if (c.iva[a]) line(`IVA ${a.replace('.', ',')}%:`, c.iva[a])
    const p = s.percep || {}
    if (p.iva) line('Percepción de IVA RG 3337:', p.iva)
    if (p.iibb) line('Percepción de Ingresos Brutos (IIBB):', p.iibb)
    if (p.ganancias) line('Percepción de Ganancias RG 830:', p.ganancias)
    if (p.internos) line('Impuestos Internos:', p.internos)
    if (p.otros) line('Otros Tributos (tasas municipales):', p.otros)
  } else {
    line('Subtotal:', c.neto)
    if (c.percepTotal) line('Importe Otros Tributos:', c.percepTotal)
    if (letra === 'B') doc.font('Helvetica').fontSize(7).text('Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)', Rx - 320, y, { width: 320, align: 'right' }), y += 10
  }
  doc.font('Helvetica-Bold').fontSize(9).text(`Importe Total: ${sym} ${fmtMoney(c.total)}`, Rx - 260, y, { width: 260, align: 'right' }); y += 14
  if (isExt) { doc.font('Helvetica-Bold').fontSize(8).text(`Moneda: USD - Dólar Estadounidense    Cotización: ${fmtMoney(s.ctz)}`, Rx - 320, y, { width: 320, align: 'right' }); y += 14 }

  // QR + CAE (abajo)
  const qy = 720
  doc.image(qr, Lx + 8, qy, { fit: [92, 92] })
  doc.font('Helvetica-Bold').fontSize(9).text(`CAE N°: ${s.cae}`, Lx + 110, qy + 28)
  doc.text(`Fecha de Vto. de CAE: ${fmtDate(s.caeVto)}`, Lx + 110, qy + 42)
  doc.font('Helvetica').fontSize(7).fillColor('#888').text('COMPROBANTE DE PRUEBA — SIN VALIDEZ FISCAL (fixture de QA)', Lx, 812, { width: W, align: 'center' })

  doc.end()
  return done
}

// ── "Verdad" esperada (lo que el extractor debería devolver, post-QR) ─────────
function truth(s, c) {
  const [base, letra] = TIPO[s.cbteTipo]
  const name = `${base} ${letra}`
  const t = {
    document_type: name, document_class: classOf(base),
    invoice_number: `${pad(s.ptoVta, 5)}-${pad(s.nroCmp, 8)}`  // impreso con 5, como AFIP, issue_date: s.fecha,
    currency: s.moneda === 'DOL' ? 'USD' : 'ARS',
    supplier_name: s.emisor.name, supplier_tax_id: fmtCuit(s.emisor.cuit),
    customer_name: s.receptor.name, customer_tax_id: s.receptor.cuit ? fmtCuit(s.receptor.cuit) : '',
    subtotal: c.neto, tax_amount: letra === 'A' ? c.ivaTotal : '', total_amount: c.total,
    ar_tipo_comprobante: name, ar_punto_venta: pad(s.ptoVta, 5), ar_cae: String(s.cae), ar_cae_vto: s.caeVto,
    ar_condicion_iva: s.emisor.cond, ar_condicion_iva_receptor: s.receptor.cond,
    ar_neto_no_gravado: c.noGravado || '', ar_exento: c.exento || '',
    ar_iva_21: c.iva['21'] || '', ar_iva_105: c.iva['10.5'] || '', ar_iva_27: c.iva['27'] || '',
    ar_percepcion_iva: s.percep?.iva || '', ar_percepcion_iibb: s.percep?.iibb || '',
    ar_percepcion_ganancias: s.percep?.ganancias || '', ar_impuestos_internos: s.percep?.internos || '',
    ar_otros_tributos: s.percep?.otros || '',
    ar_periodo_desde: s.periodo?.desde || '', ar_periodo_hasta: s.periodo?.hasta || '',
    ar_cotizacion: s.moneda === 'DOL' ? s.ctz : '',
    line_items: c.items.map((it) => ({ description: it.desc, quantity: it.qty, unit_price: it.price, total: it.sub })),
  }
  return t
}

// ── CASOS DE USO ──────────────────────────────────────────────────────────────
const E1 = { name: 'DISTRIBUIDORA DEMO S.A.', cuit: mkCuit('3012345678'), address: 'Av. Siempreviva 1234, CABA', cond: 'Responsable Inscripto', ib: '901-234567-8', inicio: '2015-03-01' }
const E2 = { name: 'SERVICIOS PRUEBA S.R.L.', cuit: mkCuit('3055667788'), address: 'Calle Falsa 742, Rosario, Santa Fe', cond: 'Responsable Inscripto', ib: 'Convenio Multilateral', inicio: '2018-07-15' }
const E3 = { name: 'KIOSCO EL MONO (Monotributo)', cuit: mkCuit('2033445566'), address: 'San Martín 55, Tandil, Bs.As.', cond: 'Responsable Monotributo', ib: 'Exento', inicio: '2021-01-10' }
const RI = { name: 'FERRETERÍA INDUSTRIAL S.A.', cuit: mkCuit('3099887766'), cond: 'Responsable Inscripto', address: 'Ruta 8 Km 50, Pilar, Bs.As.' }
const CF = { name: 'Consumidor Final', cuit: null, cond: 'Consumidor Final', address: '-' }
const EXT = { name: 'ACME GLOBAL INC.', cuit: null, cond: 'Cliente del Exterior', address: '350 5th Ave, New York, USA' }

const CASES = [
  { id: 'a-basica', cbteTipo: 1, ptoVta: 1, nroCmp: 101, fecha: '2026-07-30', cae: '75210000000101', caeVto: '2026-08-09', moneda: 'PES',
    emisor: E1, receptor: RI, lineas: [ { desc: 'Caño estructural 40x40', qty: 100, price: 500, ali: '21' }, { desc: 'Perfil U 100mm', qty: 50, price: 1000, ali: '21' } ] },
  { id: 'a-percep-iibb', cbteTipo: 1, ptoVta: 32, nroCmp: 2468, fecha: '2026-07-30', cae: '86316000002468', caeVto: '2026-08-09', moneda: 'PES',
    emisor: E1, receptor: RI, lineas: [ { desc: 'Chapa galvanizada', qty: 200, price: 800, ali: '21' } ], percep: { iibb: 3360 } },
  { id: 'a-percep-todas', cbteTipo: 1, ptoVta: 5, nroCmp: 777, fecha: '2026-06-15', cae: '75210000000777', caeVto: '2026-06-25', moneda: 'PES',
    emisor: E1, receptor: RI, lineas: [ { desc: 'Bulones grado 8', qty: 1000, price: 200, ali: '21' } ], percep: { iva: 3000, iibb: 4000, ganancias: 2000, internos: 1500, otros: 500 } },
  { id: 'a-multi-alicuota', cbteTipo: 1, ptoVta: 3, nroCmp: 55, fecha: '2026-07-01', cae: '75210000000055', caeVto: '2026-07-11', moneda: 'PES',
    emisor: E1, receptor: RI, lineas: [ { desc: 'Servicio de flete', qty: 1, price: 100000, ali: '21' }, { desc: 'Alimento balanceado (reducido)', qty: 100, price: 500, ali: '10.5' }, { desc: 'Energía (27%)', qty: 1, price: 20000, ali: '27' } ] },
  { id: 'a-nogravado-exento', cbteTipo: 1, ptoVta: 7, nroCmp: 300, fecha: '2026-07-20', cae: '75210000000300', caeVto: '2026-07-30', moneda: 'PES',
    emisor: E1, receptor: RI, lineas: [ { desc: 'Mercadería gravada', qty: 1, price: 80000, ali: '21' } ], noGravado: 10000, exento: 5000 },
  { id: 'a-servicios', cbteTipo: 1, ptoVta: 12, nroCmp: 900, fecha: '2026-08-01', cae: '75210000000900', caeVto: '2026-08-11', moneda: 'PES',
    emisor: E2, receptor: RI, periodo: { desde: '2026-07-01', hasta: '2026-07-31', vto: '2026-08-10' }, lineas: [ { desc: 'Abono mensual soporte IT', qty: 1, price: 60000, ali: '21' } ] },
  { id: 'b-consumidor-final', cbteTipo: 6, ptoVta: 4, nroCmp: 1500, fecha: '2026-07-28', cae: '75210000001500', caeVto: '2026-08-07', moneda: 'PES',
    emisor: E1, receptor: CF, lineas: [ { desc: 'Kit herramientas', qty: 1, price: 121000, ali: '21' } ] },
  { id: 'c-monotributo', cbteTipo: 11, ptoVta: 2, nroCmp: 88, fecha: '2026-07-25', cae: '75210000000088', caeVto: '2026-08-04', moneda: 'PES',
    emisor: E3, receptor: CF, lineas: [ { desc: 'Reparación de bicicleta', qty: 1, price: 45000, ali: '21' } ] },
  { id: 'e-exportacion-usd', cbteTipo: 19, ptoVta: 4, nroCmp: 45, fecha: '2026-07-10', cae: '75210000000045', caeVto: '2026-07-20', moneda: 'DOL', ctz: 1350,
    emisor: E1, receptor: EXT, lineas: [ { desc: 'Aluminum profiles (export)', qty: 500, price: 20, ali: '21' } ] },
  { id: 'nc-a', cbteTipo: 3, ptoVta: 32, nroCmp: 2470, fecha: '2026-08-02', cae: '86316000002470', caeVto: '2026-08-12', moneda: 'PES',
    emisor: E1, receptor: RI, compAsociado: 'Factura A 0032-00002468', lineas: [ { desc: 'Devolución chapa galvanizada', qty: 20, price: 800, ali: '21' } ], percep: { iibb: 336 } },
  { id: 'nd-a', cbteTipo: 2, ptoVta: 32, nroCmp: 2471, fecha: '2026-08-03', cae: '86316000002471', caeVto: '2026-08-13', moneda: 'PES',
    emisor: E1, receptor: RI, compAsociado: 'Factura A 0032-00002468', lineas: [ { desc: 'Intereses por mora', qty: 1, price: 5000, ali: '21' } ] },
]

// ── Main ──────────────────────────────────────────────────────────────────────
for (const s of CASES) {
  const c = compute(s)
  const pdf = await renderPdf(s, c)
  writeFileSync(join(OUT, `${s.id}.pdf`), pdf)
  writeFileSync(join(OUT, `${s.id}.truth.json`), JSON.stringify(truth(s, c), null, 2))
  console.log(`✓ ${s.id.padEnd(22)} ${TIPO[s.cbteTipo].join(' ')}  total ${c.total}  (${c.items.length} renglón/es)`)
}
console.log(`\n${CASES.length} fixtures generados en fixtures/ar/`)
