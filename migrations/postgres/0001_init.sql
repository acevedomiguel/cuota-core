-- Authentication, sessions, passkeys, and the settings key/value store.
-- Column types mirror the SQLite schema: timestamps stay TEXT so the same
-- lexicographic ordering holds, and booleans stay 0/1 so mapping code is
-- shared between adapters.

CREATE TABLE IF NOT EXISTS users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  credential_public_key text NOT NULL,
  credential_type text NOT NULL,
  device_type text NOT NULL,
  backed_up integer NOT NULL,
  aaguid text NOT NULL,
  name text NOT NULL,
  transports text NOT NULL,
  counter integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  last_used_at text
);
CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_credentials(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL
);