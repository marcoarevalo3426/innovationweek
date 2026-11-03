-- Run as the schema owner with autocommit, outside an explicit transaction.
-- Avoid full-table scans for each card's shared like/vote counts as the gallery grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_likes_idea ON public.likes(idea_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_votes_round_idea ON public.votes(round,idea_id);
