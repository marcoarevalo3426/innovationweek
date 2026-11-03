-- Additive settings only: existing ideas, accounts, votes and schedules are retained.
ALTER TABLE settings
  ADD COLUMN footer_text TEXT NOT NULL DEFAULT 'For more information,' CHECK (char_length(footer_text) BETWEEN 1 AND 200),
  ADD COLUMN footer_link_text TEXT NOT NULL DEFAULT 'Click here' CHECK (char_length(footer_link_text) BETWEEN 1 AND 80),
  ADD COLUMN footer_url TEXT NOT NULL DEFAULT 'https://nepgroup.atlassian.net/wiki/x/AQBTyw' CHECK (char_length(footer_url) BETWEEN 1 AND 2048);
