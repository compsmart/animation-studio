/**
 * Trim a video by start and end time.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{ start: number, end: number }} opts - Times in seconds
 * @returns {Promise<void>}
 */
import ffmpeg from 'fluent-ffmpeg';

export function trimVideo(inputPath, outputPath, opts) {
  const { start = 0, end } = opts;
  if (end == null || end <= start) return Promise.reject(new Error('Invalid trim range'));

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(end - start)
      .outputOptions('-c copy')
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/**
 * Trim an audio file by start and end time.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{ start: number, end: number }} opts - Times in seconds
 * @returns {Promise<void>}
 */
export function trimAudio(inputPath, outputPath, opts) {
  const { start = 0, end } = opts;
  if (end == null || end <= start) return Promise.reject(new Error('Invalid trim range'));

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(end - start)
      .outputOptions('-acodec', 'libmp3lame', '-q:a', '4')
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}
