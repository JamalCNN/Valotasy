-- ================================================================
--  VALOTASY — Full Database Schema
--  Run once in Supabase SQL Editor
-- ================================================================

-- ── 0a. VALOTASY_DATA (key-value store — kept for migration) ────
CREATE TABLE IF NOT EXISTS valotasy_data (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE valotasy_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON valotasy_data FOR ALL USING (true) WITH CHECK (true);


-- ── 0b. USERS (authentication) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_name TEXT NOT NULL UNIQUE,
  pin_hash     TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON users FOR ALL USING (true) WITH CHECK (true);

-- ── 1. TOURNAMENTS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
  id               TEXT PRIMARY KEY,          -- e.g. 'masters_london_2026'
  name             TEXT NOT NULL,
  status           TEXT DEFAULT 'active',     -- 'active' | 'finished'
  budget           INTEGER DEFAULT 100,
  transfer_penalty INTEGER DEFAULT 8,
  admin_password   TEXT DEFAULT '1234',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON tournaments FOR ALL USING (true) WITH CHECK (true);

-- Seed the current tournament
INSERT INTO tournaments (id, name, status, budget, transfer_penalty)
VALUES ('masters_london_2026', 'VCT Masters London 2026', 'active', 100, 8)
ON CONFLICT (id) DO NOTHING;


-- ── 2. MATCHDAYS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matchdays (
  id               BIGSERIAL PRIMARY KEY,
  tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  matchday_number  INTEGER NOT NULL,
  label            TEXT,                       -- 'MD1', 'MD7(KO)', 'Final', etc.
  phase            TEXT DEFAULT 'group',       -- 'group' | 'knockout'
  market_open      BOOLEAN DEFAULT TRUE,
  deadline         TIMESTAMPTZ,
  UNIQUE (tournament_id, matchday_number)
);

ALTER TABLE matchdays ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON matchdays FOR ALL USING (true) WITH CHECK (true);

-- Seed matchdays for Masters London
INSERT INTO matchdays (tournament_id, matchday_number, label, phase, market_open)
VALUES
  ('masters_london_2026', 1, 'MD 1', 'group',    TRUE),
  ('masters_london_2026', 2, 'MD 2', 'group',    FALSE),
  ('masters_london_2026', 3, 'MD 3', 'group',    FALSE),
  ('masters_london_2026', 4, 'MD 4', 'group',    FALSE),
  ('masters_london_2026', 5, 'MD 5', 'group',    FALSE),
  ('masters_london_2026', 6, 'MD 6', 'group',    FALSE),
  ('masters_london_2026', 7, 'MD 7 (KO)', 'knockout', FALSE),
  ('masters_london_2026', 8, 'MD 8 (KO)', 'knockout', FALSE),
  ('masters_london_2026', 9, 'Final',     'knockout', FALSE)
ON CONFLICT (tournament_id, matchday_number) DO NOTHING;


-- ── 3. PLAYERS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id            BIGSERIAL PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  vct_team      TEXT NOT NULL,
  role          TEXT NOT NULL  CHECK (role IN ('Duelist','Initiator','Controller','Sentinel')),
  tier          TEXT NOT NULL  CHECK (tier IN ('S','A','B','C')),
  price         REAL NOT NULL,
  UNIQUE (tournament_id, name)
);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON players FOR ALL USING (true) WITH CHECK (true);


-- ── 4. TEAMS ────────────────────────────────────────────────────
-- One team per user per tournament
CREATE TABLE IF NOT EXISTS teams (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tournament_id           TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_name               TEXT NOT NULL,
  captain_id              BIGINT REFERENCES players(id) ON DELETE SET NULL,
  captain2_id             BIGINT REFERENCES players(id) ON DELETE SET NULL,  -- clone captain
  chip_wildcard_used      BOOLEAN DEFAULT FALSE,
  chip_topfragger_used    BOOLEAN DEFAULT FALSE,
  chip_triplecap_used     BOOLEAN DEFAULT FALSE,
  chip_clonecap_used      BOOLEAN DEFAULT FALSE,
  total_points            REAL DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, tournament_id)
);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON teams FOR ALL USING (true) WITH CHECK (true);


