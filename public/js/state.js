/**
 * Shared reactive state + event bus.
 * Import `state` to read data; call `setState` to update and dispatch events.
 */

export const state = {
  project:          null,   // full project JSON from API
  selectedCharId:   null,
  selectedActionId: null,
  playerState:      'idle', // 'idle' | 'playing' | 'transitioning'
  stageW:           1920,
  stageH:           1080,
  stageScale:       1,      // display canvas / logical canvas ratio
  jobs:             {},     // jobId -> { status, prompt, log, elapsed }
};

export const bus = new EventTarget();

/** Merge partial update into state and emit named events. */
export function setState(patch) {
  Object.assign(state, patch);
  bus.dispatchEvent(new CustomEvent('stateChange', { detail: patch }));
  for (const key of Object.keys(patch)) {
    bus.dispatchEvent(new CustomEvent(key, { detail: patch[key] }));
  }
}

export function on(event, fn) {
  bus.addEventListener(event, fn);
}
