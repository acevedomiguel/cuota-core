-- Receipt photos kept with an expense. The image bytes live in the host's
-- ReceiptStore (a bucket binding, a directory, or memory); this row only points
-- at them, so the ledger stays small and the same schema serves every host.

CREATE TABLE IF NOT EXISTS receipts (
  -- One receipt per expense; a second upload replaces the first.
  expense_id integer PRIMARY KEY REFERENCES expenses(id),
  -- Opaque key in the ReceiptStore.
  object_key text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  -- Same ISO format as every other timestamp so string comparison works.
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
