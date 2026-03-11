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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} project   - Full project JSON
 * @param {string} uploadsDir - Root directory where project uploads live
 * @param {WritableStream} outputStream - ZIP written here
 */
export function exportProject(project, uploadsDir, outputStream) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(outputStream);
    archive.on('error', reject);
    outputStream.on('finish', resolve);

    // manifest.json
    const manifest = buildManifest(project);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // Per-character files
    for (const char of project.characters || []) {
      const charDir = `characters/${char.id}`;

      // Reference image
      const refPath = path.join(uploadsDir, char.referenceImageFilename || '');
      if (char.referenceImageFilename && fs.existsSync(refPath)) {
        archive.file(refPath, { name: `${charDir}/reference.png` });
      }

      // Spine project data
      if (char.spineProject) {
        archive.append(JSON.stringify(char.spineProject, null, 2), {
          name: `${charDir}/spine-project.json`,
        });
      }

      // Actions
      for (const action of char.actions || []) {
        if (action.status !== 'ready') continue;
        const actionDir = `${charDir}/actions/${action.id}`;

        // Video
        const vidPath = path.join(uploadsDir, action.videoFilename || '');
        if (action.videoFilename && fs.existsSync(vidPath)) {
          archive.file(vidPath, { name: `${actionDir}/video.mp4` });
        }

        // Preview
        const prevPath = path.join(uploadsDir, action.previewFilename || '');
        if (action.previewFilename && fs.existsSync(prevPath)) {
          archive.file(prevPath, { name: `${actionDir}/preview.png` });
        }

        // Clip metadata
        const clip = buildClipJson(action);
        archive.append(JSON.stringify(clip, null, 2), { name: `${actionDir}/clip.json` });
      }
    }

    // Runtime files
    archive.append(runtimeLoaderSrc(), { name: 'runtime/loader.js' });
    archive.append(runtimeExampleSrc(manifest), { name: 'runtime/example.html' });
    archive.append(runtimeReadmeSrc(), { name: 'runtime/README.md' });

    archive.finalize();
  });
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
  return {
    id:        action.id,
    name:      action.name || action.id,
    prompt:    action.prompt || '',
    videoFile: 'video.mp4',
    previewFile: 'preview.png',
    chromaKey: action.chromaKey || {},
    completion: action.completion || {},
    duration:  action.duration || 0,
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
