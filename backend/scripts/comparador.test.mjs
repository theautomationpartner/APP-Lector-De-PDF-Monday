// comparador.test.mjs — El comparador del banco de prueba decide si el modelo
// acertó. Si él se equivoca, todas las conclusiones se equivocan (pasó: la
// primera versión daba por errados CUIT correctos escritos con guiones). Estos
// casos reproducen los errores que aparecieron en comprobantes reales, con
// datos inventados (el repo es publico). NO gasta API.
//   node scripts/comparador.test.mjs
import { acierta } from './comparador.mjs'

const casos = [
  // [campo, esperado, obtenido, ¿acierta?, por qué]
  ['supplier_tax_id', '20111111112', '20-11111111-2', true, 'mismo CUIT con guiones'],
  ['customer_tax_id', '30222222223', '27-22222222-3', false, 'CUIT con digitos cambiados de lugar'],
  ['customer_tax_id', '30333333334', '80333333334', false, 'un 3 leido como 8'],
  ['supplier_tax_id', '30444444448', '3044444444B', false, 'un 8 leido como B'],
  ['ar_cae', '12345678901234', '12345678901834', false, 'CAI con un digito cambiado'],
  ['ar_cae', '', '00019-00012345', false, 'invento un CAE que el tique no trae (puso el numero)'],
  ['ar_cae', '', '', true, 'no hay CAE y no inventó'],
  ['ar_cae', '12345678901234', '', false, 'habia CAI y lo dejo vacio'],
  ['invoice_number', '00001-00000902', '0001-00000902', true, 'mismo comprobante, PV con otro ancho'],
  ['invoice_number', '00031-00004844', '0003-00004844', false, 'punto de venta equivocado'],
  ['invoice_number', '00031-00004844', '0003100004844', true, 'tal cual impreso, sin guion'],
  ['invoice_number', '00009-00123485', '00009-00123495', false, 'un digito del numero'],
  ['invoice_number', '00001-00000902', '0001-99999999', false, 'mismo PV pero otro número'],
  ['ar_punto_venta', '00031', '0031', true, 'mismo PV, otro ancho'],
  ['ar_punto_venta', '00031', '0003', false, 'otro PV'],
  ['ar_impuestos_internos', '11756.32', '1756.32', false, 'se comio el primer digito'],
  ['total_amount', '70020.05', '70020.050', true, 'mismo importe'],
  ['total_amount', '38010', '38010.00', true, 'mismo importe, con decimales'],
  ['subtotal', '48151.84', '', false, 'importe que quedó vacío'],
  ['issue_date', '2026-08-05', '2026-08-05', true, 'misma fecha'],
  ['issue_date', '2026-08-05', '2026-05-08', false, 'día y mes dados vuelta'],
  ['customer_name', 'EJEMPLO S.A.', 'EJEMPLO SA', true, 'mismo nombre, sin puntos'],
  ['ar_domicilio_entrega', 'tandil', 'Tandil, Buenos Aires', true, 'contiene la localidad'],
  ['ar_domicilio_entrega', 'tandil', 'Calle Falsa 123', false, 'otro domicilio'],
  ['document_class', 'invoice', 'delivery_note', false, 'clasificó una factura como remito'],
]

let fallos = 0
for (const [campo, esp, got, debe, porque] of casos) {
  const dio = acierta(campo, esp, got)
  if (dio !== debe) fallos++
  console.log(`${dio === debe ? ' ok ' : 'MAL '} ${campo.padEnd(22)} "${esp}" vs "${got}" → ${dio ? 'acierto' : 'error'}  (${porque})`)
}
console.log(fallos ? `\n${fallos} caso(s) mal — el comparador NO es confiable` : `\nOK — ${casos.length} casos, el comparador distingue bien`)
process.exit(fallos ? 1 : 0)
