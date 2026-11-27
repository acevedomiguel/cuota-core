-- How expenses are split: the salary ratio (the default) or a fixed percentage.
-- An insert-only timeline like incomes: each row is effective from its
-- created_at, so changing the rule never rewrites an expense already recorded.

CREATE TABLE IF NOT EXISTS sharing_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('salary', 'fixed')),
  -- The partner a fixed rule applies to; the other gets the remainder.
  subject_user_id integer REFERENCES users(id),
  -- Basis points, so 62.5% stays exact (6250).
  percentage_bps integer,
  -- Same ISO format as incomes.created_at so string comparison works.
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  CHECK (
    (mode = 'salary' AND subject_user_id IS NULL AND percentage_bps IS NULL) OR
    (mode = 'fixed' AND subject_user_id IS NOT NULL AND percentage_bps IS NOT NULL
      AND percentage_bps >= 0 AND percentage_bps <= 10000)
  )
);
CREATE INDEX IF NOT EXISTS idx_sharing_rules_date ON sharing_rules(created_at DESC, id DESC);
