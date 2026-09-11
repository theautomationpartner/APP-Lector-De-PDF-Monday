-- Esquema de la app "Lector PDF IA" (Monday marketplace, multi-tenant).
-- Idempotente: se puede correr muchas veces sin romper nada (IF NOT EXISTS).
-- La app lo ejecuta al arrancar (runStartupMigrations) en cada deploy.

-- ───────────────────────────────────────────────────────────────────────────
-- installations: una fila por cuenta de Monday que instala la app.
-- Guarda los defaults de la cuenta (idioma, país, moneda) usados como respaldo.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS installations (
  account_id       BIGINT PRIMARY KEY,           -- ID de cuenta de Monday
  ui_language      TEXT        NOT NULL DEFAULT 'en',   -- 'en' | 'es'
  default_country  TEXT,                          -- ISO-2 de respaldo (ej: 'AR')
  default_currency TEXT,                          -- ISO-3 de respaldo (ej: 'USD')
  plan             TEXT        NOT NULL DEFAULT 'free',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- board_configs: la configuración POR TABLERO. La llave (account_id, board_id)
-- es lo que permite que un mismo workspace tenga 2 tableros con configs distintas.
-- 'mapping' = { campo_factura: column_id } como JSON flexible.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS board_configs (
  account_id        BIGINT      NOT NULL,
  board_id          BIGINT      NOT NULL,
  mapping           JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- campo -> columna
  status_column_id  TEXT,                          -- columna de estado que dispara
  trigger_label     TEXT,                          -- etiqueta que dispara la lectura
  country_override  TEXT,                          -- país forzado para este tablero
  currency_override TEXT,                          -- moneda forzada para este tablero
  ui_language       TEXT,                          -- idioma para este tablero (override)
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, board_id)
);

-- Reglas de negocio por tablero (agregadas 2026-07-03). ALTER idempotente porque
-- CREATE TABLE IF NOT EXISTS no agrega columnas a un board_configs ya existente.
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS dedup_enabled  BOOLEAN NOT NULL DEFAULT false;      -- evitar duplicados
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS filter_mode    TEXT    NOT NULL DEFAULT 'all';       -- 'all' | 'supplier' | 'customer'
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS filter_tax_ids JSONB   NOT NULL DEFAULT '[]'::jsonb; -- lista blanca de CUITs
-- Países / monedas que el tablero maneja (multi-selección, agregado 2026-07-03).
-- Vacío = todos (la IA detecta cada factura). country_override/currency_override
-- quedan como el primer elegido (hint para el extractor).
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS countries  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS currencies JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Columna de archivo elegida (de dónde sale el PDF). Vacío = auto-detectar.
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS file_column_id TEXT;
-- Renglones como subítems (agregado 2026-07-14): un subítem por línea de la factura.
-- line_items_enabled se deriva del mapeo (description = 'name' -> activado).
-- line_items_mapping = { description: 'name'|'', quantity/unit_price/total:
--   '<columnId del tablero de subítems>' | '__auto__' (crear por título) | '' (no cargar) }.
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS line_items_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS line_items_mapping JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Renombrar el ítem con formato estándar "N° comprobante – Emisor" (2026-07-24).
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS rename_item_enabled BOOLEAN NOT NULL DEFAULT false;
-- Solo documentos fiscales: factura / nota de crédito / nota de débito. Ignora
-- remitos, tickets, presupuestos, etc. (2026-07-24).
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS only_fiscal_docs BOOLEAN NOT NULL DEFAULT false;
-- Actualizar la columna de estado del ítem (leyendo / leído / error). Prendido por
-- defecto, pero se puede apagar para que la app NO toque el estado (2026-08-07).
-- La columna destino sale de status_column_id (elegida en el mapeo): NUNCA se
-- adivina. Ver getStatusColumnId() en monday.mjs.
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS status_enabled BOOLEAN NOT NULL DEFAULT true;

