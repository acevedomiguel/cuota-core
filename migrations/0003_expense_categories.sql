-- Expense categories, for the analytics breakdown by category. Added after the
-- fact so every expense recorded before categories existed lands in a single
-- default bucket rather than becoming invalid. The add form always writes one
-- of the known category ids (see src/categories.ts); the DEFAULT here protects
-- direct inserts and the pre-existing history.
--
-- No index on `category`: the analytics page folds the whole (small, two-person)
-- ledger in TypeScript rather than grouping in SQL, so nothing filters on this
-- column yet.
ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'uncategorized';
