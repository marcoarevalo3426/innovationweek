ALTER TABLE settings
  ADD COLUMN show_vote_counts INTEGER NOT NULL DEFAULT 1 CHECK (show_vote_counts IN (0,1)),
  ADD COLUMN show_like_counts INTEGER NOT NULL DEFAULT 1 CHECK (show_like_counts IN (0,1));
