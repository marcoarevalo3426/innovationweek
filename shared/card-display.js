export function cardAuthor(idea) {
  return idea.full_name?.trim() || idea.author?.split('@')[0] || 'Innovator';
}

export function galleryDisplay(settings, requestedSort = 'newest') {
  const showVotes = (settings.show_vote_counts ?? 1) === 1;
  const showLikes = (settings.show_like_counts ?? 1) === 1;
  const allowed = ['newest', ...(showLikes ? ['likes'] : []), ...(showVotes ? ['votes'] : [])];
  return {showVotes, showLikes, showSort: showVotes || showLikes, sort: allowed.includes(requestedSort) ? requestedSort : 'newest'};
}
