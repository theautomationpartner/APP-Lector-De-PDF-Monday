# Fiscalidad Argentina (AFIP / ARCA) — referencia del pack `ar.mjs`

> Doc de referencia del país. Vive al lado del código del país (`ar.mjs`) para que
> todo lo de Argentina esté en un solo lugar. Al escalar otro país se replica este
> patrón (`xx.mjs` + `xx.fiscalidad.md`). Fuentes al final.

## Autoridad
- **ARCA** (Agencia de Recaudación y Control Aduanero), ex **AFIP** desde fines de 2024.
- Comprobantes electrónicos autorizados con **CAE** (Código de Autorización Electrónico).

## Tipos de comprobante y letra
La **letra** depende de la condición IVA del emisor y del receptor:
| Letra | Cuándo | IVA |
|---|---|---|
| **A** | Resp. Inscripto → Resp. Inscripto | **discriminado** (neto + IVA por separado) |
| **B** | Resp. Inscripto → Consumidor Final / Exento / Monotributo | IVA **incluido** (no discriminado) |
| **C** | Monotributo o Exento → cualquiera | **sin IVA** (no corresponde) |
| **M** | emisor observado por ARCA (reemplaza la A provisoriamente) | discriminado |
| **E** | **exportación** (cliente del exterior) | exento (no gravado por IVA local) |

Cada tipo tiene su **código AFIP** (tipoCmp del QR). Facturas 1/6/11, Notas de Débito
2/7/12, Notas de Crédito 3/8/13 (A/B/C). **Exportación**: Factura E 19, ND E 20, NC E 21.
**M**: 51/52/53. **FCE MiPyME** (Factura de Crédito Electrónica): A 201/202/203, B 206/207/208, C 211/212/213.

## Datos fiscales del ENCABEZADO
- **CUIT del emisor** (11 díg, con dígito verificador módulo 11).
- **Punto de venta** (4-5 díg) + **Número de comprobante** (8 díg) → formato `0090-00434782`.
- **CAE** (14 díg) + **Vto. de CAE**.
- **Condición IVA del emisor** y **del receptor** (receptor **obligatorio desde 1/7/2025**, RG 5616).
- Documento del receptor: CUIT / CUIL / DNI / Consumidor Final.

## Anatomía de los TOTALES (Factura A, la más detallada)
```
Importe Neto Gravado ............ (base gravada)          → subtotal
Importe Neto No Gravado ......... (base no alcanzada)     → ar_neto_no_gravado
Importe Exento .................. (operaciones exentas)   → ar_exento
IVA 21% / 10,5% / 27% / 5% / 2,5% (discriminado)         → ar_iva_21 / _105 / _27 (+ tax_amount = IVA total)
── Sección "Otros Tributos" (tabla con códigos) ──
  Percepción de IVA ............. (RG 3337)               → ar_percepcion_iva
  Percepción de IIBB ............ (provincial: ARBA/AGIP) → ar_percepcion_iibb
  Percepción de Ganancias ....... (RG 830)               → ar_percepcion_ganancias
  Impuestos Internos ............                         → ar_impuestos_internos
  Impuestos/tasas municipales, otras percep. ...         → ar_otros_tributos (residual)
─────────────────────────────────
Importe Total ...................                        → total_amount
```
**Igualdad de control:** `Neto Gravado + Neto No Gravado + Exento + IVA + Σ percepciones + Otros = Total`.

## Alícuotas de IVA (códigos Libro IVA Digital)
`0%` (0003), `10,5%` (0004), `21%` (0005), `27%` (0006), `5%` (0008), `2,5%` (0009).
Cubrimos 21/10,5/27 con columna propia; 5 y 2,5 son raras → quedan dentro de `tax_amount` (IVA total).

## Qué es EXACTO (QR) vs qué lee la IA
- **Del QR de AFIP (100%, determinístico):** CUIT emisor, punto de venta, tipo, número, fecha, importe TOTAL, moneda, CAE, doc. receptor.
- **Lee la IA (validado por la igualdad de control):** razón social, domicilios, condición IVA, subtotal, IVA discriminado, percepciones, renglones.

