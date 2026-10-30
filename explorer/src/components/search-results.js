// Text equality is a presentation relationship, never a claim of source identity.
// Keep every occurrence and its original rank, including equal text in other sessions.
export function groupSearchResults(results, ranks = new Map()) {
  const groups = [], seen = new Map();
  results.forEach((event, index) => {
    const text = event.prompt || event.query || event.title || event.description || event.display || event.summary || event.url || '';
    const member = { event, rank: ranks.get(event) ?? index + 1, key: `${event.event_id || event.uuid || 'result'}:${index}` };
    const group = typeof text === 'string' && text ? seen.get(text) : null;
    if (group) group.members.push(member);
    else {
      const next = { key: member.key, members: [member] };
      groups.push(next);
      if (typeof text === 'string' && text) seen.set(text, next);
    }
  });
  return groups;
}

export function visibleSearchMembers(groups, expanded) {
  return groups.flatMap(group => expanded.has(group.key) ? group.members : group.members.slice(0, 1));
}
