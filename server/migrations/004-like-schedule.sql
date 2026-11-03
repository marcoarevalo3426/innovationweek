-- Preserve existing likes and keep the existing always-open behavior by default.
ALTER TABLE settings
  ADD COLUMN likes_mode TEXT NOT NULL DEFAULT 'open' CHECK (likes_mode IN ('open','closed','scheduled')),
  ADD COLUMN likes_starts_at TEXT,
  ADD COLUMN likes_ends_at TEXT;
