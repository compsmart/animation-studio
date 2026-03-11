/**
 * Post-generation video processing:
 * - Extract preview frame (first frame as PNG)
 * - Get video duration/dimensions metadata
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

/**
 * Extract a preview frame from the video and collect metadata.
 * @param {string} videoPath
 * @param {string} outputDir  - Where to save preview PNG
 * @returns {Promise<{previewPath: string, duration: number, width: number, height: number}>}
 */
export async function processActionVideo(videoPath, outputDir) {
  const previewFilename = `preview_${path.basename(videoPath, path.extname(videoPath))}.png`;
  const previewPath     = path.join(outputDir, previewFilename);

  // Extract frame at t=0.1s (avoid pure black first frame from some encoders)
  await extractFrame(videoPath, previewPath, 0.1);

  // Get video metadata
  const meta = await getVideoMeta(videoPath);

  return { previewPath, previewFilename, ...meta };
}

function extractFrame(videoPath, outputPath, time = 0.1) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(time)
      .frames(1)
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => {
        // Try at t=0 if seeking failed
        if (fs.existsSync(outputPath)) { resolve(); return; }
        ffmpeg(videoPath)
          .frames(1)
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      })
      .run();
  });
}

function getVideoMeta(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const vs = meta.streams.find(s => s.codec_type === 'video');
      resolve({
        duration: parseFloat(meta.format.duration) || 0,
        width:    vs?.width  || 0,
        height:   vs?.height || 0,
        fps:      evalFraction(vs?.r_frame_rate) || 24,
      });
    });
  });
}

function evalFraction(str) {
  if (!str) return null;
  const [a, b] = str.split('/').map(Number);
  return b ? a / b : a;
}
