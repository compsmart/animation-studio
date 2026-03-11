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
  async uploadBackgroundImage(projectId, file) {
    const fd = new FormData();
    fd.append('image', file);
    const r = await fetch(`/api/projects/${projectId}/background-image`, { method: 'POST', body: fd });
    if (!r.ok) { const t = await r.text(); throw new Error(t); }
    return r.json();
  },
  deleteBackgroundImage: (projectId) => del(`/api/projects/${projectId}/background-image`),

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
  async exportReferenceImage(projectId, charId) {
    const url = `/api/projects/${projectId}/characters/${charId}/compose-reference`;
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      let msg = text;
      try { const j = JSON.parse(text); if (j.error) msg = j.error; } catch (_) {}
      throw new Error(msg || `Export failed (${r.status})`);
    }
    const blob = await r.blob();
    const disposition = r.headers.get('Content-Disposition');
    const filename = (disposition?.match(/filename="?([^";]+)"?/)?.[1]) || 'reference.png';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  // Actions
  async generateAction(pid, cid, data) {
    const { referenceImage, ...rest } = data || {};
    if (referenceImage instanceof File) {
      const fd = new FormData();
      Object.entries(rest).forEach(([k, v]) => { if (v !== undefined && v !== null) fd.append(k, typeof v === 'boolean' ? String(v) : v); });
      fd.append('referenceImage', referenceImage);
      const r = await fetch(`/api/projects/${pid}/characters/${cid}/actions/generate`, { method: 'POST', body: fd });
      if (!r.ok) { const t = await r.text(); throw new Error(t || `Generate failed: ${r.status}`); }
      return r.json();
    }
    return post(`/api/projects/${pid}/characters/${cid}/actions/generate`, rest);
  },
  updateAction:    (pid, cid, aid, d) => put(`/api/projects/${pid}/characters/${cid}/actions/${aid}`, d),
  deleteAction:    (pid, cid, aid)    => del(`/api/projects/${pid}/characters/${cid}/actions/${aid}`),
  duplicateAction: (pid, cid, aid)    => post(`/api/projects/${pid}/characters/${cid}/actions/${aid}/duplicate`, {}),

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
