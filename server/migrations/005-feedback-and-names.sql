-- Existing ideas remain readable; their authors can supply a name when editing.
ALTER TABLE ideas ADD COLUMN full_name TEXT
  CHECK (full_name IS NULL OR (length(btrim(full_name)) BETWEEN 1 AND 120));

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('general','website')),
  feedback TEXT NOT NULL CHECK (length(btrim(feedback)) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_created ON feedback(created_at DESC,id);
CREATE INDEX idx_feedback_category_created ON feedback(category,created_at DESC,id);
