/**
 * Export a project as a complete HTML5-game-ready package.
 *
 * Output structure:
 *   manifest.json
 *   characters/{id}/reference.png
 *   characters/{id}/spine-project.json
 *   characters/{id}/actions/{id}/video.mp4
 *   characters/{id}/actions/{id}/preview.png
 *   characters/{id}/actions/{id}/clip.json
 *   runtime/loader.js
 *   runtime/example.html
 *   runtime/README.md
 */

import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { trimVideo, trimAudio } from './trim-video.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} project   - Full project JSON
 * @param {string} uploadsDir - Root directory where project uploads live
 * @param {WritableStream} outputStream - ZIP written here
 */
export function exportProject(project, uploadsDir, outputStream) {
  const tempDir = path.join(os.tmpdir(), `vas-export-${Date.now()}`);
  const tempFiles = [];
  fs.mkdirSync(tempDir, { recursive: true });

  const cleanup = () => {
    try { fs.rmSync(tempDir, { recursive: true }); } catch {}
  };

  return (async () => {
    const videoPaths = {}; // actionId -> { path }
    const audioPaths = {}; // actionId -> { path }

    for (const char of project.characters || []) {
      for (const action of char.actions || []) {
        if (action.status !== 'ready') continue;
        const vidPath = path.join(uploadsDir, action.videoFilename || '');
        if (!action.videoFilename || !fs.existsSync(vidPath)) continue;

        const dur = action.duration || 0;
        const trimStart = action.trimStart ?? 0;
        const trimEnd = action.trimEnd != null && action.trimEnd > 0 ? action.trimEnd : dur;
        const needsTrim = trimStart > 0.01 || (trimEnd < dur - 0.01 && trimEnd > trimStart);

        if (needsTrim) {
          const tempPath = path.join(tempDir, `${action.id}.mp4`);
          await trimVideo(vidPath, tempPath, { start: trimStart, end: trimEnd });
          videoPaths[action.id] = { path: tempPath };
        } else {
          videoPaths[action.id] = { path: vidPath };
        }

        if (action.audioFilename) {
          const audPath = path.join(uploadsDir, action.audioFilename);
          if (fs.existsSync(audPath)) {
            if (needsTrim) {
              const tempAudPath = path.join(tempDir, `${action.id}.mp3`);
              await trimAudio(audPath, tempAudPath, { start: trimStart, end: trimEnd });
              audioPaths[action.id] = { path: tempAudPath };
            } else {
              audioPaths[action.id] = { path: audPath };
            }
          }
        }
      }
    }

    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.pipe(outputStream);
      archive.on('error', (err) => { cleanup(); reject(err); });
      outputStream.on('finish', () => { cleanup(); resolve(); });

      const manifest = buildManifest(project);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

      if (project.backgroundImage?.filename) {
        const bgPath = path.join(uploadsDir, project.backgroundImage.filename);
        if (fs.existsSync(bgPath)) {
          archive.file(bgPath, { name: 'stage/background.png' });
        }
      }

      for (const char of project.characters || []) {
        const charDir = `characters/${char.id}`;
        const refPath = path.join(uploadsDir, char.referenceImageFilename || '');
        if (char.referenceImageFilename && fs.existsSync(refPath)) {
          archive.file(refPath, { name: `${charDir}/reference.png` });
        }
        if (char.spineProject) {
          archive.append(JSON.stringify(char.spineProject, null, 2), {
            name: `${charDir}/spine-project.json`,
          });
        }
        for (const action of char.actions || []) {
          if (action.status !== 'ready') continue;
          const actionDir = `${charDir}/actions/${action.id}`;
          const vp = videoPaths[action.id];
          if (vp) archive.file(vp.path, { name: `${actionDir}/video.mp4` });
          const ap = audioPaths[action.id];
          if (ap) archive.file(ap.path, { name: `${actionDir}/audio.mp3` });
          const prevPath = path.join(uploadsDir, action.previewFilename || '');
          if (action.previewFilename && fs.existsSync(prevPath)) {
            archive.file(prevPath, { name: `${actionDir}/preview.png` });
          }
          archive.append(JSON.stringify(buildClipJson(action), null, 2), { name: `${actionDir}/clip.json` });
        }
      }

      archive.append(runtimeLoaderSrc(), { name: 'runtime/loader.js' });
      archive.append(runtimeExampleSrc(manifest), { name: 'runtime/example.html' });
      archive.append(runtimeReadmeSrc(), { name: 'runtime/README.md' });
      archive.finalize();
    })();
  })();
}

// ── Manifest builder ────────────────────────────────────────────────────────

