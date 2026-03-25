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
 * @param {number} opts.stageWidth           - Stage width in px (e.g. 1280)
 * @param {number} opts.stageHeight          - Stage height in px (e.g. 720)
 * @param {number} opts.normX                - Normalized center-X of character (0-1)
 * @param {number} opts.normY                - Normalized bottom-Y of character (0-1)
 * @param {number} opts.scale                - Scale relative to stage height (1.0 = fills stage height)
 * @param {string} opts.background           - Hex background colour (default #4488cc for chroma)
 * @param {string} [opts.backgroundImagePath] - Path to background image (optional)
 * @param {{ x: number, y: number, scale: number }} [opts.backgroundImagePlacement] - Center-x, center-y, scale (optional)
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function composeReferenceImage(opts) {
  const {
    characterImagePath,
    stageWidth  = 1280,
    stageHeight = 720,
    normX = 0.5,
    normY = 0.85,
    scale = 0.6,
    background = '#4488cc',
    backgroundImagePath,
    backgroundImagePlacement,
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

  // Position: normX/normY describe the bottom-centre of the character.
  // Match the UI preview exactly: allow the image to extend past the stage
  // bounds and crop only the portion that falls outside the frame.
  const left = Math.round(normX * stageWidth - targetW / 2);
  const top  = Math.round(normY * stageHeight - targetH);

  const visibleLeft = Math.max(0, left);
  const visibleTop = Math.max(0, top);
  const cropLeft = Math.max(0, -left);
  const cropTop = Math.max(0, -top);
  const visibleWidth = Math.min(targetW - cropLeft, stageWidth - visibleLeft);
  const visibleHeight = Math.min(targetH - cropTop, stageHeight - visibleTop);

  const composites = [];
  if (backgroundImagePath) {
    const bgPlace = backgroundImagePlacement || { x: 0.5, y: 0.5, scale: 1 };
    const bgMeta = await sharp(backgroundImagePath).metadata();
    const bgTargetH = Math.round(stageHeight * (bgPlace.scale ?? 1));
    const bgAspect = bgMeta.width / bgMeta.height;
    const bgTargetW = Math.round(bgTargetH * bgAspect);
    const bgBuffer = await sharp(backgroundImagePath)
      .resize(bgTargetW, bgTargetH, { fit: 'cover' })
      .png()
      .toBuffer();
    const bgLeft = Math.round((bgPlace.x ?? 0.5) * stageWidth - bgTargetW / 2);
    const bgTop  = Math.round((bgPlace.y ?? 0.5) * stageHeight - bgTargetH / 2);
    composites.push({ input: bgBuffer, left: bgLeft, top: bgTop });
  }
  if (visibleWidth > 0 && visibleHeight > 0) {
    const visibleCharBuffer = await sharp(charBuffer)
      .extract({
        left: cropLeft,
        top: cropTop,
        width: visibleWidth,
        height: visibleHeight,
      })
      .png()
      .toBuffer();
    composites.push({ input: visibleCharBuffer, left: visibleLeft, top: visibleTop });
  }

  const composited = await sharp({
    create: {
      width:    stageWidth,
      height:   stageHeight,
      channels: 3,
      background: bg,
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  return composited;
}

function hexToRgb(hex) {
  const m = hex?.replace('#', '').match(/.{2}/g);
  if (!m || m.length < 3) return null;
  return { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) };
}
