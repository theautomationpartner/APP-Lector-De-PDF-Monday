// countries/ar.remito.mjs — Pack de Argentina para REMITOS.
//
// Por qué es un archivo aparte y no unas reglas más en ar.mjs: un remito es otro
// documento, no una factura sin importes. Y sobre todo, PIERDE las dos redes que
// llevaron las facturas argentinas al 100%:
//   · no tiene QR de AFIP (lleva CAI de imprenta, no CAE electrónico)
//   · el 96% son escaneos sin capa de texto (medido sobre 192 remitos reales de
//     dos clientes y dos rubros: aberturas y agroquímicos)
// O sea: acá todo sale de la vista del modelo. No hay ground truth contra qué
// corregir. Los únicos controles posibles son de forma (largo del CAI, dígito
// verificador del CUIT) y avisan, no corrigen.
import { cuitValido } from './ar.mjs'

// enrich: sin QR no hay nada que pisar. Solo controles de sanidad que dejan aviso.
export async function enrich(data, ctx = {}) {
  const warnings = []

  // El CAI de imprenta tiene 14 dígitos, igual que el CAE. Si no son 14, se leyó mal.
  const cai = String(data.ar_cae || '').replace(/\D/g, '')
  if (cai && cai.length !== 14) {
    console.warn(`[AR-remito] ⚠️ CAI con ${cai.length} dígitos (deberían ser 14): "${data.ar_cae}"`)
    warnings.push({ key: 'warnCae', vars: { cae: data.ar_cae, n: cai.length } })
  }

  // Dígito verificador del CUIT. En un remito escaneado es el error más probable
  // (el renglón del CUIT es la línea más chica del papel) y no hay QR que lo salve.
  for (const campo of ['supplier_tax_id', 'customer_tax_id']) {
    const v = data[campo]
    if (!v || String(v).replace(/\D/g, '').length !== 11) continue
    if (cuitValido(v)) continue
    const quien = campo === 'supplier_tax_id' ? 'emisor' : 'receptor'
    console.warn(`[AR-remito] ⚠️ CUIT del ${quien} inválido: "${v}"`)
    warnings.push({ key: 'warnCuit', vars: { cuit: v, quien } })
  }

  return { source: 'llm', control: null, warnings }
}