function buildManifest(project) {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    projectName: project.name || 'Untitled',
    stage: {
      width:      project.stageWidth  || 1920,
      height:     project.stageHeight || 1080,
      background: project.background  || '#000000',
      ...(project.backgroundImage && {
        backgroundImage: 'stage/background.png',
        backgroundImagePlacement: project.backgroundImage.placement || { x: 0.5, y: 0.5, scale: 1 },
      }),
    },
    characters: (project.characters || []).map(char => ({
      id:    char.id,
      name:  char.name || char.id,
      reference: `characters/${char.id}/reference.png`,
      spineProject: char.spineProject ? `characters/${char.id}/spine-project.json` : null,
      placement: {
        x:        char.placement?.x     ?? 0.5,
        y:        char.placement?.y     ?? 0.85,
        scale:    char.placement?.scale ?? 0.6,
        rotation: char.placement?.rotation ?? 0,
      },
      actions: (char.actions || [])
        .filter(a => a.status === 'ready')
        .map(a => buildActionManifest(char.id, a)),
    })),
  };
}

function buildActionManifest(charId, action) {
  return {
    id:      action.id,
    name:    action.name || action.id,
    prompt:  action.prompt || '',
    video:   `characters/${charId}/actions/${action.id}/video.mp4`,
    preview: `characters/${charId}/actions/${action.id}/preview.png`,
    ...(action.audioFilename && { audio: `characters/${charId}/actions/${action.id}/audio.mp3` }),
    chromaKey: {
      enabled:   action.chromaKey?.enabled   ?? true,
      color:     action.chromaKey?.color     ?? '#4488cc',
      tolerance: action.chromaKey?.tolerance ?? 80,
      softness:  action.chromaKey?.softness  ?? 30,
    },
    completion: {
      mode:       action.completion?.mode       ?? 'transition',
      transition: action.completion?.transition ?? 'fade',
      duration:   action.completion?.duration   ?? 800,
      easing:     action.completion?.easing     ?? 'ease-in-out',
    },
    duration: action.duration || 0,
  };
}

function buildClipJson(action) {
  const dur = action.duration || 0;
  const trimStart = action.trimStart ?? 0;
  const trimEnd = action.trimEnd != null && action.trimEnd > 0 ? action.trimEnd : dur;
  const trimmedDur = Math.max(0, trimEnd - trimStart);
  return {
    id:        action.id,
    name:      action.name || action.id,
    prompt:    action.prompt || '',
    videoFile: 'video.mp4',
    previewFile: 'preview.png',
    ...(action.audioFilename && { audioFile: 'audio.mp3' }),
    chromaKey: action.chromaKey || {},
    completion: action.completion || {},
    duration:  trimmedDur || dur,
    generatedAt: action.generatedAt || null,
  };
}

// ── Runtime source text ─────────────────────────────────────────────────────

function runtimeLoaderSrc() {
  const loaderPath = path.join(__dirname, '..', 'public', 'runtime-loader.js');
  if (fs.existsSync(loaderPath)) return fs.readFileSync(loaderPath, 'utf8');
  return '/* runtime-loader.js not found */';
}

function runtimeReadmeSrc() {
  return `# Video Action Studio – Runtime Package

## Quick start

1. Copy this folder into your game's asset directory.
2. Include \`runtime/loader.js\` in your HTML page.
3. Use the \`loadAnimationPackage\` API:

\`\`\`js
import { loadAnimationPackage } from './runtime/loader.js';

const pkg  = await loadAnimationPackage('./my-character/');
const actor = pkg.createActor('spiderman', document.getElementById('canvas'));
actor.playIdle();

document.getElementById('btn-web').addEventListener('click', () => {
  actor.playAction('shoot_web');
});
\`\`\`

## manifest.json

The manifest describes the stage, characters, and all action clips with their
background-removal settings and return-transition configuration.

## Chroma key

Each clip stores \`chromaKey\` settings (color, tolerance, softness) that the
runtime applies in a Canvas 2D or WebGL pass to remove the background colour.

## Return transitions

When an action clip ends, the runtime performs the configured transition
(fade, slide-left, slide-right, slide-top, slide-bottom) before resuming
the idle Spine animation.
`;
}

function runtimeExampleSrc(manifest) {
  const charId = manifest.characters?.[0]?.id || 'character';
  const actionId = manifest.characters?.[0]?.actions?.[0]?.id || 'action';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${manifest.projectName || 'Animation'} – Example</title>
  <style>
    body { margin: 0; background: #111; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; }
    canvas { max-width: 100%; max-height: 80vh; }
    .btns { display: flex; gap: 0.5rem; margin-top: 1rem; }
    button { padding: 0.5rem 1.25rem; background: #6366f1; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    button:hover { background: #4f46e5; }
  </style>
</head>
<body>
  <canvas id="stage"></canvas>
  <div class="btns">
    <button id="btn-idle">Idle</button>
    <button id="btn-action">Play: ${actionId}</button>
  </div>
  <script type="module">
    import { loadAnimationPackage } from './loader.js';
    const pkg   = await loadAnimationPackage('../');
    const actor = pkg.createActor('${charId}', document.getElementById('stage'));
    actor.playIdle();
    document.getElementById('btn-idle').addEventListener('click', () => actor.playIdle());
    document.getElementById('btn-action').addEventListener('click', () => actor.playAction('${actionId}'));
  </script>
</body>
</html>
`;
}
