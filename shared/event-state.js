export function getVotingStatus(settings, now = Date.now()) {
  const end = Date.parse(settings.ends_at);
  if (settings.mode === 'open') return Number.isFinite(end) && now >= end ? 'closed' : 'open';
  if (settings.mode !== 'scheduled') return 'closed';
  const start = Date.parse(settings.starts_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'closed';
  if (now < start) return 'upcoming';
  return now < end ? 'open' : 'closed';
}

export function getSubmissionStatus(settings, now = Date.now()) {
  if (settings.submission_mode === 'closed') return 'closed';
  if (settings.submission_mode === 'scheduled') {
    const end = Date.parse(settings.submission_ends_at);
    return Number.isFinite(end) && now < end ? 'open' : 'closed';
  }
  return 'open';
}

export function getHomepageHero(settings, now = Date.now()) {
  const status = getVotingStatus(settings, now);
  if (status === 'open') return 'voting';
  const started = Date.parse(settings.voting_started_at) <= now
    || Date.parse(settings.ends_at) <= now
    || (settings.mode === 'scheduled' && now >= Date.parse(settings.starts_at));
  const beforeVoting = status === 'upcoming' || !started;
  return beforeVoting && settings.show_welcome !== 0 ? 'welcome' : 'voting';
}


export function getLikeStatus(settings, now = Date.now()) {
  const mode = settings.likes_mode ?? 'open';
  const end = Date.parse(settings.likes_ends_at);
  if (mode === 'open') return Number.isFinite(end) && now >= end ? 'closed' : 'open';
  if (mode !== 'scheduled') return 'closed';
  const start = Date.parse(settings.likes_starts_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'closed';
  if (now < start) return 'upcoming';
  return now < end ? 'open' : 'closed';
}
