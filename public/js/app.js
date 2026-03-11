/**
 * Video Action Studio — main entry point.
 * Wires together stage, spine engine, video player, transitions and UI.
 */
import { state, setState } from './state.js';
import { API }              from './api.js';
import { StageManager }     from './stage.js';
import { SpineEngine }      from './spine-engine.js';
import { VideoPlayer }      from './video-player.js';
import { TransitionManager } from './transitions.js';
import * as UI              from './ui.js';

// ── Globals ───────────────────────────────────────────────────────────────────

let stage;
let spineEngine;
let videoPlayer;
let transitions;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  stage       = new StageManager();
  spineEngine = new SpineEngine(document.getElementById('canvas-spine'));
  videoPlayer = new VideoPlayer();
  transitions = new TransitionManager();

  // Export shared context so UI callbacks can reach these
  const ctx = { stage, spineEngine, videoPlayer, transitions, loadProject, activateCharacter, loadSpineForChar, playAction, startJobPolling };

  UI.init(ctx);
  UI.setupGenerateForm();

  stage.onCharMoved(async (x, y) => {
    const char = state.project?.characters?.find(c => c.id === state.selectedCharId);
    if (!char) return;
    const updated = await API.updateCharacter(state.project.id, char.id, { placement: { ...char.placement, x, y } });
    const proj = { ...state.project, characters: state.project.characters.map(c => c.id === char.id ? updated : c) };
    setState({ project: proj });
    spineEngine.setPlacement({ x, y });
    stage.renderUI(updated);
    UI.renderCharSettings();
  });

  // Video ended → transition back to idle
  videoPlayer.addEventListener('ended', () => returnToIdle());

  // Play/stop button
  document.getElementById('btnPlay').addEventListener('click', () => {
    if (state.playerState !== 'idle') { returnToIdle(); }
    else if (state.selectedActionId) { playAction(state.selectedActionId); }
  });

  // Stage guides toggle
  document.getElementById('btnGuides').addEventListener('click', () => {
    const active = document.getElementById('btnGuides').classList.toggle('active');
    stage.toggleGuides(active);
    stage.renderUI(state.project?.characters?.find(c => c.id === state.selectedCharId));
  });

  // Upload character drop zone
  _setupUploadZone();

  // Fit stage on load
  stage.fit();

  // Load last project or create a default one
  const projects = await API.listProjects();
  if (projects.length) await loadProject(projects[0].id);
});

// ── Project loading ───────────────────────────────────────────────────────────

async function loadProject(id) {
  const proj = await API.getProject(id);
  const [w, h] = [proj.stageWidth || 1920, proj.stageHeight || 1080];
  setState({ project: proj, stageW: w, stageH: h, selectedCharId: null, selectedActionId: null });
  stage.fit();

  // Activate first character if any
  if (proj.characters?.length) activateCharacter(proj.characters[0].id);
}

// ── Character activation ──────────────────────────────────────────────────────

async function activateCharacter(charId) {
  setState({ selectedCharId: charId, selectedActionId: null });
  const char = state.project?.characters?.find(c => c.id === charId);
  if (!char) return;

  // Reset action layer
  document.getElementById('canvas-action').style.opacity = '0';
  videoPlayer.stop();

  // Load reference image into spine engine
  await spineEngine.loadImage(char.referenceImageUrl);
  spineEngine.setPlacement(char.placement || {});

  // Load spine project if available
  if (char.spineProject) spineEngine.loadProject(char.spineProject);

  // Start idle (use selected idle animation index)
  setState({ playerState: 'idle' });
  document.getElementById('canvas-spine').style.opacity = '1';
  spineEngine.startIdle(char.spineIdleIndex ?? 0);

  // Render UI handle
  stage.renderUI(char);
}

function loadSpineForChar(charId) {
  const char = state.project?.characters?.find(c => c.id === charId);
  if (!char) return;
  if (char.spineProject) {
    spineEngine.loadProject(char.spineProject);
    spineEngine.startIdle(char.spineIdleIndex ?? 0);
  }
}

// ── Action playback ───────────────────────────────────────────────────────────

