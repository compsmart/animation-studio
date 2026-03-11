/**
 * Video Action Studio – Express server
 *
 * Manages projects, reference images, Veo 3.1 video generation jobs,
 * and exports the complete game asset package.
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';

import { createVeoJob, pollVeoJob, downloadVideo, uploadRefImageToKie } from './scripts/veo-video.js';
import { composeReferenceImage } from './scripts/compose-reference.js';
import { processActionVideo, hasAudioStream, extractAudio, stripAudio } from './scripts/process-action-video.js';
import { exportProject } from './scripts/export-package.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = parseInt(process.env.PORT || '3001');
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const KIE_KEY    = process.env.KIE_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const DATA_DIR     = path.join(__dirname, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const UPLOADS_DIR  = path.join(DATA_DIR, 'uploads');

for (const d of [DATA_DIR, PROJECTS_DIR, UPLOADS_DIR])
  fs.mkdirSync(d, { recursive: true });

// ── In-memory job state ──────────────────────────────────────────────────────
const jobs = {};   // jobId -> { status, taskId, projectId, charId, actionId, log[] }

// ── Express setup ────────────────────────────────────────────────────────────
const app  = express();
app.use(express.json());
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Project helpers ──────────────────────────────────────────────────────────

function projectPath(id) { return path.join(PROJECTS_DIR, `${id}.json`); }

function loadProject(id) {
  const p = projectPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveProject(project) {
  fs.writeFileSync(projectPath(project.id), JSON.stringify(project, null, 2));
}

function newProject(name = 'Untitled', stageSize = '1080p') {
  const [w, h] = stageSize === '720p' ? [1280, 720] : [1920, 1080];
  const project = {
    id: uuid(),
    name,
    stageWidth: w,
    stageHeight: h,
    background: '#4488cc',
    characters: [],
    createdAt: Date.now(),
  };
  saveProject(project);
  return project;
}

function uploadsDir(projectId) {
  const d = path.join(UPLOADS_DIR, projectId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── Routes: projects ─────────────────────────────────────────────────────────

app.get('/api/projects', (_req, res) => {
  const list = fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
        return { id: p.id, name: p.name, stageWidth: p.stageWidth, stageHeight: p.stageHeight, createdAt: p.createdAt };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.post('/api/projects', (req, res) => {
  const { name, stageSize } = req.body;
  res.json(newProject(name, stageSize));
});

app.get('/api/projects/:id', (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.put('/api/projects/:id', (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const updated = { ...p, ...req.body, id: p.id };
  saveProject(updated);
  res.json(updated);
});

app.delete('/api/projects/:id', (req, res) => {
  const p = projectPath(req.params.id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

app.post('/api/projects/:id/background-image', upload.single('image'), (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No image provided' });

  const dir = uploadsDir(project.id);
  const filename = `bg_${uuid()}${path.extname(req.file.originalname) || '.png'}`;
  const destPath = path.join(dir, filename);
  fs.renameSync(req.file.path, destPath);

  project.backgroundImage = {
    filename: `${project.id}/${filename}`,
    url: `/uploads/${project.id}/${filename}`,
    placement: { x: 0.5, y: 0.5, scale: 1 },
  };
  saveProject(project);
  res.json(project);
});

app.delete('/api/projects/:id/background-image', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (project.backgroundImage?.filename) {
    const fpath = path.join(UPLOADS_DIR, project.backgroundImage.filename);
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
  }
  project.backgroundImage = null;
  saveProject(project);
  res.json(project);
});

// ── Routes: characters ───────────────────────────────────────────────────────

app.post('/api/projects/:id/characters', upload.single('image'), async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (!req.file) return res.status(400).json({ error: 'No image provided' });

  const charId   = uuid();
  const dir      = uploadsDir(project.id);
  const filename = `char_${charId}${path.extname(req.file.originalname) || '.png'}`;
  const destPath = path.join(dir, filename);

  fs.renameSync(req.file.path, destPath);

  const character = {
    id: charId,
    name: req.body.name || 'Character',
    referenceImageFilename: `${project.id}/${filename}`,
    referenceImageUrl: `/uploads/${project.id}/${filename}`,
    placement: { x: 0.5, y: 0.85, scale: 0.6, rotation: 0 },
    spineProject: null,
    actions: [],
  };

  project.characters.push(character);
  saveProject(project);
  res.json(character);
});

app.put('/api/projects/:id/characters/:charId', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const idx = project.characters.findIndex(c => c.id === req.params.charId);
  if (idx === -1) return res.status(404).json({ error: 'Character not found' });

  project.characters[idx] = { ...project.characters[idx], ...req.body, id: req.params.charId };
  saveProject(project);
  res.json(project.characters[idx]);
});

app.delete('/api/projects/:id/characters/:charId', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.characters = project.characters.filter(c => c.id !== req.params.charId);
  saveProject(project);
  res.json({ ok: true });
});

app.get('/api/projects/:id/characters/:charId/compose-reference', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const char = project.characters.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const charImgPath = path.join(UPLOADS_DIR, char.referenceImageFilename || '');
  if (!char.referenceImageFilename || !fs.existsSync(charImgPath)) return res.status(404).json({ error: 'Character image not found' });

  const stageW = project.stageWidth || 1920;
  const stageH = project.stageHeight || 1080;
  const p = char.placement || { x: 0.5, y: 0.85, scale: 0.6 };

  try {
    const buffer = await composeReferenceImage({
      characterImagePath: charImgPath,
      stageWidth: stageW,
      stageHeight: stageH,
      normX: p.x ?? 0.5,
      normY: p.y ?? 0.85,
      scale: p.scale ?? 0.6,
      background: project.background || '#4488cc',
      // Export uses only solid color + character (no background image)
    });
    const safeName = (char.name || 'reference').replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-reference.png"`);
    res.send(buffer);
  } catch (err) {
    console.error('[compose-reference]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: AI Spine analysis (Gemini) ────────────────────────────────────────

app.post('/api/projects/:id/characters/:charId/analyze-spine', async (req, res) => {
  if (!GEMINI_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY not configured' });

  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const char = project.characters.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const imgPath = path.join(UPLOADS_DIR, char.referenceImageFilename);
  if (!fs.existsSync(imgPath)) return res.status(400).json({ error: 'Reference image not found' });

  try {
    const imageData = fs.readFileSync(imgPath).toString('base64');
    const mimeType  = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const prompt = `Analyze this 2D character image for skeletal animation. Return a JSON object with EXACTLY this structure (no markdown, pure JSON):
{
  "image_type": "character",
  "description": "brief description",
  "anchors": [
    { "id": "root", "label": "Root", "x": 0.5, "y": 0.95, "type": "root" },
    { "id": "hips", "label": "Hips", "x": 0.5, "y": 0.65, "type": "joint" }
  ],
  "bones": [
    { "id": "spine", "from": "root", "to": "hips" }
  ],
  "animations": [
    {
      "name": "Idle Breathe",
      "description": "Gentle breathing motion",
      "duration": 3.0,
      "loop": true,
      "keyframes": [
        { "time": 0, "transforms": { "hips": { "translateY": 0, "scale": 1.0 } } },
        { "time": 1.5, "transforms": { "hips": { "translateY": -0.015, "scale": 1.01 } } },
        { "time": 3.0, "transforms": { "hips": { "translateY": 0, "scale": 1.0 } } }
      ]
    }
  ]
}
Use normalized coordinates (0-1) where (0,0) is top-left. Include at least 6-12 anchors for the main body parts. Include at least 3 animations (idle breathing, subtle sway, slight head tilt).`;

    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ inlineData: { mimeType, data: imageData } }, { text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      }
    );

    const apiData = await apiRes.json();

    // Handle Gemini API errors (invalid key, quota, blocked content, etc.)
    if (apiData.error) {
      const msg = apiData.error.message || apiData.error.status || 'Gemini API error';
      throw new Error(`Gemini API: ${msg}`);
    }

    const text    = apiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    if (!jsonStr) {
      throw new Error(
        'Gemini returned no analyzable content. ' +
        (apiData.candidates?.[0]?.finishReason === 'SAFETY'
          ? 'Image was blocked by safety filters.'
          : 'Check your API key and image, then try again.')
      );
    }

    let spineData;
    try {
      spineData = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[Spine analysis] Raw Gemini text:', text.slice(0, 500));
      throw new Error(`Gemini returned invalid JSON: ${e.message}`);
    }

    // Persist spine project on the character
    const idx = project.characters.findIndex(c => c.id === req.params.charId);
    project.characters[idx].spineProject = spineData;
    saveProject(project);

    res.json({ spineProject: spineData });
  } catch (err) {
    console.error('[Spine analysis]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: generate action video ─────────────────────────────────────────────

app.post('/api/projects/:id/characters/:charId/actions/generate', upload.single('referenceImage'), async (req, res) => {
  if (!KIE_KEY) return res.status(400).json({ error: 'KIE_API_KEY not configured (Veo 3.1)' });

  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const char = project.characters.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  // Support both JSON and multipart (multipart when reference image is uploaded)
  const body = req.body || {};
  const prompt = (body.prompt || (typeof body.prompt === 'string' ? body.prompt : '')).trim();
  const mode = body.mode || 'std';
  const actionName = (body.actionName || '').trim();
  const duration = [4, 6, 8].includes(Number(body.duration)) ? Number(body.duration) : 8;
  const sound = body.sound === false || body.sound === 'false' ? false : true;
  const referenceImageFile = req.file;

  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const jobId    = uuid();
  const actionId = uuid();
  const dir      = uploadsDir(project.id);

  // Add action placeholder to project
  const action = {
    id:        actionId,
    name:      (actionName || prompt.slice(0, 40)),
    prompt,
    status:    'generating',
    jobId,
    videoFilename:   null,
    previewFilename: null,
    duration: 0,
    chromaKey:  { enabled: true, color: project.background || '#4488cc', tolerance: 80, softness: 30 },
    completion: { mode: 'transition', transition: 'fade', duration: 800, easing: 'ease-in-out' },
    generatedAt: null,
  };
  char.actions.push(action);
  saveProject(project);

  // Job state
  jobs[jobId] = { status: 'composing', projectId: project.id, charId: char.id, actionId, log: [] };
  const log = (msg) => { console.log(`[job ${jobId.slice(0,8)}] ${msg}`); jobs[jobId].log.push(msg); };

  // Respond immediately with job ID
  res.json({ jobId, actionId });

  // Run pipeline in background
  (async () => {
    try {
      const stageW = project.stageWidth  || 1920;
      const stageH = project.stageHeight || 1080;
      const aspectRatio = stageW >= stageH ? '16:9' : '9:16';

      let imageUrl;
      let generationType;

      if (referenceImageFile) {
        // User provided reference image → REFERENCE_2_VIDEO (Fast only, 16:9 or 9:16)
        log('Using user reference image...');
        const refBuffer = fs.readFileSync(referenceImageFile.path);
        const refFilename = `ref_user_${actionId}.png`;
        log('Uploading reference image to Kie...');
        imageUrl = await uploadRefImageToKie({ apiKey: KIE_KEY, imageBuffer: refBuffer, fileName: refFilename });
        generationType = 'REFERENCE_2_VIDEO';
      } else {
        // Compose character on stage → FIRST_AND_LAST_FRAMES_2_VIDEO
        log('Composing reference frame...');
        const charImgPath = path.join(UPLOADS_DIR, char.referenceImageFilename);
        const bgImgPath = project.backgroundImage?.filename && fs.existsSync(path.join(UPLOADS_DIR, project.backgroundImage.filename))
          ? path.join(UPLOADS_DIR, project.backgroundImage.filename)
          : null;
        const refBuffer = await composeReferenceImage({
          characterImagePath: charImgPath,
          stageWidth:  stageW,
          stageHeight: stageH,
          normX:       char.placement?.x ?? 0.5,
          normY:       char.placement?.y ?? 0.85,
          scale:       char.placement?.scale ?? 0.6,
          background:  project.background,
          ...(bgImgPath && { backgroundImagePath: bgImgPath, backgroundImagePlacement: project.backgroundImage?.placement }),
        });
        log(`Reference image: ${stageW}×${stageH}`);
        const refFilename = `ref_${actionId}.png`;
        fs.writeFileSync(path.join(dir, refFilename), refBuffer);
        log('Uploading reference image to Kie...');
        imageUrl = await uploadRefImageToKie({ apiKey: KIE_KEY, imageBuffer: refBuffer, fileName: refFilename });
        generationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO';
      }
      log(`Reference: ${imageUrl.slice(0, 50)}...`);

      // Submit Veo 3.1 job
      jobs[jobId].status = 'generating';
      log('Submitting to Veo 3.1...');
      const veoModel = generationType === 'REFERENCE_2_VIDEO' ? 'veo3_fast' : (mode === 'pro' ? 'veo3' : 'veo3_fast');
      const taskId = await createVeoJob({
        apiKey: KIE_KEY,
        prompt,
        imageUrl,
        generationType,
        model: veoModel,
        aspectRatio,
        duration,
        sound,
      });
      jobs[jobId].taskId = taskId;
      log(`Veo task: ${taskId}`);

      // 3. Poll
      jobs[jobId].status = 'polling';
      const videoUrl = await pollVeoJob(taskId, KIE_KEY, (elapsed) => {
        jobs[jobId].elapsed = elapsed;
        log(`Polling... ${elapsed}s elapsed`);
      });

      // 4. Download
      jobs[jobId].status = 'downloading';
      log(`Downloading: ${videoUrl.slice(0, 60)}`);
      const vidFilename = `action_${actionId}.mp4`;
      const vidPath     = path.join(dir, vidFilename);
      await downloadVideo(videoUrl, vidPath);

      const hasAudio = await hasAudioStream(vidPath);
      if (hasAudio) {
        log('Extracting audio...');
        const audioFilename = `audio_${actionId}.mp3`;
        const audioPath = path.join(dir, audioFilename);
        await extractAudio(vidPath, audioPath);
        log('Stripping audio from video...');
        await stripAudio(vidPath);
        const projAud = loadProject(project.id);
        const actAud = projAud.characters.find(c => c.id === char.id)?.actions.find(a => a.id === actionId);
        if (actAud) {
          actAud.audioFilename = `${project.id}/${audioFilename}`;
          actAud.audioUrl = `/uploads/${project.id}/${audioFilename}`;
          saveProject(projAud);
        }
      } else if (!sound) {
        log('Stripping audio...');
        await stripAudio(vidPath);
      }

      // 5. Process (preview frame + metadata)
      jobs[jobId].status = 'processing';
      log('Extracting preview frame...');
      const meta = await processActionVideo(vidPath, dir);
      log(`Video dimensions: ${meta.width}×${meta.height} (ref was ${stageW}×${stageH})`);

      // 6. Update project
      const proj2 = loadProject(project.id);
      const ch2   = proj2.characters.find(c => c.id === char.id);
      const act   = ch2?.actions.find(a => a.id === actionId);
      if (act) {
        act.status            = 'ready';
        act.videoFilename     = `${project.id}/${vidFilename}`;
        act.videoUrl          = `/uploads/${project.id}/${vidFilename}`;
        act.previewFilename   = `${project.id}/${meta.previewFilename}`;
        act.previewUrl        = `/uploads/${project.id}/${meta.previewFilename}`;
        act.duration          = meta.duration;
        act.width             = meta.width;
        act.height            = meta.height;
        act.generatedAt       = Date.now();
      }
      saveProject(proj2);
      jobs[jobId].status = 'done';
      log('Done!');

    } catch (err) {
      console.error(`[job ${jobId.slice(0,8)}] ERROR:`, err);
      jobs[jobId].status = 'error';
      jobs[jobId].error  = err.message;
      // Mark action as failed
      const proj2 = loadProject(project.id);
      const ch2   = proj2?.characters.find(c => c.id === char.id);
      const act   = ch2?.actions.find(a => a.id === actionId);
      if (act) { act.status = 'error'; act.error = err.message; saveProject(proj2); }
    }
  })();
});

// ── Route: job status ────────────────────────────────────────────────────────

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Route: update action settings ───────────────────────────────────────────

app.put('/api/projects/:id/characters/:charId/actions/:actionId', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const char = project.characters.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const idx = char.actions.findIndex(a => a.id === req.params.actionId);
  if (idx === -1) return res.status(404).json({ error: 'Action not found' });

  char.actions[idx] = { ...char.actions[idx], ...req.body, id: req.params.actionId };
  saveProject(project);
  res.json(char.actions[idx]);
});

app.delete('/api/projects/:id/characters/:charId/actions/:actionId', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const char = project.characters.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  char.actions = char.actions.filter(a => a.id !== req.params.actionId);
  saveProject(project);
  res.json({ ok: true });
});

app.post('/api/projects/:id/characters/:charId/actions/:actionId/duplicate', async (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const char = project.characters.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const action = char.actions.find(a => a.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  if (action.status !== 'ready') return res.status(400).json({ error: 'Can only duplicate ready actions' });

  const newActionId = uuid();
  const dir = uploadsDir(project.id);
  const srcPath = path.join(UPLOADS_DIR, action.videoFilename);
  const vidFilename = `action_${newActionId}.mp4`;
  const destPath = path.join(dir, vidFilename);

  fs.copyFileSync(srcPath, destPath);
  const meta = await processActionVideo(destPath, dir);

  let audioFilename = null;
  let audioUrl = null;
  if (action.audioFilename) {
    const srcAudPath = path.join(UPLOADS_DIR, action.audioFilename);
    if (fs.existsSync(srcAudPath)) {
      const audFilename = `audio_${newActionId}.mp3`;
      const destAudPath = path.join(dir, audFilename);
      fs.copyFileSync(srcAudPath, destAudPath);
      audioFilename = `${project.id}/${audFilename}`;
      audioUrl = `/uploads/${project.id}/${audFilename}`;
    }
  }

  const newAction = {
    id: newActionId,
    name: `Copy of ${action.name}`,
    prompt: action.prompt,
    status: 'ready',
    videoFilename: `${project.id}/${vidFilename}`,
    videoUrl: `/uploads/${project.id}/${vidFilename}`,
    previewFilename: `${project.id}/${meta.previewFilename}`,
    previewUrl: `/uploads/${project.id}/${meta.previewFilename}`,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    chromaKey: { ...action.chromaKey },
    completion: { ...action.completion },
    trimStart: action.trimStart,
    trimEnd: action.trimEnd,
    audioFilename,
    audioUrl,
    generatedAt: Date.now(),
  };
  char.actions.push(newAction);
  saveProject(project);
  res.json(newAction);
});

// ── Route: export package ────────────────────────────────────────────────────

app.post('/api/projects/:id/export', (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const safeName = (project.name || 'export').replace(/[^a-z0-9_-]/gi, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);

  exportProject(project, UPLOADS_DIR, res)
    .catch(err => { console.error('[export]', err); });
});

// Static last so /api/* routes are matched first
app.use('/', express.static(path.join(__dirname, 'public')));

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nVideo Action Studio running at http://localhost:${PORT}`);
  console.log(`KIE key: ${KIE_KEY ? 'configured (Veo 3.1)' : 'NOT SET – add KIE_API_KEY to .env'}`);
  console.log(`Gemini:  ${GEMINI_KEY ? 'configured' : 'not set (Spine analysis disabled)'}`);
  console.log(`Public URL: ${PUBLIC_URL}\n`);
});