## Formato de importes
Punto = separador de **miles**, coma = **decimal**: `744.098,80` → `744098.80`.

## Tabla completa de tipos de comprobante (códigos AFIP/ARCA)
| Cód | Comprobante | | Cód | Comprobante |
|---|---|---|---|---|
| 001 | Factura A | | 011 | Factura C |
| 002 | Nota de Débito A | | 012 | Nota de Débito C |
| 003 | Nota de Crédito A | | 013 | Nota de Crédito C |
| 004 | Recibo A | | 015 | Recibo C |
| 005 | Nota de Venta al Contado A | | 016 | Nota de Venta al Contado C |
| 006 | Factura B | | 017/018 | Liquidación Serv. Públicos A/B |
| 007 | Nota de Débito B | | 019 | **Factura E** (exportación) |
| 008 | Nota de Crédito B | | 020 | Nota de Débito exterior |
| 009 | Recibo B | | 021 | Nota de Crédito exterior |
| 010 | Nota de Venta al Contado B | | 022 | Factura permiso exportación simpl. |
| 030 | Comprobante de compra de bienes usados | | 051/052/053 | Factura/ND/NC **M** |
| 081/082 | Tique Factura A/B (controlador fiscal) | | 083 | Tique |
| 201/202/203 | **FCE MiPyME** A (Fact/ND/NC) | | 206/207/208 | FCE MiPyME B |
| 211/212/213 | FCE MiPyME C | | 118+ | Turismo (Factura T, RG 3971) |

Regímenes especiales con su propio formato: **Liquidación Primaria de Granos**,
**Liquidación Sector Pecuario**, servicios agropecuarios (fuera del alcance típico de
una factura de compra estándar; se leen como "invoice"/"other" según el caso).

## Modelo de campos oficial (FECAEDetRequest) → mapeo a la app
Lo que ARCA define para cada comprobante, y a qué campo nuestro va:
| Campo oficial | Qué es | Campo app |
|---|---|---|
| CbteTipo | tipo de comprobante | document_type / ar_tipo_comprobante |
| PtoVta / CbteNro | punto de venta / número | ar_punto_venta / invoice_number |
| Concepto | Productos / Servicios / Ambos | ❌ descartado (NO se imprime en el PDF) |
| DocTipo / DocNro | doc. del receptor (CUIT/DNI…) | customer_tax_id |
| CbteFch | fecha del comprobante | issue_date |
| FchServDesde / Hasta | período del servicio | ✅ ar_periodo_desde / ar_periodo_hasta |
| FchVtoPago | vencimiento de pago | due_date |
| ImpNeto | neto gravado | subtotal |
| ImpTotConc | importe no gravado | ar_neto_no_gravado |
| ImpOpEx | importe exento | ar_exento |
| IVA[] (Id, BaseImp, Importe) | alícuotas de IVA | ar_iva_21/105/27 + tax_amount |
| Tributos[] (Id, Desc, Importe) | otros tributos/percepciones | ar_percepcion_* / ar_impuestos_internos / ar_otros_tributos |
| ImpTotal | total | total_amount |
| MonId | moneda | currency |
| MonCotiz | cotización (si ≠ ARS) | ✅ ar_cotizacion |
| CAE / FchVtoCae | autorización | ar_cae / ar_cae_vto |
| Cond. IVA receptor | RG 5616 (oblig. 2025) | ar_condicion_iva_receptor |

**Cobertura:** 19 campos AR, todo lo que ARCA imprime en el comprobante. Regla del pack:
extraer SOLO lo impreso en la factura (nada inferido). "Concepto" queda afuera porque es
metadato del modelo, no se imprime en el PDF.

## Fuentes
- RG 100 / Tabla de Tipos de Comprobante — afip.gob.ar/fe/documentos.
- RG 5616/2024 — Condición IVA del receptor (obligatorio 1/7/2025).
- Libro IVA Digital — Tablas del Sistema (alícuotas, tipos), afip.gob.ar.
- Manual del Desarrollador ARCA COMPG v4.0 (WSFEv1) — modelo FECAEDetRequest.
- RG 4367 (FCE MiPyME), RG 3971 (Factura T turismo).
