/**
 * TransitionManager — handles animated return from action clip back to idle.
 *
 * Supported types: 'seamless' | 'fade' | 'slide-left' | 'slide-right' | 'slide-top' | 'slide-bottom'
 */

export class TransitionManager {
  /**
   * Execute a return transition.
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.actionCanvas
   * @param {HTMLCanvasElement} opts.spineCanvas
   * @param {string}  opts.type       - transition type
   * @param {number}  opts.duration   - ms
   * @param {string}  opts.easing     - 'ease-in-out' | 'ease-in' | 'ease-out' | 'linear'
   * @returns {Promise<void>} resolves when transition is complete
   */
  execute(opts) {
    const { actionCanvas, spineCanvas, type = 'fade', duration = 800, easing = 'ease-in-out' } = opts;

    if (type === 'seamless') {
      actionCanvas.style.opacity = '0';
      spineCanvas.style.opacity  = '1';
      spineCanvas.style.transform = '';
      return Promise.resolve();
    }

    if (type === 'fade') return this._fade(actionCanvas, spineCanvas, duration, easing);

    const dir = type.replace('slide-', '');
    return this._slide(actionCanvas, spineCanvas, dir, duration, easing);
  }

  _fade(actionCanvas, spineCanvas, duration, easing) {
    spineCanvas.style.transition  = '';
    spineCanvas.style.opacity     = '1';
    spineCanvas.style.transform   = '';

    actionCanvas.style.transition = `opacity ${duration}ms ${easing}`;
    actionCanvas.style.opacity    = '0';

    return new Promise(resolve => {
      actionCanvas.addEventListener('transitionend', () => resolve(), { once: true });
      setTimeout(resolve, duration + 100); // fallback
    });
  }

  _slide(actionCanvas, spineCanvas, dir, duration, easing) {
    // Determine entry offset for spine canvas
    const stage  = document.getElementById('stage');
    const sw     = stage.offsetWidth;
    const sh     = stage.offsetHeight;
    const offsets = {
      left:   [-sw,  0],
      right:  [ sw,  0],
      top:    [  0, -sh],
      bottom: [  0,  sh],
    };
    const [ox, oy] = offsets[dir] || offsets.right;

    // Start spine canvas off-screen
    spineCanvas.style.transition = '';
    spineCanvas.style.transform  = `translate(${ox}px, ${oy}px)`;
    spineCanvas.style.opacity    = '1';

    // Force reflow
    void spineCanvas.offsetWidth;

    // Slide spine into position, fade action out simultaneously
    spineCanvas.style.transition  = `transform ${duration}ms ${easing}`;
    actionCanvas.style.transition = `opacity ${duration}ms ${easing}`;

    requestAnimationFrame(() => {
      spineCanvas.style.transform = 'translate(0, 0)';
      actionCanvas.style.opacity  = '0';
    });

    return new Promise(resolve => {
      spineCanvas.addEventListener('transitionend', () => {
        spineCanvas.style.transition = '';
        actionCanvas.style.transition = '';
        resolve();
      }, { once: true });
      setTimeout(resolve, duration + 150);
    });
  }
}
