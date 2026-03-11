/**
 * Chroma-key renderer — applies colour-distance keying to each video frame
 * drawn to a Canvas 2D context.
 */

let _work = null, _workCtx = null;

function getWork(w, h) {
  if (!_work || _work.width !== w || _work.height !== h) {
    _work    = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    _workCtx = _work.getContext('2d', { willReadFrequently: true });
  }
  return { canvas: _work, ctx: _workCtx };
}

function hexToRgb(hex) {
  const m = (hex || '#000').replace('#', '').match(/.{2}/g);
  return m ? [parseInt(m[0], 16), parseInt(m[1], 16), parseInt(m[2], 16)] : [0, 0, 0];
}

/**
 * Draw `source` (video element or canvas) onto `displayCanvas` with chroma
 * keying applied.
 *
 * @param {HTMLCanvasElement} displayCanvas
 * @param {HTMLVideoElement|HTMLCanvasElement} source
 * @param {{ enabled, color, tolerance, softness }} settings
 */
export function applyChromaKey(displayCanvas, source, settings) {
  const w = displayCanvas.width;
  const h = displayCanvas.height;
  const displayCtx = displayCanvas.getContext('2d');

  if (!settings?.enabled) {
    displayCtx.clearRect(0, 0, w, h);
    displayCtx.drawImage(source, 0, 0, w, h);
    return;
  }

  const { canvas: work, ctx: wCtx } = getWork(w, h);
  const [tr, tg, tb] = hexToRgb(settings.color);
  const tol     = settings.tolerance ?? 80;
  const soft    = Math.max(1, settings.softness ?? 30);
  const softEnd = tol + soft;

  wCtx.clearRect(0, 0, w, h);
  wCtx.drawImage(source, 0, 0, w, h);

  const img  = wCtx.getImageData(0, 0, w, h);
  const data = img.data;

  for (let i = 0; i < data.length; i += 4) {
    const dr   = data[i]     - tr;
    const dg   = data[i + 1] - tg;
    const db   = data[i + 2] - tb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist <= tol) {
      data[i + 3] = 0;
    } else if (dist < softEnd) {
      data[i + 3] = Math.round(255 * (dist - tol) / soft);
    }
  }

  displayCtx.clearRect(0, 0, w, h);
  displayCtx.putImageData(img, 0, 0);
}

/** Sample the colour at a canvas pixel position (used for eyedropper). */
export function sampleColor(canvas, normX, normY) {
  const ctx  = canvas.getContext('2d');
  const px   = Math.round(normX * canvas.width);
  const py   = Math.round(normY * canvas.height);
  const data = ctx.getImageData(px, py, 1, 1).data;
  return `#${[...data.slice(0, 3)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