-- Tipo de documento que lee el tablero (2026-09-10). Segunda dimensión junto al
-- país: un tablero es de UN país y UN tipo. 'fiscal' = facturas/NC/ND (lo de
-- siempre), 'remito' = remitos. Default 'fiscal' → todo lo existente sigue igual.
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS doc_kind TEXT NOT NULL DEFAULT 'fiscal';
-- IDs fiscales sin puntuación: "30-52333600-9" -> "30523336009" (2026-08-07). Para
-- cruzar con sistemas contables/ERP que los guardan sin guiones. Off por defecto:
-- se escribe como viene impreso en la factura.
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS tax_ids_plain BOOLEAN NOT NULL DEFAULT false;
-- El usuario confirma que YA creó la automatización en monday (2026-08-07). La app no
-- puede saberlo sola: monday no expone si la receta existe. Sin esto, el paso 2 se
-- marcaba "Listo" solo por haber mapeado campos y el usuario creía que estaba activo.
ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS automation_confirmed BOOLEAN NOT NULL DEFAULT false;

-- ───────────────────────────────────────────────────────────────────────────
-- extractions: histórico de cada lectura. Base para analytics / cobrar por uso.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS extractions (
  id               BIGSERIAL   PRIMARY KEY,
  account_id       BIGINT      NOT NULL,
  board_id         BIGINT      NOT NULL,
  item_id          BIGINT,
  detected_country TEXT,                          -- país detectado por la IA
  model            TEXT,                          -- modelo usado (ej: claude-haiku-4-5)
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  fields_written   INTEGER,                       -- cuántas columnas se cargaron
  status           TEXT        NOT NULL,          -- 'ok' | 'error'
  error            TEXT,                          -- mensaje si falló
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extractions_account ON extractions(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_extractions_board   ON extractions(board_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- invoice_keys: facturas ya cargadas (para el anti-duplicados). Llave por
-- (cuenta, tablero, dedup_key). Se registra SIEMPRE que una lectura carga OK,
-- esté el toggle de dedup ON u OFF (así hay histórico si se activa luego).
-- dedup_key = normalizado: taxid_emisor|numero_comprobante|tipo.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_keys (
  account_id  BIGINT      NOT NULL,
  board_id    BIGINT      NOT NULL,
  dedup_key   TEXT        NOT NULL,
  item_id     BIGINT,                 -- ítem que la cargó (para no marcarse a sí mismo)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, board_id, dedup_key)
);

-- ───────────────────────────────────────────────────────────────────────────
-- subitem_claims: derecho EXCLUSIVO a crear los subítems de un ítem (2026-08-07).
-- Antes se hacía "¿ya tiene subítems? → crear", y entre la pregunta y la creación
-- entraba un segundo disparo: los dos veían 0 y los dos creaban (renglones
-- duplicados). El insert-first es atómico: solo uno gana. Mismo patrón que
-- invoice_keys. Se libera si la creación falla, para poder reintentar.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subitem_claims (
  account_id  BIGINT      NOT NULL,
  item_id     BIGINT      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, item_id)
);

-- Mapeo a los tableros internos de ops (Board 1 instalaciones + Board 2 lecturas):
-- board_item_id = el item que representa esta fila en Monday, para actualizarlo.
ALTER TABLE installations ADD COLUMN IF NOT EXISTS board_item_id BIGINT;
-- Nombre y slug de la cuenta de monday (2026-08-31). Sin esto, para soporte solo
-- teníamos el ID numérico: no se podía saber de qué cliente era un tablero ni armar
-- el link (https://<slug>.monday.com/boards/<id>).
ALTER TABLE installations ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE installations ADD COLUMN IF NOT EXISTS account_slug TEXT;
ALTER TABLE extractions   ADD COLUMN IF NOT EXISTS board_item_id BIGINT;
-- Lo que monday manda en cada webhook de lifecycle (2026-09-11). Antes se tiraba
-- todo menos el account_id: una cuenta que instalaba y no leía nunca quedaba como
-- "Cuenta 32386966" sin forma de saber quién era ni a quién escribirle.
ALTER TABLE installations ADD COLUMN IF NOT EXISTS installer_email  TEXT;    -- quién instaló (contacto)
ALTER TABLE installations ADD COLUMN IF NOT EXISTS installer_name   TEXT;
ALTER TABLE installations ADD COLUMN IF NOT EXISTS monday_tier      TEXT;    -- plan de monday de la cuenta
ALTER TABLE installations ADD COLUMN IF NOT EXISTS monday_max_users INTEGER; -- tamaño de la cuenta