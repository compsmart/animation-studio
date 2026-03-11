/**
 * UI — all DOM rendering, panel setup, and event handler wiring.
 */
import { state, setState, on } from './state.js';
import { API } from './api.js';
import { sampleColor } from './chroma-key.js';

let _ctx = null; // set by init()

export function init(ctx) {
  _ctx = ctx;
  _setupPanels();
  _setupHeader();
  _setupProjectModal();
  on('project',          () => renderAll());
  on('selectedCharId',   () => { renderCharList(); renderActionLibrary(); renderCharSettings(); renderActionSettings(); });
  on('selectedActionId', () => { renderActionSettings(); highlightAction(); });
  on('playerState',      () => _updatePlayBtn());
  on('jobs',             () => renderJobQueue());
}

// ── Global render ────────────────────────────────────────────────────────────

function renderAll() {
  renderCharList();
  renderActionLibrary();
  renderCharSettings();
  renderActionSettings();
  renderJobQueue();
  _syncProjectHeader();
}

// ── Panels – collapsible accordion ──────────────────────────────────────────

function _setupPanels() {
  document.querySelectorAll('.panel-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const body = hdr.nextElementSibling;
      const open = !hdr.classList.contains('open');
      hdr.classList.toggle('open', open);
      body.classList.toggle('hidden', !open);
    });
    // Open by default
    hdr.classList.add('open');
  });
}

// ── Header ───────────────────────────────────────────────────────────────────

function _setupHeader() {
  // Stage size toggle
  document.querySelectorAll('.seg-ctrl button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.seg-ctrl button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const [w, h] = btn.dataset.size === '720p' ? [1280, 720] : [1920, 1080];
      setState({ stageW: w, stageH: h });
      if (state.project) {
        const updated = await API.updateProject(state.project.id, { stageWidth: w, stageHeight: h });
        setState({ project: updated });
      }
      _ctx.stage.fit();
    });
  });

  // Project name edit
  const nameEl = document.getElementById('projectName');
  nameEl.addEventListener('change', async () => {
    if (!state.project) return;
    const updated = await API.updateProject(state.project.id, { name: nameEl.value });
    setState({ project: updated });
  });

  // Export
  document.getElementById('btnExport').addEventListener('click', () => {
    if (!state.project) return alert('No project open');
    API.exportProject(state.project.id);
  });

  // Save (auto-saves via API on every change, this is a visual affordance)
  document.getElementById('btnSave').addEventListener('click', async () => {
    if (!state.project) return;
    await API.updateProject(state.project.id, state.project);
    _flash(document.getElementById('btnSave'), 'Saved!');
  });
}

function _syncProjectHeader() {
  if (!state.project) return;
  document.getElementById('projectName').value = state.project.name || '';
}

// ── Project modal ────────────────────────────────────────────────────────────

function _setupProjectModal() {
  const openBtn  = document.getElementById('btnNewProject');
  const backdrop = document.getElementById('modalNewProject');
  const form     = document.getElementById('formNewProject');

  openBtn.addEventListener('click', () => {
    backdrop.style.display = 'flex';
    _renderProjectList();
  });
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.style.display = 'none'; });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name  = form.querySelector('[name=projectName]').value || 'Untitled';
    const size  = form.querySelector('[name=stageSize]').value   || '1080p';
    const proj  = await API.createProject({ name, stageSize: size });
    backdrop.style.display = 'none';
    await _ctx.loadProject(proj.id);
  });
}