-- ── 5. ROSTERS ──────────────────────────────────────────────────
-- 7 slots per team: duel, init, ctrl, sent, any1, any2, any3
CREATE TABLE IF NOT EXISTS rosters (
  team_id   UUID  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slot      TEXT  NOT NULL CHECK (slot IN ('duel','init','ctrl','sent','any1','any2','any3')),
  player_id BIGINT REFERENCES players(id) ON DELETE SET NULL,
  PRIMARY KEY (team_id, slot)
);

ALTER TABLE rosters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON rosters FOR ALL USING (true) WITH CHECK (true);


-- ── 6. ACTIVE CHIPS ─────────────────────────────────────────────
-- Which chip a team activated for a given matchday
CREATE TABLE IF NOT EXISTS active_chips (
  team_id      UUID   NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  matchday_id  BIGINT NOT NULL REFERENCES matchdays(id) ON DELETE CASCADE,
  chip_name    TEXT   NOT NULL CHECK (chip_name IN ('wildcard','topfragger','triplecap','clonecap')),
  PRIMARY KEY (team_id, matchday_id)
);

ALTER TABLE active_chips ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON active_chips FOR ALL USING (true) WITH CHECK (true);


-- ── 7. TRANSFERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfers (
  id              BIGSERIAL PRIMARY KEY,
  team_id         UUID   NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  matchday_id     BIGINT NOT NULL REFERENCES matchdays(id) ON DELETE CASCADE,
  slot            TEXT   NOT NULL,
  old_player_id   BIGINT REFERENCES players(id) ON DELETE SET NULL,
  new_player_id   BIGINT REFERENCES players(id) ON DELETE SET NULL,
  penalty_applied BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON transfers FOR ALL USING (true) WITH CHECK (true);


-- ── 8. MATCH PLAYER CACHE ───────────────────────────────────────
-- Raw stats scraped from VLR.gg — one row per player per match
-- rating_2_0 is the VLR Rating 2.0 value (used for rank/lowest calc)
CREATE TABLE IF NOT EXISTS match_player_cache (
  match_id         TEXT   NOT NULL,            -- VLR match ID
  tournament_id    TEXT   NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  matchday_id      BIGINT REFERENCES matchdays(id) ON DELETE SET NULL,
  player_name      TEXT   NOT NULL,            -- display name from VLR
  kills            INTEGER DEFAULT 0,
  deaths           INTEGER DEFAULT 0,
  acs              INTEGER DEFAULT 0,
  rating_2_0       REAL    DEFAULT 0,          -- Rating 2.0 from VLR overview tab
  k4               INTEGER DEFAULT 0,
  k5               INTEGER DEFAULT 0,
  k6               INTEGER DEFAULT 0,
  k7               INTEGER DEFAULT 0,
  clutch_1v2       INTEGER DEFAULT 0,
  clutch_1v3       INTEGER DEFAULT 0,
  clutch_1v4       INTEGER DEFAULT 0,
  clutch_1v5       INTEGER DEFAULT 0,
  is_winner        BOOLEAN DEFAULT FALSE,
  clean_sheet_win  BOOLEAN DEFAULT FALSE,
  rating_rank      INTEGER DEFAULT 99,         -- rank by rating_2_0 within the match
  is_lowest_rating BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (match_id, player_name)
);

ALTER TABLE match_player_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON match_player_cache FOR ALL USING (true) WITH CHECK (true);


-- ── 9. PROCESSED MATCHES ────────────────────────────────────────
-- Prevents the same match from being scored twice
CREATE TABLE IF NOT EXISTS processed_matches (
  match_id      TEXT   PRIMARY KEY,
  tournament_id TEXT   NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  matchday_id   BIGINT REFERENCES matchdays(id) ON DELETE SET NULL,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE processed_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON processed_matches FOR ALL USING (true) WITH CHECK (true);


-- ── 10. MATCHDAY SCORES ─────────────────────────────────────────
-- Final net points per team per matchday — primary leaderboard source
CREATE TABLE IF NOT EXISTS matchday_scores (
  id              BIGSERIAL PRIMARY KEY,
  team_id         UUID   NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  matchday_id     BIGINT NOT NULL REFERENCES matchdays(id) ON DELETE CASCADE,
  raw_points      REAL DEFAULT 0,
  penalty_points  REAL DEFAULT 0,       -- transfer penalty (negative value stored as positive)
  net_points      REAL DEFAULT 0,       -- raw_points - penalty_points
  UNIQUE (team_id, matchday_id)
);

ALTER TABLE matchday_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON matchday_scores FOR ALL USING (true) WITH CHECK (true);


-- ── 11. SCORE LOGS ──────────────────────────────────────────────
-- Detailed per-player scoring breakdown per match per team
CREATE TABLE IF NOT EXISTS score_logs (
  id               BIGSERIAL PRIMARY KEY,
  team_id          UUID   NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  matchday_id      BIGINT NOT NULL REFERENCES matchdays(id) ON DELETE CASCADE,
  match_id         TEXT   NOT NULL,
  player_id        BIGINT REFERENCES players(id) ON DELETE SET NULL,
  player_name      TEXT   NOT NULL,
  slot             TEXT   NOT NULL,
  kills            INTEGER DEFAULT 0,
  deaths           INTEGER DEFAULT 0,
  acs              INTEGER DEFAULT 0,
  rating_2_0       REAL    DEFAULT 0,
  k4               INTEGER DEFAULT 0,
  k5               INTEGER DEFAULT 0,
  k6               INTEGER DEFAULT 0,
  k7               INTEGER DEFAULT 0,
  total_clutch     INTEGER DEFAULT 0,
  is_winner        BOOLEAN DEFAULT FALSE,
  clean_sheet_win  BOOLEAN DEFAULT FALSE,
  rating_rank      INTEGER DEFAULT 99,
  is_lowest_rating BOOLEAN DEFAULT FALSE,
  is_captain       BOOLEAN DEFAULT FALSE,
  chip_used        TEXT,
  raw_pts          REAL DEFAULT 0,
  final_pts        REAL DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE score_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON score_logs FOR ALL USING (true) WITH CHECK (true);


-- ── 12. FIXTURES ────────────────────────────────────────────────
-- Scheduled matches within a matchday — drives scoring flow
CREATE TABLE IF NOT EXISTS fixtures (
  id              BIGSERIAL PRIMARY KEY,
  matchday_id     BIGINT NOT NULL REFERENCES matchdays(id) ON DELETE CASCADE,
  tournament_id   TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_a          TEXT NOT NULL,
  team_b          TEXT NOT NULL,
  scheduled_time  TIMESTAMPTZ,
  vlr_match_url   TEXT,
  status          TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'completed')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE fixtures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON fixtures FOR ALL USING (true) WITH CHECK (true);

-- Link processed_matches back to the fixture that triggered scoring
ALTER TABLE processed_matches ADD COLUMN IF NOT EXISTS fixture_id BIGINT REFERENCES fixtures(id) ON DELETE SET NULL;


-- ── SCORING REFERENCE (comment only) ────────────────────────────
-- Every 10 kills  → +1 pt
-- 4K              → +3 pts
-- 5K / Ace        → +4 pts
-- 6K              → +5 pts
-- 7K              → +6 pts
-- Clutch (each)   → +1 pt  (1v2, 1v3, 1v4, 1v5 all = +1)
-- Rating2.0 #1    → +3 pts
-- Rating2.0 #2    → +2 pts
-- Rating2.0 #3    → +1 pt
-- Rating2.0 Last  → -3 pts
-- Win             → +2 pts
-- Clean Sheet     → +1 pt  (added to win)
-- Captain         → ×2 multiplier on raw_pts
