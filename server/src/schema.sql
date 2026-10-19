-- OTTv2 database schema. Applied at every server start; every statement is idempotent.

-- games/wins/losses/draws count games against other registered players (shown on profiles);
-- games against house bots or yourself are practice and aren't counted.
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  games         INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Usernames are unique regardless of case: "Ada" and "ada" are the same account.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

-- Earlier versions had an Elo rating; standings now exist only inside tournaments.
ALTER TABLE users DROP COLUMN IF EXISTS rating;

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
  rated            BOOLEAN NOT NULL,      -- counted in both players' records (two different registered players)
  started_at       TIMESTAMPTZ NOT NULL,
  finished_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_p1_idx ON matches (p1_user_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS matches_p2_idx ON matches (p2_user_id, finished_at DESC);
ALTER TABLE matches DROP COLUMN IF EXISTS p1_rating_before, DROP COLUMN IF EXISTS p1_rating_after,
                    DROP COLUMN IF EXISTS p2_rating_before, DROP COLUMN IF EXISTS p2_rating_after;

-- ---------- Tournaments ----------
-- Round robin: every entrant plays every other entrant once. Each pairing is a
-- tournament match of 4 games with alternating colours; its games are stored
-- in `matches` above (one row per game) and linked back here.

CREATE TABLE IF NOT EXISTS tournaments (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  organizer_id    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'registration',  -- registration, running, finished, cancelled
  games_per_match SMALLINT NOT NULL DEFAULT 4,
  champion_id     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

-- An entrant and the bot they play the whole tournament with.
CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id BIGINT NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);

-- One pairing. player_a is Red in games 1 and 3, player_b is Red in games 2 and 4.
CREATE TABLE IF NOT EXISTS tournament_matches (
  id            BIGSERIAL PRIMARY KEY,
  tournament_id BIGINT NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  round         SMALLINT NOT NULL,
  player_a      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  player_b      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  a_wins        SMALLINT NOT NULL DEFAULT 0,
  b_wins        SMALLINT NOT NULL DEFAULT 0,
  draws         SMALLINT NOT NULL DEFAULT 0,
  games_played  SMALLINT NOT NULL DEFAULT 0,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tournament_matches_t_idx ON tournament_matches (tournament_id, round);

ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_match_id BIGINT REFERENCES tournament_matches (id) ON DELETE SET NULL;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS game_number SMALLINT;
CREATE INDEX IF NOT EXISTS matches_tournament_idx ON matches (tournament_match_id);
