/**
 * VideoPlayer — manages the hidden <video> element used for action clip playback.
 * Emits standard CustomEvents: 'canplay', 'ended'.
 */
import { applyChromaKey } from './chroma-key.js';

export class VideoPlayer extends EventTarget {
  constructor() {
    super();
    this._el = document.createElement('video');
    this._el.muted      = true;
    this._el.playsInline = true;
    this._el.loop       = false;
    this._el.preload    = 'auto';
    this._el.style.display = 'none';
    document.body.appendChild(this._el);

    this._scrubEl = document.createElement('video');
    this._scrubEl.muted = true;
    this._scrubEl.playsInline = true;
    this._scrubEl.preload = 'auto';
    this._scrubEl.style.display = 'none';
    document.body.appendChild(this._scrubEl);

    this._audioEl = null;

    this._el.addEventListener('canplay', () => this.dispatchEvent(new CustomEvent('canplay')));
    this._el.addEventListener('playing', () => this.dispatchEvent(new CustomEvent('playing')));
    this._el.addEventListener('ended',   () => this.dispatchEvent(new CustomEvent('ended')));

    this._raf         = null;
    this._displayCanvas = null;
    this._chromaKey   = null;
    this._trimStart   = 0;
    this._trimEnd     = null;
    this._scrubSrc    = null;
  }

  /**
   * Load a video URL and return a Promise that resolves when it can play.
   * @param {string} src
   * @param {HTMLCanvasElement} displayCanvas
   * @param {object} chromaKeySettings
   * @param {{ trimStart?: number, trimEnd?: number, audioUrl?: string }} [opts]
   */
  load(src, displayCanvas, chromaKeySettings, opts = {}) {
    this._displayCanvas = displayCanvas;
    this._chromaKey     = chromaKeySettings;
    this._trimStart     = opts.trimStart ?? 0;
    this._trimEnd       = opts.trimEnd ?? null;
    this._audioUrl      = opts.audioUrl ?? null;
    this._stopAudio();
    if (this._audioUrl) {
      this._audioEl = new Audio();
      this._audioEl.src = this._audioUrl.startsWith('http') ? this._audioUrl : (window.location.origin || '') + this._audioUrl;
    } else {
      this._audioEl = null;
    }
    return new Promise(resolve => {
      this._el.addEventListener('canplay', resolve, { once: true });
      this._el.src = src.startsWith('http') ? src : (window.location.origin || '') + src;
      this._el.load();
    });
  }

  updateChromaKey(settings) { this._chromaKey = settings; }

  play() {
    this._el.currentTime = this._trimStart;
    if (this._audioEl) {
      this._audioEl.currentTime = this._trimStart;
      this._audioEl.play().catch(() => {});
    }
    const p = this._el.play();
    this._startRaf();
    return p;
  }

  pause() {
    this._el.pause();
    this._stopAudio();
    this._stopRaf();
  }

  stop() {
    this._el.pause();
    this._el.currentTime = 0;
    this._stopAudio();
    this._stopRaf();
    if (this._displayCanvas) {
      this._displayCanvas.getContext('2d').clearRect(0, 0, this._displayCanvas.width, this._displayCanvas.height);
    }
  }

  _stopAudio() {
    if (this._audioEl) {
      this._audioEl.pause();
      this._audioEl.currentTime = 0;
      this._audioEl.src = '';
      this._audioEl = null;
    }
  }

  get readyState() { return this._el.readyState; }
  get paused()     { return this._el.paused; }
  get duration()   { return this._el.duration || 0; }
  get ended()      { return this._el.ended; }

  _startRaf() {
    if (this._raf) return;
    const endTime = this._trimEnd ?? (this._el.duration || Infinity);
    const tick = () => {
      if (!this._el.paused && !this._el.ended && this._el.readyState >= 2 && this._displayCanvas) {
        if (this._el.currentTime >= endTime) {
          this._el.pause();
          this._el.currentTime = endTime;
          this._stopAudio();
          this.dispatchEvent(new CustomEvent('ended'));
          this._stopRaf();
          return;
        }
        applyChromaKey(this._displayCanvas, this._el, this._chromaKey);
      }
      if (!this._el.paused && !this._el.ended) {
        this._raf = requestAnimationFrame(tick);
      } else {
        this._raf = null;
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  /**
   * Show a single frame at the given time on the canvas (for trim scrubbing).
   * @param {string} src - Video URL
   * @param {HTMLCanvasElement} canvas
   * @param {number} time - Time in seconds
   * @param {object} chromaKey
   */
  async showTrimFrame(src, canvas, time, chromaKey) {
    const fullSrc = src.startsWith('http') ? src : (window.location.origin || '') + src;
    if (this._scrubSrc !== fullSrc) {
      this._scrubSrc = fullSrc;
      await new Promise((resolve, reject) => {
        this._scrubEl.onloadeddata = resolve;
        this._scrubEl.onerror = reject;
        this._scrubEl.src = fullSrc;
        this._scrubEl.load();
      });
    }
    return new Promise(resolve => {
      const onSeeked = () => {
        this._scrubEl.removeEventListener('seeked', onSeeked);
        if (canvas && canvas.getContext) {
          applyChromaKey(canvas, this._scrubEl, chromaKey || {});
        }
        resolve();
      };
      this._scrubEl.addEventListener('seeked', onSeeked);
      this._scrubEl.currentTime = Math.max(0, Math.min(time, this._scrubEl.duration || 0));
    });
  }

  clearTrimPreview(canvas) {
    if (canvas && canvas.getContext) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  _stopRaf() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  destroy() {
    this._stopRaf();
    this._el.remove();
    this._scrubEl.remove();
  }
}
