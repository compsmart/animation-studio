/**
 * Compose a full-stage reference image for Kling video generation.
 *
 * Places a character image onto a stage background at a configured
 * position/scale, producing a PNG that serves as the "first frame"
 * reference for the AI to generate actions from.
 */

import sharp from 'sharp';

/**
 * @param {object} opts
 * @param {string} opts.characterImagePath   - Path to character PNG (can have transparency)
 * @param {number} opts.stageWidth           - Stage width in px (e.g. 1920)
 * @param {number} opts.stageHeight          - Stage height in px (e.g. 1080)
 * @param {number} opts.normX                - Normalized center-X of character (0-1)
 * @param {number} opts.normY                - Normalized bottom-Y of character (0-1)
 * @param {number} opts.scale                - Scale relative to stage height (1.0 = fills stage height)
 * @param {string} opts.background           - Hex background colour (default #4488cc for chroma)
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function composeReferenceImage(opts) {
  const {
    characterImagePath,
    stageWidth  = 1920,
    stageHeight = 1080,
    normX = 0.5,
    normY = 0.85,
    scale = 0.6,
    background = '#4488cc',
  } = opts;

  // Resolve background colour
  const bg = hexToRgb(background) || { r: 68, g: 136, b: 204 };

  // Load character and get its natural dimensions
  const charSharp = sharp(characterImagePath);
  const meta = await charSharp.metadata();

  // Target height is stage_height * scale
  const targetH = Math.round(stageHeight * scale);
  const aspectRatio = meta.width / meta.height;
  const targetW = Math.round(targetH * aspectRatio);

  // Resize character, preserving transparency
  const charBuffer = await charSharp
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Position: normX/normY describe the bottom-centre of the character
  const left = Math.round(normX * stageWidth - targetW / 2);
  const top  = Math.round(normY * stageHeight - targetH);

  // Clamp to stage bounds
  const clampedLeft = Math.max(0, Math.min(stageWidth  - targetW, left));
  const clampedTop  = Math.max(0, Math.min(stageHeight - targetH, top));

  const composited = await sharp({
    create: {
      width:    stageWidth,
      height:   stageHeight,
      channels: 3,
      background: bg,
    },
  })
    .composite([{ input: charBuffer, left: clampedLeft, top: clampedTop }])
    .png()
    .toBuffer();

  return composited;
}

function hexToRgb(hex) {
  const m = hex?.replace('#', '').match(/.{2}/g);
  if (!m || m.length < 3) return null;
  return { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) };
}
