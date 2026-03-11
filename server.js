/**
 * Video Action Studio – Express server
 *
 * Manages projects, reference images, Kling video generation jobs,
 * and exports the complete game asset package.
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';

import { createKlingJob, pollKlingJob, downloadVideo } from './scripts/kling-video.js';
import { composeReferenceImage } from './scripts/compose-reference.js';
import { processActionVideo } from './scripts/process-action-video.js';
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
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/', express.static(path.join(__dirname, 'public')));

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

app.post('/api/projects/:id/characters/:charId/actions/generate', async (req, res) => {
  if (!KIE_KEY) return res.status(400).json({ error: 'KIE_API_KEY not configured' });

  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const char = project.characters.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const { prompt, mode = 'std', actionName } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const jobId    = uuid();
  const actionId = uuid();
  const dir      = uploadsDir(project.id);

  // Add action placeholder to project
  const action = {
    id:        actionId,
    name:      actionName || prompt.slice(0, 40),
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
      // 1. Compose reference image
      log('Composing reference frame...');
      const charImgPath = path.join(UPLOADS_DIR, char.referenceImageFilename);
      const refBuffer = await composeReferenceImage({
        characterImagePath: charImgPath,
        stageWidth:  project.stageWidth,
        stageHeight: project.stageHeight,
        normX:       char.placement.x,
        normY:       char.placement.y,
        scale:       char.placement.scale,
        background:  project.background,
      });
      const refFilename = `ref_${actionId}.png`;
      const refPath     = path.join(dir, refFilename);
      fs.writeFileSync(refPath, refBuffer);
      const imageUrl = `${PUBLIC_URL}/uploads/${project.id}/${refFilename}`;
      log(`Reference image: ${imageUrl}`);

      // 2. Submit Kling job
      jobs[jobId].status = 'generating';
      log('Submitting to Kling...');
      const taskId = await createKlingJob({ apiKey: KIE_KEY, prompt, imageUrl, mode });
      jobs[jobId].taskId = taskId;
      log(`Kling task: ${taskId}`);

      // 3. Poll
      jobs[jobId].status = 'polling';
      const videoUrl = await pollKlingJob(taskId, KIE_KEY, (elapsed) => {
        jobs[jobId].elapsed = elapsed;
        log(`Polling... ${elapsed}s elapsed`);
      });

      // 4. Download
      jobs[jobId].status = 'downloading';
      log(`Downloading: ${videoUrl.slice(0, 60)}`);
      const vidFilename = `action_${actionId}.mp4`;
      const vidPath     = path.join(dir, vidFilename);
      await downloadVideo(videoUrl, vidPath);

      // 5. Process (preview frame + metadata)
      jobs[jobId].status = 'processing';
      log('Extracting preview frame...');
      const meta = await processActionVideo(vidPath, dir);

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

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nVideo Action Studio running at http://localhost:${PORT}`);
  console.log(`KIE key: ${KIE_KEY ? 'configured' : 'NOT SET – add KIE_API_KEY to .env'}`);
  console.log(`Gemini:  ${GEMINI_KEY ? 'configured' : 'not set (Spine analysis disabled)'}`);
  console.log(`Public URL: ${PUBLIC_URL}\n`);
});
