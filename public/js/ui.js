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
  _setupJobQueue();
  on('project',          () => renderAll());
  on('selectedCharId',   () => { renderCharList(); renderActionLibrary(); renderCharSettings(); renderSpinePanel(); renderActionSettings(); });
  on('selectedActionId', () => { renderActionSettings(); highlightAction(); });
  on('playerState',      () => _updatePlayBtn());
  on('jobs',             () => renderJobQueue());
}

// ── Global render ────────────────────────────────────────────────────────────

function renderAll() {
  renderCharList();
  renderActionLibrary();
  renderCharSettings();
  renderSpinePanel();
  renderActionSettings();
  renderJobQueue();
  renderStagePanel();
  _ctx.stage?.renderBackground?.(state.project);
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
  // Project name edit
  const nameEl = document.getElementById('projectName');
  nameEl.addEventListener('change', async () => {
    if (!state.project) return;
    const updated = await API.updateProject(state.project.id, { name: nameEl.value });
    setState({ project: updated });
  });

  // Export
  document.getElementById('btnExport').addEventListener('click', async () => {
    if (!state.project) return alert('No project open');
    try {
      await API.exportProject(state.project.id);
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
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
    const proj  = await API.createProject({ name, stageWidth: 1280, stageHeight: 720 });
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

function _setupJobQueue() {
  const clearBtn = document.getElementById('btnClearQueue');
  clearBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const remainingJobs = Object.fromEntries(
      Object.entries(state.jobs).filter(([, job]) => job.status !== 'done' && job.status !== 'error')
    );
    setState({ jobs: remainingJobs });
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
    <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" id="btnAnalyzeSpine">&#10024; Analyze Idle</button>
      <button class="btn btn-ghost btn-sm" id="btnExportRef" title="Download composed reference image (stage + character)">&#8681; Export reference</button>
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

  document.getElementById('btnExportRef').addEventListener('click', async () => {
    try {
      await API.exportReferenceImage(state.project.id, char.id);
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
  });

  document.getElementById('btnAnalyzeSpine').addEventListener('click', async () => {
    const btn = document.getElementById('btnAnalyzeSpine');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyzing…';
    try {
      const result = await API.analyzeSpine(state.project.id, char.id);
      const proj   = await API.getProject(state.project.id);
      setState({ project: proj });
      _ctx.loadSpineForChar(char.id);
      renderSpinePanel();
      btn.innerHTML = '&#10024; Done!';
    } catch (err) { btn.innerHTML = '⚠ ' + err.message.slice(0, 40); }
    finally { setTimeout(() => { if (btn) btn.innerHTML = '&#10024; Analyze Idle'; btn.disabled = false; }, 3000); }
  });
}

// ── Spine panel (anchors, animations, idle config) ────────────────────────────

export function renderSpinePanel() {
  const panel = document.getElementById('panelSpine');
  if (!panel) return;
  const char = state.project?.characters?.find(c => c.id === state.selectedCharId);
  if (!char) { panel.innerHTML = '<div class="empty-state">Select a character</div>'; return; }

  const sp = char.spineProject;
  if (!sp) {
    panel.innerHTML = `
      <div class="empty-state">No skeleton data yet</div>
      <div style="font-size:11px;color:var(--dim);margin-top:4px">Click <strong>Analyze Idle</strong> in Placement to detect anchors and animations</div>`;
    return;
  }

  const anchors = sp.anchors || [];
  const bones   = sp.bones || [];
  const anims  = sp.animations || [];
  const activeAnimIndices = new Set(_ctx.spineEngine?.getActiveAnimationIndices?.() || []);

  let html = '';
  if (anchors.length) {
    html += `<div class="section-title">Anchors (${anchors.length})</div>
      <div class="debug-anchor-list">`;
    for (const a of anchors) {
      html += `<div class="debug-anchor-item">
        <div class="debug-anchor-header">
          <span class="debug-anchor-type ${a.type === 'root' ? 'root' : 'normal'}">${esc(a.type || 'anchor')}</span>
          ${esc(a.label || a.id)}
        </div>
        <div class="debug-anchor-grid">
          <span class="debug-field-value">x ${(a.x ?? 0).toFixed(3)}</span>
          <span class="debug-field-value">y ${(a.y ?? 0).toFixed(3)}</span>
          <span class="debug-field-value">${bones.length} bones</span>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  if (anims.length) {
    html += `<div class="section-title" style="margin-top:10px">Animations (${anims.length})</div>
      <div class="help-text" style="margin-bottom:6px">Use play to layer animations together, or stop any one without affecting the others.</div>
      <div class="spine-anim-list" id="spineAnimList">`;
    for (let i = 0; i < anims.length; i++) {
      const anim = anims[i];
      if (anim._intensity === undefined) anim._intensity = 1.0;
      if (anim._speed === undefined) anim._speed = 1.0;
      if (anim._interval === undefined) anim._interval = 0;
      const isPlaying = activeAnimIndices.has(i);
      html += `<div class="anim-accordion ${isPlaying ? 'playing' : ''}" data-anim-idx="${i}">
        <div class="anim-header-row">
          <button class="anim-play-toggle ${isPlaying ? 'active' : ''}" type="button" data-anim-idx="${i}" title="${isPlaying ? 'Stop animation' : 'Play animation'}">
            ${isPlaying ? '&#9632;' : '&#9654;'}
          </button>
          <button class="anim-header" type="button">
          <span class="anim-name">${esc(anim.name || 'Animation')}</span>
          <span class="anim-dur">${(anim.duration ?? 1).toFixed(1)}s</span>
          <span class="anim-chevron">&#9658;</span>
          </button>
        </div>
        <div class="anim-body">
          <div class="anim-slider-row">
            <span class="anim-slider-label">Intensity</span>
            <input type="range" class="anim-slider" data-param="intensity" min="0" max="200" value="${Math.round((anim._intensity ?? 1) * 100)}">
            <span class="anim-slider-val" data-val="intensity">${Math.round((anim._intensity ?? 1) * 100)}%</span>
          </div>
          <div class="anim-slider-row">
            <span class="anim-slider-label">Speed</span>
            <input type="range" class="anim-slider" data-param="speed" min="10" max="300" value="${Math.round((anim._speed ?? 1) * 100)}">
            <span class="anim-slider-val" data-val="speed">${(anim._speed ?? 1).toFixed(1)}x</span>
          </div>
          <div class="anim-slider-row">
            <span class="anim-slider-label">Interval</span>
            <input type="range" class="anim-slider" data-param="interval" min="0" max="50" value="${Math.round((anim._interval ?? 0) * 10)}">
            <span class="anim-slider-val" data-val="interval">${(anim._interval ?? 0).toFixed(1)}s</span>
          </div>
        </div>
      </div>`;
    }
    html += '</div>';
  } else {
    html += '<div class="empty-state" style="margin-top:6px">No animations</div>';
  }

  panel.innerHTML = html;

  const getActiveAnimationIndices = () => _ctx.spineEngine?.getActiveAnimationIndices?.() || [];
  const updateSelectedCharacter = updatedChar => {
    const proj = { ...state.project, characters: state.project.characters.map(c => c.id === char.id ? updatedChar : c) };
    setState({ project: proj });
  };
  const syncSpinePreview = (updatedChar, activeAnimationIndices = getActiveAnimationIndices()) => {
    _ctx.loadSpineForChar(updatedChar.id, { activeAnimationIndices });
  };

  // Accordion toggles
  panel.querySelectorAll('.anim-header').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('.anim-slider')) return;
      const acc = hdr.closest('.anim-accordion');
      acc.classList.toggle('open');
    });
  });

  panel.querySelectorAll('.anim-play-toggle').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.animIdx ?? '0', 10);
      _ctx.spineEngine.toggleAnimation(idx);
      const activeAnimationIndices = getActiveAnimationIndices();
      renderSpinePanel();
      try {
        const updated = await API.updateCharacter(state.project.id, char.id, { spineActiveAnimationIndices: activeAnimationIndices });
        updateSelectedCharacter(updated);
      } catch (err) {
        alert('Failed to save animation playback state: ' + err.message);
        syncSpinePreview(char);
        renderSpinePanel();
      }
    });
  });

  // Slider handlers — update anim and persist
  const saveSpine = makeDebounce(async () => {
    const activeAnimationIndices = getActiveAnimationIndices();
    const updated = await API.updateCharacter(state.project.id, char.id, { spineProject: sp, spineActiveAnimationIndices: activeAnimationIndices });
    updateSelectedCharacter(updated);
    syncSpinePreview(updated, activeAnimationIndices);
  }, 400);

  panel.querySelectorAll('.anim-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const acc = slider.closest('.anim-accordion');
      const idx = parseInt(acc?.dataset.animIdx ?? '0');
      const anim = anims[idx];
      if (!anim) return;
      const param = slider.dataset.param;
      const v = parseInt(slider.value);
      const valEl = acc?.querySelector(`[data-val="${param}"]`);
      if (param === 'intensity') {
        anim._intensity = v / 100;
        if (valEl) valEl.textContent = v + '%';
      } else if (param === 'speed') {
        anim._speed = v / 100;
        if (valEl) valEl.textContent = (v / 100).toFixed(1) + 'x';
      } else if (param === 'interval') {
        anim._interval = v / 10;
        if (valEl) valEl.textContent = (v / 10).toFixed(1) + 's';
      }
      saveSpine();
    });
    slider.addEventListener('click', e => e.stopPropagation());
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
        ${a.status==='ready' ? `<button class="btn btn-sm btn-ghost dup-action" data-action-id="${a.id}" title="Duplicate">&#128196;</button>` : ''}
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
  ul.querySelectorAll('.dup-action').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const char2 = state.project.characters.find(c => c.id === state.selectedCharId);
      try {
        await API.duplicateAction(state.project.id, char2.id, btn.dataset.actionId);
        const proj = await API.getProject(state.project.id);
        setState({ project: proj });
      } catch (err) {
        alert('Duplicate failed: ' + err.message);
      }
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
  const actionCanvas = document.getElementById('canvas-action');
  if (actionCanvas && _ctx?.videoPlayer) _ctx.videoPlayer.clearTrimPreview(actionCanvas);

  const char   = state.project?.characters?.find(c => c.id === state.selectedCharId);
  const action = char?.actions?.find(a => a.id === state.selectedActionId);

  if (!action) { panel.innerHTML = '<div class="empty-state">Select an action</div>'; return; }
  const ck = action.chromaKey  || {};
  const cp = action.completion || {};
  const completionMode = cp.mode || 'seamless';

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
      <span class="color-swatch"><input type="color" id="ckColor" value="${ck.color||'#00ff00'}"></span>
      <button class="btn btn-ghost btn-sm" id="btnEyedrop" title="Pick colour from video" style="flex-shrink:0">&#128065;</button>
    </div>
    <div class="slider-row">
      <span class="label">Tolerance</span>
      <input type="range" id="ckTol" min="0" max="255" value="${ck.tolerance??5}">
      <span class="slider-val" id="ckTolV">${ck.tolerance??5}</span>
    </div>
    <div class="slider-row">
      <span class="label">Softness</span>
      <input type="range" id="ckSoft" min="0" max="120" value="${ck.softness??5}">
      <span class="slider-val" id="ckSoftV">${ck.softness??5}</span>
    </div>

    <div class="divider"></div>
    <div class="section-title" style="margin-bottom:6px">When clip ends</div>
    <div class="radio-group" id="completionMode">
      <label class="radio-opt"><input type="radio" name="mode" value="seamless" ${completionMode === 'seamless' ? 'checked' : ''}> Seamless (video ends on reference pose)</label>
      <label class="radio-opt"><input type="radio" name="mode" value="transition" ${completionMode === 'transition' ? 'checked' : ''}> Transition back</label>
    </div>

    <div id="transitionOpts" style="display:${completionMode === 'transition' ? 'flex' : 'none'};margin-top:8px;flex-direction:column;gap:6px">
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
    </div>

    ${action.videoUrl && action.status==='ready' && (action.duration || 0) > 0 ? `
    <div class="divider"></div>
    <div class="section-title" style="margin-bottom:6px">Trim playback</div>
    <p class="trim-hint">Drag sliders to set start/end. Frame preview on canvas while dragging.</p>
    <div class="slider-row">
      <span class="label">Start</span>
      <input type="range" id="trimStart" min="0" max="${(action.duration||0).toFixed(1)}" step="0.1" value="${(action.trimStart ?? 0).toFixed(1)}">
      <span class="slider-val" id="trimStartV">${(action.trimStart ?? 0).toFixed(1)}s</span>
    </div>
    <div class="slider-row">
      <span class="label">End</span>
      <input type="range" id="trimEnd" min="0" max="${(action.duration||0).toFixed(1)}" step="0.1" value="${(action.trimEnd != null ? action.trimEnd : action.duration || 0).toFixed(1)}">
      <span class="slider-val" id="trimEndV">${(action.trimEnd != null ? action.trimEnd : action.duration || 0).toFixed(1)}s</span>
    </div>
    ` : ''}`;

  // Save helper
  const save = makeDebounce(async () => {
    const newCk = {
      enabled:   document.getElementById('ckEnabled').checked,
      color:     document.getElementById('ckColor').value,
      tolerance: parseInt(document.getElementById('ckTol').value),
      softness:  parseInt(document.getElementById('ckSoft').value),
    };
    const mode  = document.querySelector('[name=mode]:checked')?.value || 'seamless';
    const trans = document.querySelector('[name=trans]:checked')?.value || 'fade';
    const dur   = parseInt(document.getElementById('transDur')?.value || '800');
    const newCp = { mode, transition: trans, duration: dur, easing: 'ease-in-out' };
    const name  = document.getElementById('actionNameInput').value;
    const trimStartEl = document.getElementById('trimStart');
    const trimEndEl   = document.getElementById('trimEnd');
    const trimStart   = trimStartEl ? parseFloat(trimStartEl.value) : undefined;
    const trimEnd     = trimEndEl ? parseFloat(trimEndEl.value) : undefined;
    const payload     = { name, chromaKey: newCk, completion: newCp };
    if (trimStartEl) payload.trimStart = trimStart;
    if (trimEndEl) payload.trimEnd = trimEnd;

    const updated = await API.updateAction(state.project.id, char.id, action.id, payload);
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

  // Trim sliders with frame preview
  const trimStartEl = document.getElementById('trimStart');
  const trimEndEl   = document.getElementById('trimEnd');
  const dur = action.duration || 0;

  if (trimStartEl && trimEndEl && dur > 0 && _ctx.videoPlayer) {
    const showFrameAt = async (time) => {
      actionCanvas.style.transition = '';
      actionCanvas.style.opacity = '1';
      await _ctx.videoPlayer.showTrimFrame(action.videoUrl, actionCanvas, time, action.chromaKey);
    };
    const hidePreview = () => {
      _ctx.videoPlayer.clearTrimPreview(actionCanvas);
      actionCanvas.style.opacity = '0';
    };

    const onTrimInput = async (e) => {
      const el = e.target;
      const t = parseFloat(el.value);
      if (el.id === 'trimStart') {
        document.getElementById('trimStartV').textContent = t.toFixed(1) + 's';
        if (trimEndEl.value < t) trimEndEl.value = t;
      } else {
        document.getElementById('trimEndV').textContent = t.toFixed(1) + 's';
        if (trimStartEl.value > t) trimStartEl.value = t;
      }
      await showFrameAt(t);
    };
    const onTrimChange = () => {
      hidePreview();
      save();
    };

    trimStartEl.addEventListener('input', onTrimInput);
    trimEndEl.addEventListener('input', onTrimInput);
    trimStartEl.addEventListener('change', onTrimChange);
    trimEndEl.addEventListener('change', onTrimChange);
    trimStartEl.addEventListener('mouseup', onTrimChange);
    trimEndEl.addEventListener('mouseup', onTrimChange);
  }
}

// ── Stage panel ───────────────────────────────────────────────────────────────

function renderStagePanel() {
  const panel = document.getElementById('panelStage');
  if (!panel) return;

  const proj = state.project;
  if (!proj) { panel.innerHTML = '<div class="empty-state">Create or open a project</div>'; return; }

  const bg   = proj.backgroundImage;
  let html = '';

  if (bg) {
    const p = bg.placement || { x: 0.5, y: 0.5, scale: 1 };
    html += `
    <div class="section-title">Background image</div>
    <div class="bg-image-row">
      <img class="bg-thumb" src="${bg.url}" alt="">
      <div class="bg-image-controls">
        <div class="slider-row">
          <span class="label">X</span>
          <input type="range" min="0" max="1" step="0.01" value="${p.x??0.5}" id="bgX">
          <span class="slider-val" id="bgXv">${pct(p.x??0.5)}</span>
        </div>
        <div class="slider-row">
          <span class="label">Y</span>
          <input type="range" min="0" max="1" step="0.01" value="${p.y??0.5}" id="bgY">
          <span class="slider-val" id="bgYv">${pct(p.y??0.5)}</span>
        </div>
        <div class="slider-row">
          <span class="label">Scale</span>
          <input type="range" min="0.1" max="2" step="0.05" value="${p.scale??1}" id="bgS">
          <span class="slider-val" id="bgSv">${(p.scale??1).toFixed(2)}</span>
        </div>
        <button class="btn btn-ghost btn-sm btn-danger" id="btnRemoveBg" style="margin-top:4px">Remove image</button>
      </div>
    </div>`;
  } else {
    html += `
    <div class="section-title">Background image</div>
    <div id="bgImageZone" class="drop-zone drop-zone-sm">
      <input type="file" id="bgImageInput" accept="image/*">
      &#8679; Drop image here
    </div>`;
  }

  panel.innerHTML = html;

  // Background image upload
  const bgZone = document.getElementById('bgImageZone');
  const bgInput = document.getElementById('bgImageInput');
  if (bgZone && bgInput && proj) {
    bgZone.addEventListener('click', () => bgInput.click());
    bgZone.addEventListener('dragover', e => { e.preventDefault(); bgZone.classList.add('drag-over'); });
    bgZone.addEventListener('dragleave', () => bgZone.classList.remove('drag-over'));
    bgZone.addEventListener('drop', async e => {
      e.preventDefault();
      bgZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file?.type?.startsWith('image/')) {
        try {
          const up = await API.uploadBackgroundImage(proj.id, file);
          setState({ project: up });
        } catch (err) { alert('Upload failed: ' + err.message); }
      }
    });
    bgInput.addEventListener('change', async () => {
      const file = bgInput.files[0];
      if (file) {
        try {
          const up = await API.uploadBackgroundImage(proj.id, file);
          setState({ project: up });
        } catch (err) { alert('Upload failed: ' + err.message); }
        bgInput.value = '';
      }
    });
  }

  // Background image placement + remove
  if (bg && proj) {
    const saveBgPlacement = makeDebounce(async () => {
      const x = parseFloat(document.getElementById('bgX')?.value ?? 0.5);
      const y = parseFloat(document.getElementById('bgY')?.value ?? 0.5);
      const s = parseFloat(document.getElementById('bgS')?.value ?? 1);
      const up = await API.updateProject(proj.id, {
        backgroundImage: { ...proj.backgroundImage, placement: { x, y, scale: s } },
      });
      setState({ project: up });
      _ctx.stage?.renderBackground?.(up);
    }, 300);

    ['bgX', 'bgY', 'bgS'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', e => {
        const labels = { bgX: 'bgXv', bgY: 'bgYv', bgS: 'bgSv' };
        const lbl = document.getElementById(labels[id]);
        if (lbl) lbl.textContent = id === 'bgS' ? parseFloat(e.target.value).toFixed(2) : pct(parseFloat(e.target.value));
        saveBgPlacement();
      });
    });

    document.getElementById('btnRemoveBg')?.addEventListener('click', async () => {
      try {
        const up = await API.deleteBackgroundImage(proj.id);
        setState({ project: up });
      } catch (err) { alert('Remove failed: ' + err.message); }
    });
  }
}

// ── Generation form ───────────────────────────────────────────────────────────

export function setupGenerateForm() {
  const btn      = document.getElementById('btnGenerate');
  const area     = document.getElementById('genPrompt');
  const mode     = document.getElementById('genMode');
  const duration = document.getElementById('genDuration');
  const sound    = document.getElementById('genSound');
  const videoBg  = document.getElementById('genVideoBg');
  const name     = document.getElementById('genName');
  const refInput = document.getElementById('genRefImage');
  const refClear = document.getElementById('genRefClear');
  const refHelp = document.getElementById('genRefHelp');
  const includeBgImage = document.getElementById('genIncludeBgImage');

  const syncReferenceUi = () => {
    const hasCustomReference = Boolean(refInput?.files?.length);
    if (includeBgImage) includeBgImage.disabled = hasCustomReference;
    if (videoBg) videoBg.disabled = hasCustomReference;
    if (refHelp) {
      refHelp.textContent = hasCustomReference
        ? 'Your uploaded image will be used for both the first and last frame.'
        : 'The composed stage image will be used for both the first and last frame.';
    }
  };

  refClear?.addEventListener('click', () => {
    if (refInput) { refInput.value = ''; refInput.dispatchEvent(new Event('change')); }
  });
  refInput?.addEventListener('change', syncReferenceUi);
  syncReferenceUi();

  btn.addEventListener('click', async () => {
    const char = state.project?.characters?.find(c => c.id === state.selectedCharId);
    if (!char) return alert('Select a character first');
    if (!area.value.trim()) return alert('Enter a prompt');

    const payload = {
      prompt:     area.value.trim(),
      mode:       mode.value,
      duration:   parseInt(duration?.value || '8', 10),
      sound:      sound?.checked ?? true,
      videoBackground: videoBg?.value || '#00ff00',
      actionName: (name.value.trim() || area.value.trim().slice(0, 40)),
      includeBackgroundImage: includeBgImage?.checked ?? true,
    };
    const refFile = refInput?.files?.[0];
    if (refFile) payload.referenceImage = refFile;

    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Submitting…';
    try {
      const result = await API.generateAction(state.project.id, char.id, payload);
      area.value = ''; name.value = '';
      if (refInput) refInput.value = '';
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
  const clearBtn = document.getElementById('btnClearQueue');
  const jobs   = state.jobs;
  const active = Object.values(jobs).filter(j => j.status !== 'done' && j.status !== 'error');
  const completed = Object.values(jobs).filter(j => j.status === 'done' || j.status === 'error');
  badge.textContent = active.length ? `(${active.length})` : '';
  if (clearBtn) {
    clearBtn.style.visibility = completed.length ? 'visible' : 'hidden';
    clearBtn.disabled = !completed.length;
  }

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
