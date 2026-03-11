/**
 * Crop a video using ffmpeg.
 * @param {string} videoPath - Input video path
 * @param {string} outputPath - Output video path
 * @param {{ x: number, y: number, width: number, height: number }} crop - Crop region in pixels
 * @returns {Promise<void>}
 */
import ffmpeg from 'fluent-ffmpeg';

export function cropVideo(videoPath, outputPath, crop) {
  const { x, y, width, height } = crop;
  const vf = `crop=${width}:${height}:${x}:${y}`;

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .videoFilters(vf)
      .outputOptions('-c:a copy')
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}
