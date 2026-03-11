/**
 * Video Action Studio — Runtime Loader v1.0
 *
 * A self-contained game integration helper included in every exported package.
 *
 * Usage:
 *   import { loadAnimationPackage } from './runtime/loader.js';
 *   const pkg  = await loadAnimationPackage('./my-package/');
 *   const actor = pkg.createActor('spiderman', document.getElementById('canvas'));
 *   actor.playIdle();
 *   actor.playAction('shoot_web');
 */

'use strict';

// ── Chroma key ─────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = (hex || '#000').replace('#', '').match(/.{2}/g);
  return m ? [parseInt(m[0], 16), parseInt(m[1], 16), parseInt(m[2], 16)] : [0, 0, 0];
}

let _ckWork = null, _ckCtx = null;
function chromaKey(displayCtx, source, settings, w, h) {
  if (!settings?.enabled) {
    displayCtx.clearRect(0, 0, w, h);
    displayCtx.drawImage(source, 0, 0, w, h);
    return;
  }
  if (!_ckWork || _ckWork.width !== w || _ckWork.height !== h) {
    _ckWork = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    _ckCtx  = _ckWork.getContext('2d', { willReadFrequently: true });
  }
  const [tr, tg, tb] = hexToRgb(settings.color);
  const tol     = settings.tolerance ?? 80;
  const soft    = Math.max(1, settings.softness ?? 30);
  const softEnd = tol + soft;

  _ckCtx.clearRect(0, 0, w, h);
  _ckCtx.drawImage(source, 0, 0, w, h);
  const img = _ckCtx.getImageData(0, 0, w, h);
  const d   = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt((d[i]-tr)**2 + (d[i+1]-tg)**2 + (d[i+2]-tb)**2);
    if (dist <= tol)            d[i+3] = 0;
    else if (dist < softEnd)    d[i+3] = Math.round(255 * (dist - tol) / soft);
  }
  displayCtx.clearRect(0, 0, w, h);
  displayCtx.putImageData(img, 0, 0);
}

// ── Easing ─────────────────────────────────────────────────────────────────

function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

// ── Animation package loader ────────────────────────────────────────────────

export async function loadAnimationPackage(baseUrl) {
  const base     = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const manifest = await (await fetch(base + 'manifest.json')).json();
  return new AnimationPackage(base, manifest);
}

class AnimationPackage {
  constructor(baseUrl, manifest) {
    this.baseUrl  = baseUrl;
    this.manifest = manifest;
  }

  /**
   * Create an Actor for a character, bound to a canvas element.
   * @param {string}             characterId
   * @param {HTMLCanvasElement}  canvas
   */
  createActor(characterId, canvas) {
    const charDef = this.manifest.characters?.find(c => c.id === characterId);
    if (!charDef) throw new Error(`Character "${characterId}" not found in manifest`);
    return new Actor(this.baseUrl, charDef, canvas, this.manifest.stage);
  }
}

// ── Actor ──────────────────────────────────────────────────────────────────

class Actor extends EventTarget {
  constructor(baseUrl, charDef, canvas, stage) {
    super();
    this._base    = baseUrl;
    this._char    = charDef;
    this._canvas  = canvas;
    this._stage   = stage;
    this._ctx     = canvas.getContext('2d');
    this._state   = 'idle';   // idle | playing | transitioning
    this._video   = null;
    this._rafId   = null;
    this._refImg  = null;
    this._idleRaf = null;
    this._idleT   = 0;
    this._idleLast = null;

    // Size canvas to stage
    const sw = stage?.width  || 1920;
    const sh = stage?.height || 1080;
    canvas.width  = sw;
    canvas.height = sh;

    // Load reference image
    const refImg = new Image();
    refImg.onload = () => { this._refImg = refImg; this._renderIdle({}); };
    refImg.src    = baseUrl + charDef.reference;
  }

  /** Start (or resume) the idle breathing animation. */
  playIdle() {
    if (this._state === 'playing') this._stopVideo();
    this._state   = 'idle';
    this._idleT   = 0;
    this._idleLast = null;
    cancelAnimationFrame(this._idleRaf);
    const loop = (ts) => {
      if (this._state !== 'idle') return;
      if (this._idleLast) this._idleT += (ts - this._idleLast) / 1000;
      this._idleLast = ts;
      const t = this._idleT % 3.0;
      const scale = 1 + 0.008 * Math.sin(t / 3.0 * Math.PI * 2);
      const dy    = -0.01 * Math.sin(t / 3.0 * Math.PI * 2);
      this._renderIdle({ scale, dy });
      this._idleRaf = requestAnimationFrame(loop);
    };
    this._idleRaf = requestAnimationFrame(loop);
  }

