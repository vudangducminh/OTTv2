-- OTTv2 database schema. Applied at every server start; every statement is idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  rating        INTEGER NOT NULL DEFAULT 1000,
  games         INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Usernames are unique regardless of case: "Ada" and "ada" are the same account.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_rating_idx ON users (rating DESC) WHERE games > 0;

-- Login sessions. Only a SHA-256 of the cookie token is stored, so a copy of
-- this table can't be used to log in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- Finished matches involving at least one registered player. The id is the
-- match number shown in the lobby, which keeps counting across restarts.
CREATE TABLE IF NOT EXISTS matches (
  id               BIGINT PRIMARY KEY,
  name             TEXT NOT NULL,
  p1_user_id       BIGINT REFERENCES users (id) ON DELETE SET NULL,
  p2_user_id       BIGINT REFERENCES users (id) ON DELETE SET NULL,
  p1_name          TEXT NOT NULL,
  p2_name          TEXT NOT NULL,
  winner           SMALLINT,              -- 1 or 2, 0 for a draw
  reason           TEXT NOT NULL,         -- target, eliminated, no-moves, turn-limit, forfeit, error
  plies            INTEGER NOT NULL,
  rated            BOOLEAN NOT NULL,
  p1_rating_before INTEGER,
  p1_rating_after  INTEGER,
  p2_rating_before INTEGER,
  p2_rating_after  INTEGER,
  started_at       TIMESTAMPTZ NOT NULL,
  finished_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_p1_idx ON matches (p1_user_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS matches_p2_idx ON matches (p2_user_id, finished_at DESC);
