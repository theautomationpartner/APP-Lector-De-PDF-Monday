// comparar-modelos.mjs — Corre uno o más modelos sobre el BANCO DE PRUEBA y
// compara contra la verdad verificada A MANO (leyendo el comprobante), no
// contra otro modelo. Reporta aciertos por campo, por tipo de documento y por
// dificultad, y el gasto exacto de la corrida.
//
// ⚠️ GASTA API: una llamada por comprobante POR MODELO. Uso:
//   node scripts/comparar-modelos.mjs <carpeta-casos> [--modelos=a,b] [--etiqueta=texto] [--solo=facil|media|dificil]
//
// Cada caso es un <id>.verdad.json con:
//   { archivo, tipo, dificultad, descripcion, media_type, hints, campos }
// "archivo" es relativo a la carpeta de casos. Un campo con "" también es verdad:
// prueba que el modelo NO invente (ej: los tiques de nafta no traen CAE).
//
// Cada corrida se guarda en <carpeta-casos>/../resultados/, así se pueden
// comparar prompts o modelos entre sí sin volver a gastar.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { extractInvoice } from '../extractor.mjs'
import { acierta } from './comparador.mjs'
import 'dotenv/config'

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=')
const DIR = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'casos')
const MODELOS = (arg('modelos') || 'claude-haiku-4-5,claude-sonnet-5').split(',')
const ETIQUETA = arg('etiqueta') || 'sin-etiqueta'
const SOLO = arg('solo')

// Precio por millón de tokens (entrada / salida).
const PRECIO = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
}

// La comparación por tipo de dato vive en comparador.mjs (tiene su propio test).

// ── Corrida ────────────────────────────────────────────────────────────────────
let casos = readdirSync(DIR).filter((f) => f.endsWith('.verdad.json'))
  .map((f) => ({ id: f.replace('.verdad.json', ''), ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }))
if (SOLO) casos = casos.filter((c) => c.dificultad === SOLO)
if (!casos.length) { console.error(`No hay casos en ${DIR}`); process.exit(1) }
console.log(`${casos.length} casos · modelos: ${MODELOS.join(', ')} · etiqueta: ${ETIQUETA}`)

const vacio = () => ({ ok: 0, mal: 0 })
const tot = Object.fromEntries(MODELOS.map((m) => [m, { ...vacio(), inTok: 0, outTok: 0, errApi: 0, porTipo: {}, porDif: {}, porCampo: {}, fallos: [] }]))
const detalle = []

for (const caso of casos) {
  const buf = readFileSync(resolve(DIR, caso.archivo))
  process.stdout.write(`\n${caso.tipo.padEnd(7)} ${caso.dificultad.padEnd(7)} ${caso.id}  ${caso.descripcion.slice(0, 60)}\n`)
  for (const modelo of MODELOS) {
    const t = tot[modelo]
    let r = null
    try {
      r = await extractInvoice(buf.toString('base64'), caso.media_type, modelo, caso.hints || {})
      t.inTok += r.usage.input_tokens
      t.outTok += r.usage.output_tokens
    } catch (e) {
      t.errApi++
      console.log(`   ${modelo}: ERROR — ${e.message}`)
    }
    const filas = []
    let okCaso = 0
    for (const [campo, esp] of Object.entries(caso.campos)) {
      const got = r?.data?.[campo] ?? ''
      const ok = r ? acierta(campo, esp, got) : false
      filas.push({ campo, esperado: esp, obtenido: got, ok })
      for (const bucket of [t, (t.porTipo[caso.tipo] ??= vacio()), (t.porDif[caso.dificultad] ??= vacio()), (t.porCampo[campo] ??= vacio())]) bucket[ok ? 'ok' : 'mal']++
      if (ok) okCaso++
      else t.fallos.push(`${caso.id} ${campo}: esperaba "${esp}" y dio "${got}"`)
    }
    console.log(`   ${modelo.padEnd(18)} ${okCaso}/${filas.length}${filas.some((f) => !f.ok) ? '   ✗ ' + filas.filter((f) => !f.ok).map((f) => f.campo).join(', ') : ''}`)
    detalle.push({ id: caso.id, tipo: caso.tipo, dificultad: caso.dificultad, modelo, filas, usage: r?.usage || null })
  }
}

// ── Resumen ────────────────────────────────────────────────────────────────────
const pct = (b) => { const n = b.ok + b.mal; return n ? `${b.ok}/${n} (${((b.ok / n) * 100).toFixed(0)}%)` : '-' }
const costoDe = (m) => { const p = PRECIO[m] || { in: 0, out: 0 }; return (tot[m].inTok * p.in + tot[m].outTok * p.out) / 1e6 }

console.log(`\n${'='.repeat(78)}\nRESUMEN — ${ETIQUETA}\n${'='.repeat(78)}`)
for (const m of MODELOS) {
  const t = tot[m], c = costoDe(m)
  console.log(`\n${m}`)
  console.log(`  total      : ${pct(t)}${t.errApi ? `   (${t.errApi} llamadas fallaron)` : ''}`)
  for (const k of ['factura', 'remito']) if (t.porTipo[k]) console.log(`  ${k.padEnd(10)} : ${pct(t.porTipo[k])}`)
  for (const k of ['facil', 'media', 'dificil']) if (t.porDif[k]) console.log(`  ${k.padEnd(10)} : ${pct(t.porDif[k])}`)
  console.log(`  gasto      : US$ ${c.toFixed(4)}  ·  US$ ${(c / casos.length).toFixed(4)} por comprobante  ·  US$ ${((c / casos.length) * 1000).toFixed(2)} cada 1.000`)
  const peores = Object.entries(t.porCampo).filter(([, b]) => b.mal).sort((a, b) => b[1].mal - a[1].mal).slice(0, 6)
  if (peores.length) console.log(`  campos que más fallan: ${peores.map(([k, b]) => `${k} (${b.mal})`).join(', ')}`)
}
const total = MODELOS.reduce((s, m) => s + costoDe(m), 0)
console.log(`\nGASTO TOTAL DE ESTA CORRIDA: US$ ${total.toFixed(4)}`)

// Se guarda TODO (lo esperado y lo obtenido de cada campo) para poder comparar
// corridas después sin volver a llamar a la API.
const outDir = join(dirname(DIR), 'resultados')
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const out = join(outDir, `${stamp}_${ETIQUETA}.json`)
writeFileSync(out, JSON.stringify({ etiqueta: ETIQUETA, fecha: new Date().toISOString(), modelos: MODELOS, gasto_usd: total, resumen: tot, detalle }, null, 2))
console.log(`Resultados guardados en ${out}`)
