/**
 * Veo 3.1 Video Generation API adapter
 * Uses: POST /api/v1/veo/generate + GET /api/v1/veo/record-info
 * @see https://docs.kie.ai/veo3-api/generate-veo-3-video
 */

import { uploadRefImageToKie } from './kling-video.js';

const KIE_BASE = 'https://api.kie.ai/api/v1';
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120; // ~10 minutes
const FETCH_TIMEOUT_MS = 30000; // 30s per request (API can be slow)
const MAX_FETCH_RETRIES = 5;   // retry transient network errors

export { uploadRefImageToKie };

/**
 * Create a Veo 3.1 video generation job (image-to-video).
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.prompt
 * @param {string} [opts.imageUrl] - Public URL of the reference image
 * @param {string[]} [opts.imageUrls] - Explicit first/last frame URLs
 * @param {string} [opts.generationType] - 'FIRST_AND_LAST_FRAMES_2_VIDEO' by default
 * @param {string} [opts.model] - 'veo3' | 'veo3_fast' (default: 'veo3_fast')
 * @param {string} [opts.aspectRatio] - '16:9' | '9:16' | 'Auto' (default: '16:9')
 * @param {number} [opts.duration] - seconds: 4, 6, or 8 (default: 8)
 * @param {boolean} [opts.sound] - include audio (default: true). When false, generateAudio is set false.
 * @returns {Promise<string>} taskId
 */
export async function createVeoJob(opts) {
  const {
    apiKey,
    prompt,
    imageUrl,
    imageUrls,
    generationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO',
    model = 'veo3_fast',
    aspectRatio = '16:9',
    duration = 8,
    sound = true,
  } = opts;
  const resolvedImageUrls = Array.isArray(imageUrls) && imageUrls.length
    ? imageUrls
    : (imageUrl ? [imageUrl, imageUrl] : []);

  if (!resolvedImageUrls.length) {
    throw new Error('createVeoJob requires imageUrl or imageUrls');
  }

  const body = {
    prompt,
    imageUrls: resolvedImageUrls,
    model,
    generationType,
    aspect_ratio: aspectRatio,
    enableTranslation: true,
  };
  if ([4, 6, 8].includes(duration)) body.duration = duration;
  if (sound === false) body.generateAudio = false;

  console.log('[Veo] Creating job:', {
    prompt: prompt.slice(0, 60),
    generationType,
    model,
    duration: body.duration || 8,
    imageUrls: body.imageUrls.length,
    url: body.imageUrls[0]?.slice(0, 50),
  });

  const res = await fetch(`${KIE_BASE}/veo/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.code !== 200) {
    throw new Error(`Veo API error: ${data.msg || JSON.stringify(data)}`);
  }
  if (!data.data?.taskId) {
    throw new Error(`Veo API: no taskId in response`);
  }
  console.log('[Veo] Job started:', data.data.taskId);
  return data.data.taskId;
}

/**
 * Poll a Veo job until it completes or fails.
 * @param {string} taskId
 * @param {string} apiKey
 * @param {function} [onProgress] - called with (elapsedSec, attempt)
 * @returns {Promise<string>} videoUrl
 */
export async function pollVeoJob(taskId, apiKey, onProgress) {
  let attempt = 0;
  let fetchFailures = 0;
  while (attempt < MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    attempt++;
    const elapsed = Math.round(attempt * POLL_INTERVAL_MS / 1000);
    if (onProgress) onProgress(elapsed, attempt);

    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      res = await fetch(`${KIE_BASE}/veo/record-info?taskId=${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
    } catch (err) {
      fetchFailures++;
      const msg = err.cause?.code || err.code || err.name || err.message;
      console.warn(`[Veo] Poll fetch failed (${elapsed}s, attempt ${fetchFailures}/${MAX_FETCH_RETRIES}): ${msg}`);
      if (fetchFailures >= MAX_FETCH_RETRIES) {
        throw new Error(`Veo poll failed after ${MAX_FETCH_RETRIES} network errors: ${msg}`);
      }
      continue;
    }
    fetchFailures = 0; // reset on success

    const data = await res.json();

    if (data.code !== 200) {
      console.warn(`[Veo] Poll warning (${elapsed}s):`, data.msg);
      continue;
    }

    const d = data.data || {};
    const successFlag = d.successFlag;
    const response = d.response || {};
    const resultUrls = response.resultUrls;

    if (successFlag === 1) {
      let urls = resultUrls;
      if (typeof urls === 'string') {
        try { urls = JSON.parse(urls); } catch { urls = [urls]; }
      }
      const videoUrl = Array.isArray(urls) ? urls[0] : urls;
      if (!videoUrl) throw new Error('No video URL in Veo result');
      const resLabel = response.resolution || '?';
      console.log('[Veo] Status (', elapsed, 's): success, resolution:', resLabel);
      return videoUrl;
    }
    if (successFlag === 2 || successFlag === 3) {
      const errMsg = d.errorMessage || response.errorMessage || `Generation failed (${d.errorCode || ''})`;
      throw new Error(`Veo generation failed: ${errMsg}`);
    }
    console.log('[Veo] Status (', elapsed, 's): generating');
  }
  throw new Error('Veo job timed out after polling');
}

/**
 * Download a video from a URL to a local file path.
 */
export async function downloadVideo(videoUrl, destPath) {
  const { createWriteStream } = await import('fs');
  const { pipeline } = await import('stream/promises');
  console.log('[Veo] Downloading video:', videoUrl.slice(0, 80));
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const ws = createWriteStream(destPath);
  await pipeline(res.body, ws);
  console.log('[Veo] Saved to:', destPath);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
