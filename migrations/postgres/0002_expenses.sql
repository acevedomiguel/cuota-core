-- The ledger: expenses, the insert-only salary timeline, balance events, and
-- balance snapshots.

CREATE TABLE IF NOT EXISTS incomes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  -- Insert-only timeline: the entry's moment IS its effective date.
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_incomes_user_date ON incomes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS expenses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date text NOT NULL,
  description text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  payer_id integer NOT NULL REFERENCES users(id),
  -- Same ISO format as incomes.created_at so string comparison works.
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date DESC, id DESC);

CREATE TABLE IF NOT EXISTS balance_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'settlement')),
  from_user_id integer NOT NULL REFERENCES users(id),
  to_user_id integer NOT NULL REFERENCES users(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  note text,
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
-- Exactly one opening balance, ever (guards against double-import).
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_events_opening ON balance_events(kind) WHERE kind = 'opening';

CREATE TABLE IF NOT EXISTS snapshots (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Balance sealed for everything with created_at < cutoff.
  cutoff text NOT NULL UNIQUE,
  balance_cents integer NOT NULL,
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);