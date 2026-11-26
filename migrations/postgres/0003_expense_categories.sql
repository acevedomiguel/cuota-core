-- Expense categories, added after the fact so history lands in one default
-- bucket. Mirrors the SQLite migration.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'uncategorized';