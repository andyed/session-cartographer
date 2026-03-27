export async function fetchEvents({ limit = 50, offset = 0, project = '' } = {}) {
  const params = new URLSearchParams({ limit, offset });
  if (project) params.set('project', project);
  const res = await fetch(`/api/events?${params}`);
  return res.json();
}

export async function searchEvents(query, { project = '', limit = 15, offset = 0 } = {}) {
  const params = new URLSearchParams({ q: query, limit, offset });
  if (project) params.set('project', project);
  const res = await fetch(`/api/search?${params}`);
  return res.json();
}

export async function fetchProjects() {
  const res = await fetch('/api/projects');
  const data = await res.json();
  return data.projects;
}
