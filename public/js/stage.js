/**
 * StageManager — canvas sizing, drag-to-place character, guides, UI layer.
 */
import { state, setState } from './state.js';

const CANVAS_IDS  = ['canvas-bg', 'canvas-spine', 'canvas-action', 'canvas-ui'];
const GUIDE_COLOR = 'rgba(99,102,241,.4)';
const HANDLE_R    = 8;

export class StageManager {
  constructor() {
    this._canvases = {};
    for (const id of CANVAS_IDS) this._canvases[id] = document.getElementById(id);
    this._uiCtx    = this._canvases['canvas-ui'].getContext('2d');
    this._drag     = null;
    this._showGuides = true;
    this._onCharMoved = null; // callback(normX, normY)
    this._bindDrag();
    window.addEventListener('resize', () => this.fit());
  }

  /** Scale the stage element to fill the available wrapper. */
  fit() {
    const wrapper = document.getElementById('stage-wrapper');
    const avail_w = wrapper.clientWidth  - 24;
    const avail_h = wrapper.clientHeight - 24;
    const ar      = state.stageW / state.stageH;
    let dw, dh;
    if (avail_w / avail_h > ar) { dh = avail_h; dw = dh * ar; }
    else                        { dw = avail_w; dh = dw / ar; }

    const stage = document.getElementById('stage');
    stage.style.width  = dw + 'px';
    stage.style.height = dh + 'px';

    const scale = dw / state.stageW;
    setState({ stageScale: scale });

    for (const id of CANVAS_IDS) {
      const c = this._canvases[id];
      c.width  = state.stageW;
      c.height = state.stageH;
      c.style.width  = dw + 'px';
      c.style.height = dh + 'px';
    }
    this.renderUI();
  }

  /** Draw the UI canvas: safe guides + character handle. */
  renderUI(char) {
    const ctx = this._uiCtx;
    const w   = state.stageW;
    const h   = state.stageH;
    ctx.clearRect(0, 0, w, h);

    if (this._showGuides) this._drawGuides(ctx, w, h);
    if (char) this._drawHandle(ctx, char, w, h);
  }

  _drawGuides(ctx, w, h) {
    ctx.save();
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 6]);
    // Title-safe: 10% inset
    const mx = w * 0.1, my = h * 0.1;
    ctx.strokeRect(mx, my, w - mx * 2, h - my * 2);
    // Centre cross
    ctx.beginPath();
    ctx.moveTo(w / 2 - 20, h / 2); ctx.lineTo(w / 2 + 20, h / 2);
    ctx.moveTo(w / 2, h / 2 - 20); ctx.lineTo(w / 2, h / 2 + 20);
    ctx.stroke();
    ctx.restore();
  }

  _drawHandle(ctx, char, w, h) {
    const px = char.placement.x * w;
    const py = char.placement.y * h;
    ctx.save();
    ctx.strokeStyle = '#6366f1';
    ctx.fillStyle   = 'rgba(99,102,241,.25)';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(px, py, HANDLE_R, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // cross-hair lines
    ctx.beginPath();
    ctx.moveTo(px - 16, py); ctx.lineTo(px + 16, py);
    ctx.moveTo(px, py - 16); ctx.lineTo(px, py + 16);
    ctx.stroke();
    ctx.restore();
  }

  /** Register callback for when user drags the character handle. */
  onCharMoved(fn) { this._onCharMoved = fn; }

  toggleGuides(v) { this._showGuides = v; }

  canvas(id) { return this._canvases[id]; }

  /** Convert CSS mouse position to logical stage coordinates. */
  _cssToLogical(e) {
    const rect  = document.getElementById('stage').getBoundingClientRect();
    const cssX  = e.clientX - rect.left;
    const cssY  = e.clientY - rect.top;
    const normX = cssX / rect.width;
    const normY = cssY / rect.height;
    return {
      logX: normX * state.stageW,
      logY: normY * state.stageH,
      normX, normY,
    };
  }

  _bindDrag() {
    const uiCanvas = this._canvases['canvas-ui'];

    uiCanvas.addEventListener('mousedown', (e) => {
      const char = this._activeChar();
      if (!char) return;
      const { logX, logY } = this._cssToLogical(e);
      const hx = char.placement.x * state.stageW;
      const hy = char.placement.y * state.stageH;
      if (Math.hypot(logX - hx, logY - hy) < HANDLE_R * 2) {
        this._drag = { startLogX: logX, startLogY: logY };
        uiCanvas.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._drag) return;
      const { normX, normY } = this._cssToLogical(e);
      const x = Math.max(0, Math.min(1, normX));
      const y = Math.max(0, Math.min(1, normY));
      if (this._onCharMoved) this._onCharMoved(x, y);
    });

    window.addEventListener('mouseup', () => {
      if (this._drag) {
        this._drag = null;
        this._canvases['canvas-ui'].style.cursor = 'default';
      }
    });
  }

  _activeChar() {
    return state.project?.characters?.find(c => c.id === state.selectedCharId);
  }
}
