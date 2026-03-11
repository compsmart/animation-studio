/** HTTP client — thin wrappers around fetch. */

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return r.json();
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(t); }
  return r.json();
}

async function put(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(t); }
  return r.json();
}

async function del(url) {
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE ${url}: ${r.status}`);
  return r.json();
}

export const API = {
  // Projects
  listProjects:  ()        => get('/api/projects'),
  createProject: (data)    => post('/api/projects', data),
  getProject:    (id)      => get(`/api/projects/${id}`),
  updateProject: (id, d)   => put(`/api/projects/${id}`, d),
  deleteProject: (id)      => del(`/api/projects/${id}`),

  // Characters
  async uploadCharacter(projectId, file, name) {
    const fd = new FormData();
    fd.append('image', file);
    fd.append('name', name || file.name);
    const r = await fetch(`/api/projects/${projectId}/characters`, { method: 'POST', body: fd });
    if (!r.ok) { const t = await r.text(); throw new Error(t); }
    return r.json();
  },
  updateCharacter: (pid, cid, d) => put(`/api/projects/${pid}/characters/${cid}`, d),
  deleteCharacter: (pid, cid)    => del(`/api/projects/${pid}/characters/${cid}`),
  analyzeSpine:    (pid, cid)    => post(`/api/projects/${pid}/characters/${cid}/analyze-spine`, {}),

  // Actions
  generateAction: (pid, cid, d) => post(`/api/projects/${pid}/characters/${cid}/actions/generate`, d),
  updateAction:   (pid, cid, aid, d) => put(`/api/projects/${pid}/characters/${cid}/actions/${aid}`, d),
  deleteAction:   (pid, cid, aid)    => del(`/api/projects/${pid}/characters/${cid}/actions/${aid}`),

  // Jobs
  getJob: (jobId) => get(`/api/jobs/${jobId}`),

  // Export
  exportProject(id) {
    const a = document.createElement('a');
    a.href = `/api/projects/${id}/export`;
    a.download = '';
    a.click();
  },
};
