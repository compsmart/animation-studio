/**
 * Spine Engine — renders a reference image with skeleton-driven mesh deformation
 * and an idle animation loop.
 *
 * Adapted from the spine-animation app's Viewport, NormalizedMesh,
 * Renderer, and AnimationEngine classes.
 */

// ── Built-in breathing animation (used when no spine project is loaded) ──────
const BREATHE_ANIM = {
  name: 'Breathe',
  duration: 3.0,
  loop: true,
  keyframes: [
    { time: 0.0, transforms: { _body: { scale: 1.000, translateY: 0.000 } } },
    { time: 1.5, transforms: { _body: { scale: 1.008, translateY: -0.010 } } },
    { time: 3.0, transforms: { _body: { scale: 1.000, translateY: 0.000 } } },
  ],
};

// ── NormalizedMesh ────────────────────────────────────────────────────────────

class NormalizedMesh {
  constructor(cols = 12, rows = 12) {
    this.cols = cols; this.rows = rows;
    this.vertices = []; this.triangles = [];
  }

  generate(anchors, bones = []) {
    this.vertices = []; this.triangles = [];
    const { cols, rows } = this;
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) {
        const u = c / cols, v = r / rows;
        this.vertices.push({ x: u, y: v, ox: u, oy: v, u, v, weights: {} });
      }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const tl = r * (cols + 1) + c, tr = tl + 1,
              bl = (r + 1) * (cols + 1) + c, br = bl + 1;
        this.triangles.push(tl, tr, bl, tr, br, bl);
      }
    this._computeWeights(anchors, bones);
  }

  _computeRadii(anchors, bones) {
    const map = Object.fromEntries(anchors.map(a => [a.id, a]));
    return Object.fromEntries(anchors.map(a => {
      const connected = bones.filter(b => b.from === a.id || b.to === a.id);
      if (!connected.length) return [a.id, 0.15];
      const maxLen = Math.max(...connected.map(b => {
        const a1 = map[b.from], a2 = map[b.to];
        return a1 && a2 ? Math.hypot(a1.x - a2.x, a1.y - a2.y) : 0;
      }));
      return [a.id, Math.min(0.4, Math.max(0.05, maxLen * 1.5))];
    }));
  }

  _computeWeights(anchors, bones) {
    if (!anchors.length) return;
    const radii = this._computeRadii(anchors, bones);
    for (const v of this.vertices) {
      let total = 0; let nearId = null, nearDist = Infinity;
      const w = {};
      for (const a of anchors) {
        const d = Math.hypot(v.ox - a.x, v.oy - a.y);
        if (d < nearDist) { nearDist = d; nearId = a.id; }
        const r = radii[a.id];
        if (d >= r) continue;
        const t = d / r, om = 1 - t;
        const wv = om * om * om * om * (1 + 4 * t);
        w[a.id] = wv; total += wv;
      }
      if (!total && nearId) { w[nearId] = 1; total = 1; }
      if (total) for (const id in w) w[id] /= total;
      v.weights = w;
    }
  }

  deform(anchors) {
    for (const v of this.vertices) {
      let dx = 0, dy = 0;
      for (const a of anchors) {
        const w = v.weights[a.id] || 0;
        if (w < 0.001) continue;
        const rad = ((a.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const sx = a.scaleX || 1, sy = a.scaleY || 1;
        const rx = v.ox - a.x, ry = v.oy - a.y;
        const nx = a.x + rx * cos * sx - ry * sin * sy + (a.dx || 0);
        const ny = a.y + rx * sin * sx + ry * cos * sy + (a.dy || 0);
        dx += (nx - v.ox) * w;
        dy += (ny - v.oy) * w;
      }
      v.x = v.ox + dx;
      v.y = v.oy + dy;
    }
  }
}

// ── AnimationEngine ───────────────────────────────────────────────────────────

class AnimationEngine {
  constructor() { this.playing = false; this._anim = null; this._t = 0; this._last = null; this._rafId = null; }

  play(anim, onFrame) {
    this._anim = anim; this._t = 0; this._last = null; this.playing = true;
    this._onFrame = onFrame;
    cancelAnimationFrame(this._rafId);
    const loop = (ts) => {
      if (!this.playing) return;
      const speed = this._anim?._speed ?? 1.0;
      if (this._last !== null) this._t += ((ts - this._last) / 1000) * speed;
      this._last = ts;
      if (this._t >= anim.duration) {
        if (anim.loop) this._t %= anim.duration;
        else { this._t = anim.duration; this.playing = false; }
      }
      if (onFrame) onFrame(this._interpolate(), this._anim);
      if (this.playing) this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() { this.playing = false; cancelAnimationFrame(this._rafId); }

  _interpolate() {
    const kf = this._anim.keyframes;
    if (!kf?.length) return {};
    let prev = kf[0], next = kf[kf.length - 1];
    for (let i = 0; i < kf.length - 1; i++) {
      if (this._t >= kf[i].time && this._t <= kf[i + 1].time) {
        prev = kf[i]; next = kf[i + 1]; break;
      }
    }
    const span = next.time - prev.time;
    const alpha = span > 0 ? (this._t - prev.time) / span : 1;
    const out = {};
    for (const id of new Set([...Object.keys(prev.transforms || {}), ...Object.keys(next.transforms || {})])) {
      const a = prev.transforms?.[id] || {}, b = next.transforms?.[id] || {};
      out[id] = {
        rotation:   lerp(a.rotation   || 0, b.rotation   || 0, alpha),
        translateX: lerp(a.translateX || 0, b.translateX || 0, alpha),
        translateY: lerp(a.translateY || 0, b.translateY || 0, alpha),
        scale:      lerp(a.scale      ?? 1, b.scale      ?? 1, alpha),
      };
    }
    return out;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ── SpineRenderer ─────────────────────────────────────────────────────────────

class SpineRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
  }

  render(image, mesh, anchors, placement) {
    const ctx = this.ctx;
    const cw  = this.canvas.width;
    const ch  = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    if (!image) return;

    const { x = 0.5, y = 0.85, scale = 0.6 } = placement || {};
    const iw = image.naturalWidth  || image.width;
    const ih = image.naturalHeight || image.height;

    // Target height based on stage height and scale
    const tgtH = ch * scale;
    const tgtW = tgtH * (iw / ih);
    const px   = x * cw - tgtW / 2;
    const py   = y * ch - tgtH;

    ctx.save();
    ctx.translate(px, py);

    if (mesh.vertices.length && mesh.triangles.length) {
      const verts = mesh.vertices;
      const tris  = mesh.triangles;
      // Map normalized mesh coords to px/py-relative coords
      for (let i = 0; i < tris.length; i += 3) {
        const v0 = verts[tris[i]], v1 = verts[tris[i + 1]], v2 = verts[tris[i + 2]];
        const x0 = v0.x * tgtW, y0 = v0.y * tgtH;
        const x1 = v1.x * tgtW, y1 = v1.y * tgtH;
        const x2 = v2.x * tgtW, y2 = v2.y * tgtH;
        const su0 = v0.u * iw, sv0 = v0.v * ih;
        const su1 = v1.u * iw, sv1 = v1.v * ih;
        const su2 = v2.u * iw, sv2 = v2.v * ih;
        const det = (su1 - su0) * (sv2 - sv0) - (su2 - su0) * (sv1 - sv0);
        if (Math.abs(det) < 0.001) continue;
        ctx.save();
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); ctx.clip();
        const a = ((x1 - x0) * (sv2 - sv0) - (x2 - x0) * (sv1 - sv0)) / det;
        const b = ((x2 - x0) * (su1 - su0) - (x1 - x0) * (su2 - su0)) / det;
        const c = x0 - a * su0 - b * sv0;
        const d = ((y1 - y0) * (sv2 - sv0) - (y2 - y0) * (sv1 - sv0)) / det;
        const e = ((y2 - y0) * (su1 - su0) - (y1 - y0) * (su2 - su0)) / det;
        const f = y0 - d * su0 - e * sv0;
        ctx.setTransform(a, d, b, e, c + px, f + py);
        ctx.drawImage(image, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.restore();
      }
    } else {
      ctx.drawImage(image, 0, 0, tgtW, tgtH);
    }
    ctx.restore();
  }
}

// ── SpineEngine (public API) ──────────────────────────────────────────────────

export class SpineEngine {
  constructor(canvas) {
    this._canvas     = canvas;
    this._renderer   = new SpineRenderer(canvas);
    this._mesh       = new NormalizedMesh(12, 12);
    this._animEngine = new AnimationEngine();
    this._image      = null;
    this._anchors    = [];
    this._bones      = [];
    this._placement  = { x: 0.5, y: 0.85, scale: 0.6 };
    this._spineData  = null;
  }

  /** Load the character reference image from a URL. */
  loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => { this._image = img; this._rebuildMesh(); resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  /** Load (or replace) a Spine project JSON. */
  loadProject(spineData) {
    this._spineData = spineData;
    if (spineData) {
      this._anchors = (spineData.anchors || []).map(a => ({ ...a, dx: 0, dy: 0, rotation: 0, scaleX: 1, scaleY: 1 }));
      this._bones   = spineData.bones || [];
      this._rebuildMesh();
    }
  }

  /** Update placement (x, y, scale). */
  setPlacement(p) { this._placement = { ...this._placement, ...p }; }

  /** Start idle animation. Uses animation at idleIndex, or first, or built-in breathe. */
  startIdle(idleIndex = 0) {
    const anims = this._spineData?.animations;
    const anim  = (anims && anims[idleIndex]) || anims?.[0] || BREATHE_ANIM;
    this._animEngine.play(anim, (transforms, a) => this._applyTransforms(transforms, a));
  }

  /** Render idle pose at t=0 immediately (ensures canvas has content before transition). */
  renderIdleFrameNow(idleIndex = 0) {
    const anims = this._spineData?.animations;
    const anim  = (anims && anims[idleIndex]) || anims?.[0] || BREATHE_ANIM;
    if (!this._image) return;
    const kf = anim.keyframes?.[0];
    const transforms = kf?.transforms || {};
    this._applyTransforms(transforms, anim);
  }

  /** Stop animation. */
  stopIdle() { this._animEngine.stop(); }

  /** Render a single static frame (no animation). */
  renderStatic() {
    this._renderer.render(this._image, this._mesh, this._anchors, this._placement);
  }

  _rebuildMesh() {
    if (this._anchors.length) this._mesh.generate(this._anchors, this._bones);
    else this._mesh.generate([], []);
  }

  _applyTransforms(transforms, anim) {
    if (!this._image) return;
    const intensity = anim?._intensity ?? 1.0;

    // Reset anchor base
    for (const a of this._anchors) { a.dx = 0; a.dy = 0; a.rotation = 0; a.scaleX = 1; a.scaleY = 1; }

    // Apply per-anchor transforms (scaled by intensity)
    for (const [id, t] of Object.entries(transforms)) {
      const scale = intensity;
      // _body is a built-in virtual anchor used by the breathe animation
      if (id === '_body') {
        for (const a of this._anchors) {
          a.dy += (t.translateY || 0) * scale;
          const s = 1 + ((t.scale ?? 1) - 1) * scale;
          a.scaleX *= s; a.scaleY *= s;
        }
        continue;
      }
      const a = this._anchors.find(x => x.id === id);
      if (!a) continue;
      a.rotation += (t.rotation   || 0) * scale;
      a.dx       += (t.translateX || 0) * scale;
      a.dy       += (t.translateY || 0) * scale;
      const s = 1 + ((t.scale ?? 1) - 1) * scale;
      a.scaleX   *= s; a.scaleY *= s;
    }

    if (this._anchors.length) this._mesh.deform(this._anchors);
    this._renderer.render(this._image, this._mesh, this._anchors, this._placement);
  }
}
