-- Receipt photos kept with an expense. The image bytes live in the host's
-- ReceiptStore (a bucket binding, a directory, or memory); this row only points
-- at them, so the ledger stays small and the same schema serves every host.

CREATE TABLE IF NOT EXISTS receipts (
  -- One receipt per expense; a second upload replaces the first.
  expense_id INTEGER PRIMARY KEY REFERENCES expenses(id),
  -- Opaque key in the ReceiptStore.
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  -- Same ISO format as every other timestamp so string comparison works.
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