  /**
   * Play an action clip by ID.
   * Returns a Promise that resolves when the clip ends and idle resumes.
   */
  playAction(actionId) {
    const actionDef = this._char.actions?.find(a => a.id === actionId);
    if (!actionDef) return Promise.reject(new Error(`Action "${actionId}" not found`));
    return this._playClip(actionDef);
  }

  /** Stop everything and go back to idle. */
  stop() { this._stopVideo(); this.playIdle(); }

  _renderIdle({ scale = 1, dy = 0 } = {}) {
    if (!this._refImg) return;
    const ctx = this._ctx;
    const cw  = this._canvas.width;
    const ch  = this._canvas.height;
    const p   = this._char.placement;
    const tgtH = ch * (p.scale ?? 0.6) * scale;
    const tgtW = tgtH * (this._refImg.naturalWidth / this._refImg.naturalHeight);
    const px   = p.x * cw - tgtW / 2;
    const py   = p.y * ch - tgtH + (dy * ch);

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(this._refImg, px, py, tgtW, tgtH);
  }

  async _playClip(actionDef) {
    return new Promise(async (resolve) => {
      this._state = 'playing';
      cancelAnimationFrame(this._idleRaf);
      this._idleRaf = null;

      const video = document.createElement('video');
      video.muted       = true;
      video.playsInline = true;
      video.style.display = 'none';
      document.body.appendChild(video);
      this._video = video;

      await new Promise(res => {
        video.addEventListener('canplay', res, { once: true });
        video.src = this._base + actionDef.video;
        video.load();
      });

      const cw = this._canvas.width;
      const ch = this._canvas.height;
      const ck = actionDef.chromaKey;

      const drawFrame = () => {
        if (this._state !== 'playing') return;
        if (video.readyState >= 2) chromaKey(this._ctx, video, ck, cw, ch);
        if (!video.ended) this._rafId = requestAnimationFrame(drawFrame);
      };

      video.addEventListener('ended', async () => {
        this._stopVideo();
        await this._doTransition(actionDef.completion);
        this.playIdle();
        this.dispatchEvent(new CustomEvent('actionEnd', { detail: { actionId: actionDef.id } }));
        resolve();
      }, { once: true });

      await video.play();
      this._rafId = requestAnimationFrame(drawFrame);
    });
  }

  _stopVideo() {
    if (this._video) { this._video.pause(); this._video.remove(); this._video = null; }
    cancelAnimationFrame(this._rafId); this._rafId = null;
  }

  async _doTransition(completion) {
    const type     = completion?.mode === 'seamless' ? 'seamless' : (completion?.transition || 'fade');
    const duration = completion?.duration || 800;
    if (type === 'seamless') return; // video ended on reference pose — nothing to do

    this._state = 'transitioning';
    await new Promise(resolve => {
      let start = null;
      const step = (ts) => {
        if (!start) start = ts;
        const t   = Math.min((ts - start) / duration, 1);
        const et  = easeInOut(t);

        if (type === 'fade') {
          // Fade the action layer out while rendering the reference image
          const alpha = 1 - et;
          this._ctx.globalAlpha = alpha;
          if (this._refImg) this._renderIdle();
          this._ctx.globalAlpha = 1;
        } else {
          // Slide the reference image in from an edge
          const [ox, oy] = this._slideOffset(type, 1 - et);
          this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
          this._ctx.save();
          this._ctx.translate(ox, oy);
          this._renderIdle();
          this._ctx.restore();
        }

        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  _slideOffset(type, fraction) {
    const cw = this._canvas.width, ch = this._canvas.height;
    const offsets = {
      'slide-left':   [-cw * fraction, 0],
      'slide-right':  [ cw * fraction, 0],
      'slide-top':    [0, -ch * fraction],
      'slide-bottom': [0,  ch * fraction],
    };
    return offsets[type] || [0, 0];
  }
}