export const prompt =
`ARGENTINA — guía para leer REMITOS. Un remito acompaña la MERCADERÍA: dice qué se
entregó y cuánto, NO cuánto cuesta. REGLA DE ORO: extraé SOLO lo IMPRESO; si un dato
no aparece, devolvé "" (vacío) — nunca 0, nunca un valor inferido.

1) QUÉ ES. Lleva la letra R y "CÓDIGO Nº 91" (el tipo de comprobante de AFIP para
remitos), y casi siempre la leyenda "Documento no válido como factura". Otros
nombres: "Remito", "Nota de Entrega", "Remito de Retiro". document_class siempre
"delivery_note".

2) NÚMERO. Punto de venta + número correlativo. El punto de venta tiene 4 o 5 dígitos
según el emisor: copiá la cantidad TAL COMO ESTÁ IMPRESA, no la lleves a 4. El número
correlativo va con 8 dígitos, completando con ceros a la izquierda.
   • "0028-01105914"   → "0028-01105914",  ar_punto_venta "0028"
   • "Nº 0202-00011630" → "0202-00011630", ar_punto_venta "0202"
   • "0003R00188890"   → "0003-00188890",  ar_punto_venta "0003"
   • "N° 0007 - 1438"  → "0007-00001438",  ar_punto_venta "0007"

3) AUTORIZACIÓN. El remito NO lleva CAE electrónico: lleva C.A.I. de imprenta
(14 dígitos), abajo de todo, junto a su fecha de vencimiento. Ponelo igual en
ar_cae. ⚠️ ar_cae_vto SOLO si está impreso — NO lo calcules sumándole días a nada.

4) TRES DOMICILIOS DISTINTOS. No los mezcles:
   • supplier_address = domicilio del que EMITE el remito.
   • customer_address = domicilio fiscal del cliente (el del encabezado "Señor(es)").
   • ar_domicilio_entrega = A DÓNDE VA LA MERCADERÍA ("Entregar en", "Domicilio de
     entrega", "DOM. ENTREGA", "Dirección destino"). Suele ser distinto del fiscal,
     y es el dato que más importa en un remito. Si no está impreso, "".

5) TRANSPORTE. ar_transportista = el nombre del transporte ("Transporte",
"Transportista", "TPTE."). Si el bloque del transporte imprime su propio CUIT, va en
ar_transportista_cuit — NO lo confundas con el del emisor ni con el del cliente.

6) ⚠️ EL VALOR DECLARADO NO ES UN PRECIO. "Valor Declarado", "V. Aprox", "Valor para
Flete" es el monto que se declara para el SEGURO del flete. No es un total a pagar y
no es una factura. Va en ar_valor_declarado y en ningún otro campo. Un remito NO
tiene neto, IVA ni total: si ves precios unitarios y un total a pagar, entonces el
documento NO es un remito.

7) BULTOS Y PESO. ar_bultos = cuántos paquetes ("Bultos", "Cantidad de Bultos"). Es
un CONTEO, no un importe. ar_peso = "Peso" / "Kilos". Ojo: el sello del transporte
suele decir "Se reciben ___ bultos sin verificar" con el número ESCRITO A MANO —
si ese número es legible, sirve; si es un garabato, dejalo vacío.

8) REFERENCIAS CRUZADAS (muy útiles, cuando están):
   • ar_orden_compra = la orden de compra DEL CLIENTE que el proveedor imprime
     ("Orden de compra: IDCPRA-192", "PEDIDO Nº 212817", "Órdenes de compra de
     cliente: Lenga 20-7").
   • ar_comprobante_asociado = la factura que referencia ("Factura Nro.:
     FCA-0090-00439621", "Fac. Nº 0005-00069624").
   Copialos EXACTAMENTE como están impresos, con su prefijo si lo tienen.

9) C.O.T. Algunas provincias exigen un "Código de Operación de Traslado" (ARBA):
"Nº C.O.T: 3257814120". Va en ar_cot. Si no aparece, "".

10) RENGLONES — es el corazón del remito. El ORDEN DE LAS COLUMNAS CAMBIA EN CADA
PROVEEDOR: la cantidad aparece primera, última o en el medio. Leé cada columna por
su ENCABEZADO, nunca por su posición. Vistos en documentos reales:
   Cantidad │ Código │ Descripción
   Item │ Artículo │ Descripción │ U.M. │ Cantidad
   Código │ Cantidad │ Descripción
   Artículo │ ......... │ Cant.
   Cantidad │ Medida │ Artículo │ Envases │ Depósito │ Nº N.Venta │ Lote │ Vto Partida

11) CANTIDADES. Punto = miles, coma = decimal, y muchos sistemas imprimen TRES
decimales: "1.000,000 Lts." son MIL litros, no uno. "11,900 Kgs" son 11,9 kilos.
"4,00" son 4. Si te equivocás acá, el stock del cliente queda mal.

12) RENGLONES QUE NO SON MERCADERÍA. Algunos proveedores meten en la tabla filas con
cantidad que no son productos: "EMB. Y SEG." (embalaje y seguro), "Descuento General
%28", "Observaciones", "Flete". NO las devuelvas como renglón: no son mercadería y
si entran inflan el stock con productos que no existen.

13) FECHAS. En Argentina se imprimen DD/MM/AAAA: el PRIMER número es el DÍA.
"02/09/2026" es el 2 de septiembre → 2026-09-02, NUNCA el 9 de febrero. Vale también
para el vencimiento del CAI y el vencimiento de partida de cada renglón.
Devolvelas siempre como YYYY-MM-DD.

<ejemplos>
1) Encabezado: "REMITO 0028-01105914 · CÓDIGO Nº 91 · FECHA 03/09/2026 ·
   C.U.I.T. 30-50366413-1 · Entregar en: AVENIDA MARCONI 1155 · Orden de compra:
   IDCPRA-192 · Factura Nro.: FCA-0090-00439621 · CAI Nro. 52181218377491 - 27/10/2026"
   → invoice_number "0028-01105914", ar_punto_venta "0028", issue_date "2026-09-03",
     supplier_tax_id "30-50366413-1", ar_domicilio_entrega "AVENIDA MARCONI 1155",
     ar_orden_compra "IDCPRA-192", ar_comprobante_asociado "FCA-0090-00439621",
     ar_cae "52181218377491", ar_cae_vto "2026-10-27", document_class "delivery_note".

2) Tabla con encabezado "ITEM | ARTICULO | DESCRIPCION | U.M. | CANTIDAD" y la fila
   "TPL2576S370659 | PUERTA PLACA TEKS 2,20 GRAFITO | Unidad | 2,00"
   → un renglón: description "PUERTA PLACA TEKS 2,20 GRAFITO", quantity "2",
     unidad "Unidad", codigo "TPL2576S370659", lote "", vto_partida "",
     deposito "", envases "".

3) Tabla de agroquímicos "Cantidad | Medida | Artículo | Envases | Depósito | Lote |
   Vto Partida" con "1.000,000 | Lts. | GLIFOSATO PANZER GOLD EN X 20 LTS | 50,00 |
   TANDIL PROPIO BASE AEREA | 25K6128B38 | 29/11/2027"
   → quantity "1000" (MIL, no 1), unidad "Lts.", envases "50",
     deposito "TANDIL PROPIO BASE AEREA", lote "25K6128B38", vto_partida "2027-11-29".

4) La tabla trae, además de los productos, una fila "EMB. Y SEG. -(1-0*0)" con
   cantidad 1 → NO la devuelvas: no es mercadería.

5) Abajo dice "Valor Declarado $: 392.007,67 · Peso: 56.962 · Cantidad de Bultos: 8"
   → ar_valor_declarado "392007.67", ar_peso "56962", ar_bultos "8".
     total_amount NO existe en este esquema: el valor declarado no es un total.
</ejemplos>`

export default { code: 'AR', name: 'Argentina', kind: 'remito', prompt, enrich }
