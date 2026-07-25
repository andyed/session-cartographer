export const isDemoMode = import.meta.env.VITE_DEMO === 'true';

// ─── Demo data loader (lazy, single import) ───

let demoMod = null;
async function demo() {
  if (!demoMod) demoMod = await import('./demo.js');
  return demoMod;
}

// ─── Core fetch — demo mode intercepts here ───

async function apiFetch(url) {
  if (isDemoMode) return (await demo()).handleFetch(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ─── API functions (unchanged between live and demo) ───

export async function fetchEvents({ limit = 50, offset = 0, project = '' } = {}) {
  const params = new URLSearchParams({ limit, offset });
  if (project) params.set('project', project);
  return apiFetch(`/api/events?${params}`);
}

export async function searchEvents(query, { project = '', limit = 15, offset = 0 } = {}) {
  const params = new URLSearchParams({ q: query, limit, offset });
  if (project) params.set('project', project);
  return apiFetch(`/api/search?${params}`);
}

export async function autocomplete(prefix) {
  return apiFetch(`/api/autocomplete?prefix=${encodeURIComponent(prefix)}`);
}

export async function coterms(term) {
  return apiFetch(`/api/coterms?term=${encodeURIComponent(term)}`);
}

export async function fetchProjects() {
  const data = await apiFetch('/api/projects');
  return data.projects;
}

export async function fetchSessions({ days = 7 } = {}) {
  return apiFetch(`/api/sessions?days=${days}`);
}

// Demo-only: get available queries for the picker UI
export async function getDemoQueries() {
  if (!isDemoMode) return null;
  return (await demo()).getQueries();
}
