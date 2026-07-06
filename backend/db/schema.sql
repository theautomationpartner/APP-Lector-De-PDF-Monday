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