async function _renderProjectList() {
  const list = document.getElementById('projectList');
  list.innerHTML = '<div class="empty-state">Loading…</div>';
  const projects = await API.listProjects();
  if (!projects.length) { list.innerHTML = '<div class="empty-state">No projects yet</div>'; return; }
  list.innerHTML = projects.map(p => `
    <div class="char-card" data-project-id="${p.id}">
      <div style="flex:1;min-width:0">
        <div class="char-name">${esc(p.name)}</div>
        <div class="char-actions-count">${p.stageWidth}×${p.stageHeight}</div>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-project-id]').forEach(el => {
    el.addEventListener('click', async () => {
      document.getElementById('modalNewProject').style.display = 'none';
      await _ctx.loadProject(el.dataset.projectId);
    });
  });
}

// ── Character list ───────────────────────────────────────────────────────────

export function renderCharList() {
  const ul = document.getElementById('charList');
  if (!ul) return;
  const chars = state.project?.characters || [];
  if (!chars.length) { ul.innerHTML = '<div class="empty-state">No characters yet</div>'; return; }
  ul.innerHTML = chars.map(c => `
    <div class="char-card ${c.id === state.selectedCharId ? 'selected' : ''}" data-char-id="${c.id}">
      <img class="char-thumb" src="${c.referenceImageUrl || ''}" alt="">
      <div style="flex:1;min-width:0">
        <div class="char-name">${esc(c.name)}</div>
        <div class="char-actions-count">${c.actions?.filter(a=>a.status==='ready').length||0} actions</div>
      </div>
      <button class="btn btn-ghost btn-sm btn-danger del-char" data-char-id="${c.id}" title="Delete">✕</button>
    </div>`).join('');

  ul.querySelectorAll('[data-char-id]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('del-char')) return;
      setState({ selectedCharId: el.dataset.charId, selectedActionId: null });
      _ctx.activateCharacter(el.dataset.charId);
    });
  });
  ul.querySelectorAll('.del-char').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete character?')) return;
      await API.deleteCharacter(state.project.id, btn.dataset.charId);
      const proj = await API.getProject(state.project.id);
      if (state.selectedCharId === btn.dataset.charId) setState({ selectedCharId: null });
      setState({ project: proj });
    });
  });
}

// ── Character settings (placement) ──────────────────────────────────────────

export function renderCharSettings() {
  const panel = document.getElementById('panelCharSettings');
  if (!panel) return;
  const char = state.project?.characters?.find(c => c.id === state.selectedCharId);
  if (!char) { panel.innerHTML = '<div class="empty-state">Select a character</div>'; return; }

  const p = char.placement || {};
  panel.innerHTML = `
    <div class="slider-row">
      <span class="label">X</span>
      <input type="range" min="0" max="1" step="0.01" value="${p.x??0.5}" id="placX">
      <span class="slider-val" id="placXv">${pct(p.x??0.5)}</span>
    </div>
    <div class="slider-row">
      <span class="label">Y (bottom)</span>
      <input type="range" min="0" max="1" step="0.01" value="${p.y??0.85}" id="placY">
      <span class="slider-val" id="placYv">${pct(p.y??0.85)}</span>
    </div>
    <div class="slider-row">
      <span class="label">Scale</span>
      <input type="range" min="0.1" max="2" step="0.05" value="${p.scale??0.6}" id="placS">
      <span class="slider-val" id="placSv">${(p.scale??0.6).toFixed(2)}</span>
    </div>
    <div style="margin-top:4px;display:flex;gap:6px">
      <button class="btn btn-ghost btn-sm" id="btnAnalyzeSpine">&#10024; Analyze Idle</button>
    </div>`;

  const debounce = makeDebounce(async () => {
    const x = parseFloat(document.getElementById('placX').value);
    const y = parseFloat(document.getElementById('placY').value);
    const s = parseFloat(document.getElementById('placS').value);
    const updated = await API.updateCharacter(state.project.id, char.id, { placement: { x, y, scale: s } });
    const proj    = { ...state.project, characters: state.project.characters.map(c => c.id === char.id ? updated : c) };
    setState({ project: proj });
    _ctx.spineEngine.setPlacement({ x, y, scale: s });
    _ctx.stage.renderUI(updated);
  }, 300);

  ['placX','placY','placS'].forEach(id => {
    document.getElementById(id).addEventListener('input', (e) => {
      const labels = { placX: 'placXv', placY: 'placYv', placS: 'placSv' };
      const lbl = document.getElementById(labels[id]);
      if (id === 'placS') lbl.textContent = parseFloat(e.target.value).toFixed(2);
      else lbl.textContent = pct(parseFloat(e.target.value));
      debounce();
    });
  });

  document.getElementById('btnAnalyzeSpine').addEventListener('click', async () => {
    const btn = document.getElementById('btnAnalyzeSpine');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyzing…';
    try {
      const result = await API.analyzeSpine(state.project.id, char.id);
      const proj   = await API.getProject(state.project.id);
      setState({ project: proj });
      _ctx.loadSpineForChar(char.id);
      btn.innerHTML = '&#10024; Done!';
    } catch (err) { btn.innerHTML = '⚠ ' + err.message.slice(0, 40); }
    finally { setTimeout(() => { if (btn) btn.innerHTML = '&#10024; Analyze Idle'; btn.disabled = false; }, 3000); }
  });
}

// ── Action library ───────────────────────────────────────────────────────────

export function renderActionLibrary() {
  const ul = document.getElementById('actionList');
  if (!ul) return;
  const char = state.project?.characters?.find(c => c.id === state.selectedCharId);
  if (!char) { ul.innerHTML = '<div class="empty-state">Select a character</div>'; return; }

  const actions = char.actions || [];
  if (!actions.length) { ul.innerHTML = '<div class="empty-state">No actions yet — generate one below</div>'; return; }

  ul.innerHTML = actions.map(a => `
    <div class="action-card ${a.id === state.selectedActionId ? 'selected' : ''}" data-action-id="${a.id}">
      ${a.previewUrl
        ? `<img class="action-thumb" src="${a.previewUrl}" alt="">`
        : `<div class="action-thumb" style="background:var(--border)"></div>`}
      <div class="action-info">
        <div class="action-name">${esc(a.name)}</div>
        <div class="action-meta">${a.duration ? a.duration.toFixed(1)+'s' : ''} <span class="badge badge-${a.status==='ready'?'ready':a.status==='error'?'error':'generating'}">${a.status}</span></div>
      </div>
      <div class="action-btns">
        ${a.status==='ready' ? `<button class="btn btn-sm btn-ghost play-action" data-action-id="${a.id}" title="Preview">▶</button>` : ''}
        <button class="btn btn-sm btn-ghost btn-danger del-action" data-action-id="${a.id}" title="Delete">✕</button>
      </div>
    </div>`).join('');

  ul.querySelectorAll('.action-card').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      setState({ selectedActionId: el.dataset.actionId });
    });
  });
  ul.querySelectorAll('.play-action').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      setState({ selectedActionId: btn.dataset.actionId });
      await _ctx.playAction(btn.dataset.actionId);
    });
  });
  ul.querySelectorAll('.del-action').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete action?')) return;
      const char2 = state.project.characters.find(c => c.id === state.selectedCharId);
      await API.deleteAction(state.project.id, char2.id, btn.dataset.actionId);
      const proj = await API.getProject(state.project.id);
      setState({ project: proj });
    });
  });
}

export function highlightAction() {
  document.querySelectorAll('.action-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.actionId === state.selectedActionId);
  });
}

// ── Action settings ───────────────────────────────────────────────────────────

export function renderActionSettings() {
  const panel = document.getElementById('panelActionSettings');
  if (!panel) return;

  const char   = state.project?.characters?.find(c => c.id === state.selectedCharId);
  const action = char?.actions?.find(a => a.id === state.selectedActionId);

  if (!action) { panel.innerHTML = '<div class="empty-state">Select an action</div>'; return; }
  const ck = action.chromaKey  || {};
  const cp = action.completion || {};

  panel.innerHTML = `
    <div class="label" style="margin-bottom:6px">Action name</div>
    <input class="input" id="actionNameInput" value="${esc(action.name)}">

    <div class="divider"></div>
    <div class="section-title" style="margin-bottom:6px">Background removal</div>

    <div class="form-row" style="margin-bottom:4px">
      <span class="label">Enabled</span>
      <label class="toggle">
        <input type="checkbox" id="ckEnabled" ${ck.enabled!==false?'checked':''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="color-row">
      <span class="label" style="min-width:72px;flex-shrink:0">Colour</span>
      <span class="color-swatch"><input type="color" id="ckColor" value="${ck.color||'#4488cc'}"></span>
      <button class="btn btn-ghost btn-sm" id="btnEyedrop" title="Pick colour from video" style="flex-shrink:0">&#128065;</button>
    </div>
    <div class="slider-row">
      <span class="label">Tolerance</span>
      <input type="range" id="ckTol" min="0" max="255" value="${ck.tolerance??80}">
      <span class="slider-val" id="ckTolV">${ck.tolerance??80}</span>
    </div>
    <div class="slider-row">
      <span class="label">Softness</span>
      <input type="range" id="ckSoft" min="0" max="120" value="${ck.softness??30}">
      <span class="slider-val" id="ckSoftV">${ck.softness??30}</span>
    </div>

    <div class="divider"></div>
    <div class="section-title" style="margin-bottom:6px">When clip ends</div>
    <div class="radio-group" id="completionMode">
      <label class="radio-opt"><input type="radio" name="mode" value="seamless" ${cp.mode==='seamless'?'checked':''}> Seamless (video ends on reference pose)</label>
      <label class="radio-opt"><input type="radio" name="mode" value="transition" ${cp.mode!=='seamless'?'checked':''}> Transition back</label>
    </div>

    <div id="transitionOpts" style="${cp.mode==='seamless'?'display:none':''};margin-top:8px;display:flex;flex-direction:column;gap:6px">
      <div class="label">Return transition</div>
      <div class="radio-group" id="transitionType">
        ${['fade','slide-left','slide-right','slide-top','slide-bottom'].map(t=>`
          <label class="radio-opt"><input type="radio" name="trans" value="${t}" ${(cp.transition||'fade')===t?'checked':''}> ${t}</label>
        `).join('')}
      </div>
      <div class="slider-row">
        <span class="label">Duration</span>
        <input type="range" id="transDur" min="200" max="3000" step="100" value="${cp.duration||800}">
        <span class="slider-val" id="transDurV">${cp.duration||800}ms</span>
      </div>
    </div>`;

  // Save helper
  const save = makeDebounce(async () => {
    const newCk = {
      enabled:   document.getElementById('ckEnabled').checked,
      color:     document.getElementById('ckColor').value,
      tolerance: parseInt(document.getElementById('ckTol').value),
      softness:  parseInt(document.getElementById('ckSoft').value),
    };
    const mode  = document.querySelector('[name=mode]:checked')?.value || 'transition';
    const trans = document.querySelector('[name=trans]:checked')?.value || 'fade';
    const dur   = parseInt(document.getElementById('transDur')?.value || '800');
    const newCp = { mode, transition: trans, duration: dur, easing: 'ease-in-out' };
    const name  = document.getElementById('actionNameInput').value;

    const updated = await API.updateAction(state.project.id, char.id, action.id, { name, chromaKey: newCk, completion: newCp });
    const proj    = { ...state.project, characters: state.project.characters.map(c =>
      c.id === char.id ? { ...c, actions: c.actions.map(a => a.id === action.id ? updated : a) } : c) };
    setState({ project: proj });
    if (_ctx.videoPlayer) _ctx.videoPlayer.updateChromaKey(newCk);
  }, 300);

  panel.querySelectorAll('input').forEach(el => el.addEventListener('input', e => {
    // Live label updates
    if (el.id === 'ckTol')    document.getElementById('ckTolV').textContent  = el.value;
    if (el.id === 'ckSoft')   document.getElementById('ckSoftV').textContent = el.value;
    if (el.id === 'transDur') document.getElementById('transDurV').textContent = el.value + 'ms';
    // Show/hide transition opts
    if (el.name === 'mode') {
      document.getElementById('transitionOpts').style.display = el.value === 'seamless' ? 'none' : 'flex';
    }
    save();
  }));

  // Eyedropper
  document.getElementById('btnEyedrop').addEventListener('click', () => {
    const canvas = document.getElementById('canvas-action');
    _flash(document.getElementById('btnEyedrop'), 'Click canvas…');
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('click', e => {
      const rect  = canvas.getBoundingClientRect();
      const normX = (e.clientX - rect.left) / rect.width;
      const normY = (e.clientY - rect.top)  / rect.height;
      const col   = sampleColor(canvas, normX, normY);
      document.getElementById('ckColor').value = col;
      canvas.style.cursor = 'default';
      save();
    }, { once: true });
  });
}

// ── Generation form ───────────────────────────────────────────────────────────

export function setupGenerateForm() {
  const btn  = document.getElementById('btnGenerate');
  const area = document.getElementById('genPrompt');
  const mode = document.getElementById('genMode');
  const name = document.getElementById('genName');

  btn.addEventListener('click', async () => {
    const char = state.project?.characters?.find(c => c.id === state.selectedCharId);
    if (!char) return alert('Select a character first');
    if (!area.value.trim()) return alert('Enter a prompt');

    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Submitting…';
    try {
      const result = await API.generateAction(state.project.id, char.id, {
        prompt:     area.value.trim(),
        mode:       mode.value,
        actionName: name.value.trim() || area.value.trim().slice(0, 40),
      });
      area.value = ''; name.value = '';
      // Start polling
      _ctx.startJobPolling(result.jobId, result.actionId, char.id);
    } catch (err) {
      alert('Generate failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '&#9654; Generate';
    }
  });
}

// ── Job queue ─────────────────────────────────────────────────────────────────

export function renderJobQueue() {
  const list   = document.getElementById('queue-list');
  const badge  = document.getElementById('queueBadge');
  const jobs   = state.jobs;
  const active = Object.values(jobs).filter(j => j.status !== 'done' && j.status !== 'error');
  badge.textContent = active.length ? `(${active.length})` : '';

  list.innerHTML = Object.entries(jobs).map(([id, j]) => `
    <div class="job-row">
      <span class="job-prompt">${esc(j.prompt || id.slice(0, 8))}</span>
      <span class="job-status ${j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : 'generating'}">
        ${j.status === 'generating' || j.status === 'polling' ? `<span class="spinner"></span> ` : ''}
        ${j.status}${j.elapsed ? ` (${j.elapsed}s)` : ''}
      </span>
    </div>`).join('') || '<div class="empty-state">No jobs running</div>';
}

// ── Play button ───────────────────────────────────────────────────────────────

function _updatePlayBtn() {
  const btn = document.getElementById('btnPlay');
  if (!btn) return;
  const isPlaying = state.playerState !== 'idle';
  btn.textContent = isPlaying ? '⏹ Stop' : '▶ Play action';
  btn.className   = isPlaying ? 'btn btn-danger' : 'btn btn-success';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function pct(v) { return Math.round(v * 100) + '%'; }
function _flash(el, msg) { const orig = el.textContent; el.textContent = msg; setTimeout(() => { el.textContent = orig; }, 1500); }
function makeDebounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
