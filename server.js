// ============================================================
// CUZO CONTENT FACTORY — Railway Backend
// Node.js 18+ required (uses native fetch)
// ============================================================

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Env vars ─────────────────────────────────────────────────
const KIE_KEY    = process.env.KIE_API_KEY;
const EL_KEY     = process.env.ELEVENLABS_API_KEY;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const KIE_BASE   = 'https://api.kie.ai/api/v1/jobs';
const EL_BASE    = 'https://api.elevenlabs.io/v1';

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '50mb' }));

// Log every request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Cuzo Content Factory Backend',
    keys: {
      kie: !!KIE_KEY,
      elevenlabs: !!EL_KEY,
    },
    timestamp: new Date().toISOString(),
  });
});

// ── KIE helper ────────────────────────────────────────────────
async function kiePost(endpoint, body) {
  const res = await fetch(`${KIE_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KIE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function kiePoll(taskId) {
  const res = await fetch(`${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { 'Authorization': `Bearer ${KIE_KEY}` },
  });
  const data = await res.json();

  // Parse resultJson string → object if present
  if (data.data?.resultJson && typeof data.data.resultJson === 'string') {
    try { data.data.result = JSON.parse(data.data.resultJson); } catch (_) {}
  }
  return data;
}

// Map tier names to KIE model strings
function getKlingModel(mode) {
  const map = {
    standard: 'kling-v2.1/text-to-video',
    pro:      'kling-v2.1-pro/text-to-video',
    master:   'kling-v2.1-master/text-to-video',
  };
  return map[mode?.toLowerCase()] || map.pro;
}

// ── VIDEO GENERATION (Kling) ──────────────────────────────────
app.post('/api/video/generate', async (req, res) => {
  if (!KIE_KEY) return res.status(500).json({ error: 'KIE_API_KEY not configured' });

  const {
    prompt,
    negative_prompt,
    mode = 'pro',
    aspect_ratio = '9:16',
    duration = '5',
  } = req.body;

  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const data = await kiePost('/createTask', {
      model: getKlingModel(mode),
      input: {
        prompt,
        negative_prompt: negative_prompt || '',
        aspect_ratio,
        duration: String(duration),
      },
    });

    if (data.code !== 200) {
      return res.status(400).json({ error: data.msg || 'KIE API error', raw: data });
    }

    res.json({ taskId: data.data.taskId, status: 'queued' });
  } catch (err) {
    console.error('[video/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PHOTO GENERATION (NanoBanana Pro) ────────────────────────
app.post('/api/photo/generate', async (req, res) => {
  if (!KIE_KEY) return res.status(500).json({ error: 'KIE_API_KEY not configured' });

  const {
    prompt,
    image_input = [],      // array of image URLs for reference
    aspect_ratio = '9:16',
    resolution = '2K',
  } = req.body;

  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const body = {
      model: 'nano-banana-pro',
      input: {
        prompt,
        aspect_ratio,
        resolution,
        output_format: 'jpg',
      },
    };

    // Only include image_input if reference images are provided
    if (Array.isArray(image_input) && image_input.length > 0) {
      body.input.image_input = image_input.slice(0, 8); // max 8 refs
    }

    const data = await kiePost('/createTask', body);

    if (data.code !== 200) {
      return res.status(400).json({ error: data.msg || 'KIE API error', raw: data });
    }

    res.json({ taskId: data.data.taskId, status: 'queued' });
  } catch (err) {
    console.error('[photo/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TASK STATUS POLL (shared for video + photo) ───────────────
app.get('/api/task/status', async (req, res) => {
  if (!KIE_KEY) return res.status(500).json({ error: 'KIE_API_KEY not configured' });

  const { taskId } = req.query;
  if (!taskId) return res.status(400).json({ error: 'taskId is required' });

  try {
    const data = await kiePoll(taskId);
    const state = data.data?.state;

    // Normalize response for frontend
    const result = {
      taskId,
      state: state || 'unknown',
      ready: state === 'success',
      failed: state === 'fail',
      urls: [],
    };

    if (state === 'success') {
      const r = data.data?.result || {};
      result.urls = r.resultUrls || r.videos?.map(v => v.url) || [];
    }

    res.json(result);
  } catch (err) {
    console.error('[task/status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── VOICE TTS (ElevenLabs) ────────────────────────────────────
// Returns raw audio/mpeg — frontend creates an object URL to play/download
app.post('/api/voice/tts', async (req, res) => {
  if (!EL_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });

  const { voice_id, text, speed = 'normal', model_id = 'eleven_multilingual_v2' } = req.body;
  if (!voice_id) return res.status(400).json({ error: 'voice_id is required' });
  if (!text)     return res.status(400).json({ error: 'text is required' });

  const speedMap = { slow: 0.75, normal: 1.0, fast: 1.25 };
  const speaking_rate = speedMap[speed] || 1.0;

  try {
    const r = await fetch(`${EL_BASE}/text-to-speech/${voice_id}`, {
      method: 'POST',
      headers: {
        'xi-api-key': EL_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speaking_rate,
        },
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('[voice/tts] ElevenLabs error:', errText);
      return res.status(r.status).json({ error: errText });
    }

    const buffer = await r.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', 'attachment; filename="voice.mp3"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[voice/tts]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TEST ENDPOINTS ────────────────────────────────────────────
app.get('/api/test/kie', async (req, res) => {
  if (!KIE_KEY) return res.json({ connected: false, reason: 'KIE_API_KEY not set' });
  try {
    // Hit the status endpoint with a dummy ID — will return an error but confirms connectivity
    const r = await fetch(`${KIE_BASE}/recordInfo?taskId=test_connection`, {
      headers: { 'Authorization': `Bearer ${KIE_KEY}` },
    });
    const ok = r.status !== 401 && r.status !== 403;
    res.json({ connected: ok, httpStatus: r.status });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

app.get('/api/test/elevenlabs', async (req, res) => {
  if (!EL_KEY) return res.json({ connected: false, reason: 'ELEVENLABS_API_KEY not set' });
  try {
    const r = await fetch(`${EL_BASE}/voices`, {
      headers: { 'xi-api-key': EL_KEY },
    });
    const data = await r.json();
    res.json({ connected: r.ok, voiceCount: data.voices?.length || 0 });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ── 404 fallback ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Cuzo Backend running on port ${PORT}`);
  console.log(`   KIE API:      ${KIE_KEY ? '✓ configured' : '✗ MISSING'}`);
  console.log(`   ElevenLabs:   ${EL_KEY  ? '✓ configured' : '✗ MISSING'}`);
});
