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

    this._el.addEventListener('canplay', () => this.dispatchEvent(new CustomEvent('canplay')));
    this._el.addEventListener('ended',   () => this.dispatchEvent(new CustomEvent('ended')));

    this._raf         = null;
    this._displayCanvas = null;
    this._chromaKey   = null;
  }

  /**
   * Load a video URL and return a Promise that resolves when it can play.
   * @param {string} src
   * @param {HTMLCanvasElement} displayCanvas
   * @param {object} chromaKeySettings
   */
  load(src, displayCanvas, chromaKeySettings) {
    this._displayCanvas = displayCanvas;
    this._chromaKey     = chromaKeySettings;
    return new Promise(resolve => {
      this._el.addEventListener('canplay', resolve, { once: true });
      this._el.src = src;
      this._el.load();
    });
  }

  updateChromaKey(settings) { this._chromaKey = settings; }

  play() {
    const p = this._el.play();
    this._startRaf();
    return p;
  }

  pause() { this._el.pause(); this._stopRaf(); }

  stop() {
    this._el.pause();
    this._el.currentTime = 0;
    this._stopRaf();
    if (this._displayCanvas) {
      this._displayCanvas.getContext('2d').clearRect(0, 0, this._displayCanvas.width, this._displayCanvas.height);
    }
  }

  get readyState() { return this._el.readyState; }
  get duration()   { return this._el.duration || 0; }
  get ended()      { return this._el.ended; }

  _startRaf() {
    if (this._raf) return;
    const tick = () => {
      if (!this._el.paused && !this._el.ended && this._el.readyState >= 2 && this._displayCanvas) {
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

  _stopRaf() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  destroy() {
    this._stopRaf();
    this._el.remove();
  }
}