async function playAction(actionId) {
  if (state.playerState !== 'idle') return;

  const char   = state.project?.characters?.find(c => c.id === state.selectedCharId);
  const action = char?.actions?.find(a => a.id === actionId);
  if (!action?.videoUrl || action.status !== 'ready') return;

  setState({ playerState: 'playing', selectedActionId: actionId });

  const spineCanvas  = document.getElementById('canvas-spine');
  const actionCanvas = document.getElementById('canvas-action');

  spineEngine.stopIdle();
  actionCanvas.style.transition = '';
  actionCanvas.style.opacity    = '1'; // Show action layer (behind spine for now)

  const dur = action.duration || 0;
  const trimStart = action.trimStart ?? 0;
  const trimEnd = (action.trimEnd != null && action.trimEnd > 0) ? action.trimEnd : dur;
  await videoPlayer.load(action.videoUrl, actionCanvas, action.chromaKey, {
    trimStart: Math.max(0, Math.min(trimStart, dur)),
    trimEnd: Math.max(trimStart, Math.min(trimEnd, dur)),
    audioUrl: action.audioUrl || null,
  });
  await videoPlayer.play();

  // Hide spine only when video has started — overlap avoids blink
  const onPlaying = () => {
    videoPlayer.removeEventListener('playing', onPlaying);
    requestAnimationFrame(() => {
      spineCanvas.style.transition = 'opacity .12s';
      spineCanvas.style.opacity    = '0';
    });
  };
  videoPlayer.addEventListener('playing', onPlaying);
  if (videoPlayer.readyState >= 2 && !videoPlayer.paused) onPlaying();
}

async function returnToIdle() {
  if (state.playerState === 'idle') return;
  setState({ playerState: 'transitioning' });

  const char   = state.project?.characters?.find(c => c.id === state.selectedCharId);
  const action = char?.actions?.find(a => a.id === state.selectedActionId);

  const spineCanvas  = document.getElementById('canvas-spine');
  const actionCanvas = document.getElementById('canvas-action');

  const idleIndex = char?.spineIdleIndex ?? 0;

  // Render spine immediately so reference is on canvas before we transition
  spineEngine.renderIdleFrameNow(idleIndex);
  spineEngine.startIdle(idleIndex);

  // Ensure spine has drawn (rAF flushes paint)
  await new Promise(r => requestAnimationFrame(r));

  const type     = action?.completion?.mode === 'seamless' ? 'seamless' : (action?.completion?.transition || 'fade');
  const duration = action?.completion?.duration || 800;

  await transitions.execute({ actionCanvas, spineCanvas, type, duration });

  videoPlayer.stop();
  setState({ playerState: 'idle' });
}

// ── Job polling ───────────────────────────────────────────────────────────────

function startJobPolling(jobId, actionId, charId) {
  const jobs = { ...state.jobs, [jobId]: { status: 'queued', prompt: '', elapsed: 0 } };
  setState({ jobs });
  expandJobQueue();

  const interval = setInterval(async () => {
    try {
      const job = await API.getJob(jobId);
      const newJobs = { ...state.jobs, [jobId]: job };
      setState({ jobs: newJobs });

      if (job.status === 'done' || job.status === 'error') {
        clearInterval(interval);
        if (job.status === 'done') {
          // Refresh project to get updated action
          const proj = await API.getProject(state.project.id);
          setState({ project: proj });
          if (state.selectedCharId === charId) UI.renderActionLibrary();
        }
      }
    } catch { clearInterval(interval); }
  }, 5000);
}

function expandJobQueue() {
  const q = document.getElementById('job-queue');
  q.classList.remove('collapsed');
  q.classList.add('expanded');
}

// ── Character upload ──────────────────────────────────────────────────────────

function _setupUploadZone() {
  const zone  = document.getElementById('uploadZone');
  const input = document.getElementById('uploadInput');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', async e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) await _doUpload(file);
  });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (file) await _doUpload(file);
    input.value = '';
  });
}

async function _doUpload(file) {
  if (!state.project) {
    const proj = await API.createProject({ name: 'Untitled', stageSize: '1080p' });
    await loadProject(proj.id);
  }
  try {
    const char = await API.uploadCharacter(state.project.id, file, file.name.replace(/\.[^.]+$/, ''));
    const proj = await API.getProject(state.project.id);
    setState({ project: proj });
    await activateCharacter(char.id);
  } catch (err) { alert('Upload failed: ' + err.message); }
}
