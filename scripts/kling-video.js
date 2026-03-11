/**
 * Kling 3.0 Video Generation API adapter
 * Uses: POST /api/v1/jobs/createTask  + GET /api/v1/jobs/recordInfo
 */

const KIE_BASE = 'https://api.kie.ai/api/v1';
const KIE_FILE_BASE = 'https://kieai.redpandaai.co'; // File upload API (api.kie.ai returns 404)
const POLL_INTERVAL_MS = 8000;
const MAX_POLLS = 90; // ~12 minutes

/**
 * Upload a reference image to Kie's CDN via Base64. Returns a short, stable URL
 * that Kling can use (avoids ngrok URL length/truncation issues).
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {Buffer} opts.imageBuffer - PNG/JPEG buffer
 * @param {string} [opts.fileName] - e.g. 'ref_xxx.png'
 * @returns {Promise<string>} downloadUrl
 */
export async function uploadRefImageToKie(opts) {
  const { apiKey, imageBuffer, fileName = 'ref.png' } = opts;
  const base64Data = `data:image/png;base64,${imageBuffer.toString('base64')}`;

  const res = await fetch(`${KIE_FILE_BASE}/api/file-base64-upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      base64Data,
      uploadPath: 'kling-refs',
      fileName,
    }),
  });

  const data = await res.json();
  if (!data.success || !data.data?.downloadUrl) {
    throw new Error(`Kie file upload failed: ${data.msg || JSON.stringify(data)}`);
  }
  console.log('[Kie] Ref image uploaded:', data.data.downloadUrl?.slice(0, 60));
  return data.data.downloadUrl;
}

/**
 * Create a Kling video generation job.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.prompt
 * @param {string} [opts.imageUrl]   - Public URL of the reference/first-frame image
 * @param {string} [opts.mode]       - 'std' | 'pro' (default: 'std')
 * @param {string} [opts.aspectRatio] - '16:9' | '9:16' | '1:1' (default: '16:9')
 * @param {number} [opts.duration]   - seconds (default: 3)
 * @returns {Promise<string>} taskId
 */
export async function createKlingJob(opts) {
  const {
    apiKey,
    prompt,
    imageUrl,
    mode = 'std',
    aspectRatio = '16:9',
    duration = 3,
  } = opts;

  const input = {
    mode,
    prompt,
    aspectRatio,
    duration: String(duration),
    multi_shots: false, // Single-shot mode (required by API)
    sound: false,       // Disable sound effects (required by API)
  };
  if (imageUrl) {
    input.image_urls = [imageUrl];
  }

  console.log('[Kling] Creating job:', { prompt: prompt.slice(0, 60), mode, imageUrl: imageUrl?.slice(0, 60) });

  const res = await fetch(`${KIE_BASE}/jobs/createTask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'kling-3.0/video', input }),
  });

  const data = await res.json();
  if (data.code !== 200) {
    throw new Error(`Kling API error: ${data.msg || JSON.stringify(data)}`);
  }
  console.log('[Kling] Job started:', data.data.taskId);
  return data.data.taskId;
}

/**
 * Poll a Kling job until it completes or fails.
 * @param {string} taskId
 * @param {string} apiKey
 * @param {function} [onProgress]  - called with (elapsedSec, attempt)
 * @returns {Promise<string>} videoUrl
 */
export async function pollKlingJob(taskId, apiKey, onProgress) {
  let attempt = 0;
  while (attempt < MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    attempt++;
    const elapsed = Math.round(attempt * POLL_INTERVAL_MS / 1000);
    if (onProgress) onProgress(elapsed, attempt);

    const res = await fetch(`${KIE_BASE}/jobs/recordInfo?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json();

    if (data.code !== 200) {
      // transient error — keep polling
      console.warn(`[Kling] Poll warning (${elapsed}s):`, data.msg);
      continue;
    }

    const { state, resultJson, failCode, failMsg } = data.data;
    console.log(`[Kling] Status (${elapsed}s): ${state}`);

    if (state === 'success') {
      const result = JSON.parse(resultJson || '{}');
      const videoUrl = Array.isArray(result.resultUrls) ? result.resultUrls[0] : result.resultUrl;
      if (!videoUrl) throw new Error('No video URL in result');
      return videoUrl;
    }
    if (state === 'fail') {
      throw new Error(`Kling generation failed (${failCode}): ${failMsg}`);
    }
    // 'waiting' or anything else → keep polling
  }
  throw new Error('Kling job timed out after polling');
}

/**
 * Download a video from a URL to a local file path.
 * @param {string} videoUrl
 * @param {string} destPath
 */
export async function downloadVideo(videoUrl, destPath) {
  const { createWriteStream } = await import('fs');
  const { pipeline } = await import('stream/promises');
  console.log('[Kling] Downloading video:', videoUrl.slice(0, 80));
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const ws = createWriteStream(destPath);
  await pipeline(res.body, ws);
  console.log('[Kling] Saved to:', destPath);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
