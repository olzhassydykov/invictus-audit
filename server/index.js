const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const AMO_TOKEN = (process.env.AMO_TOKEN || '').trim();
const AMO_DOMAIN = process.env.AMO_DOMAIN || 'invictusgo.amocrm.ru';
const ANTHROPIC_KEY = (process.env.ANTHROPIC_KEY || '').trim();
const GROQ_KEY = process.env.GROQ_KEY || '';
const WAZZUP_KEY = process.env.WAZZUP_KEY;
const CALLS_BASE_URL = 'https://op.entryx.io/amo/monitor';
const PORT = process.env.PORT || 3001;

const db = new sqlite3.Database('./audit.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT, wazzup_message_id TEXT UNIQUE, channel_id TEXT,
    contact_name TEXT, contact_phone TEXT, manager_name TEXT, lead_id TEXT,
    direction TEXT, text TEXT, timestamp INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT UNIQUE, lead_id TEXT, manager_name TEXT,
    contact_name TEXT, contact_phone TEXT,
    last_message_at INTEGER, messages_count INTEGER DEFAULT 0,
    analysis TEXT, analyzed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT UNIQUE, manager_name TEXT, lead_id TEXT,
    contact_phone TEXT, duration INTEGER, direction TEXT,
    file_url TEXT, transcript TEXT, analysis TEXT, called_at INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT, date_from TEXT, date_to TEXT, report TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Канал → номер (для определения входящий/исходящий)
const CHANNELS = {
  '87005001099': 'Invictus GO',
  '87005001702': 'Invictus GO 2',
};

const MANAGERS = {
  '2044417':'Танеке','2150484':'Айгерим','7158001':'Администратор',
  '7207546':'Акжол','7270360':'Дильназ','7616848':'Гания',
  '7616944':'Дайана','7617028':'Фуад','7617046':'Илья',
  '7617088':'Никита','7617100':'Диана','8945498':'Navoi',
  '8945674':'Айгера','8945678':'Айдай','9473638':'Милана',
  '10158750':'Айдана','10757002':'Алишер','10920190':'Аятолла',
  '11028126':'Дамир','11179978':'Есей','11237754':'Жасулан',
  '11252562':'Каракат','12062466':'Дильнара',
  '12062502':'Амина','13526610':'Александр','13526650':'Айдана2',
  '13529206':'Диана2','13552546':'Диас','13565310':'Назир',
  '13586134':'Есей2','11428894':'Гульден'
};

function toSeconds(ts) {
  if (!ts) return Math.floor(Date.now() / 1000);
  return ts > 9999999999 ? Math.floor(ts / 1000) : ts;
}

async function amoGet(path) {
  const res = await axios.get(`https://${AMO_DOMAIN}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${AMO_TOKEN}` }, timeout: 15000
  });
  return res.data;
}

async function claudeAnalyze(prompt) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
  return res.data.content[0].text;
}

// ─── GROQ WHISPER TRANSCRIPTION ──────────────────────────────────────────────
async function transcribeAudio(wavUrl) {
  // Скачиваем WAV во временный файл
  const tmpPath = `/tmp/call_${Date.now()}.wav`;
  try {
    const response = await axios.get(wavUrl, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(tmpPath, Buffer.from(response.data));

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath), { filename: 'audio.wav', contentType: 'audio/wav' });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'ru');
    form.append('response_format', 'text');

    const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_KEY}` },
      timeout: 120000
    });

    return res.data;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ─── PARSE CALL FILENAME ──────────────────────────────────────────────────────
// Формат: in-87005001099-+77010103152-20260312-111144-1773295904.3233695.wav
function parseCallFilename(filename) {
  const name = filename.replace('.wav', '');
  const parts = name.split('-');
  // parts[0] = direction (in/out)
  // parts[1] = channel
  // parts[2] = phone (с +)
  // parts[3] = date YYYYMMDD
  // parts[4] = time HHMMSS
  // parts[5] = call_id
  if (parts.length < 6) return null;
  const direction = parts[0];
  const channel = parts[1];
  const phone = parts[2];
  const dateStr = parts[3]; // 20260312
  const timeStr = parts[4]; // 111144
  const callId = parts.slice(5).join('-');

  const year = dateStr.slice(0,4), month = dateStr.slice(4,6), day = dateStr.slice(6,8);
  const hour = timeStr.slice(0,2), min = timeStr.slice(2,4), sec = timeStr.slice(4,6);
  const calledAt = Math.floor(new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}+05:00`).getTime() / 1000);

  return { direction, channel, phone, callId, calledAt, dateStr, timeStr };
}

// ─── SYNC CALLS FROM ENTRYX ──────────────────────────────────────────────────
async function syncCallsForDate(dateStr) {
  // dateStr = 2026-03-12
  const [year, month, day] = dateStr.split('-');
  const url = `${CALLS_BASE_URL}/${year}/${month}/${day}/`;

  console.log(`Syncing calls from ${url}`);

  const html = (await axios.get(url, { timeout: 15000 })).data;

  // Парсим href из HTML — только чистые .wav файлы, без tmp и split-каналов
  const matches = [...html.matchAll(/href="([^"]+\.wav)"/g)];
  const files = matches.map(m => m[1]).filter(f =>
    !f.startsWith('?') &&
    !f.startsWith('/') &&
    !f.includes('__tmp__') &&
    !f.endsWith('-in.wav') &&
    !f.endsWith('-out.wav')
  );

  console.log(`Found ${files.length} WAV files for ${dateStr}`);

  let synced = 0, skipped = 0;
  for (const filename of files) {
    const parsed = parseCallFilename(filename);
    if (!parsed) continue;

    // Проверяем нет ли уже в БД
    const exists = await new Promise(r => db.get('SELECT id FROM calls WHERE call_id = ?', [parsed.callId], (e, row) => r(row)));
    if (exists) { skipped++; continue; }

    const fileUrl = `${CALLS_BASE_URL}/${year}/${month}/${day}/${filename}`;

    db.run(`INSERT OR IGNORE INTO calls (call_id, contact_phone, direction, file_url, called_at)
      VALUES (?, ?, ?, ?, ?)`,
      [parsed.callId, parsed.phone, parsed.direction, fileUrl, parsed.calledAt]
    );
    synced++;
  }

  console.log(`Synced ${synced} new calls, skipped ${skipped}`);
  return { total: files.length, synced, skipped };
}

// ─── TRANSCRIBE & ANALYZE PENDING CALLS ──────────────────────────────────────
async function processPendingCalls(limit = 10) {
  const calls = await new Promise(r => db.all(
    `SELECT * FROM calls WHERE transcript IS NULL AND file_url IS NOT NULL ORDER BY called_at DESC LIMIT ?`,
    [limit], (e, rows) => r(rows || [])
  ));

  console.log(`Processing ${calls.length} pending calls...`);
  let processed = 0;

  for (const call of calls) {
    try {
      console.log(`Transcribing: ${call.file_url}`);
      const transcript = await transcribeAudio(call.file_url);

      if (!transcript || transcript.trim().length < 10) {
        db.run(`UPDATE calls SET transcript = ? WHERE id = ?`, ['[пустая запись]', call.id]);
        continue;
      }

      // Анализируем через Claude
      const analysis = await claudeAnalyze(`
Ты — аудитор отдела продаж фитнес-клуба Invictus GO (Алматы).
Клиент: ${call.contact_phone}
Направление: ${call.direction === 'in' ? 'входящий звонок' : 'исходящий звонок'}

ТРАНСКРИПЦИЯ ЗВОНКА:
${transcript.slice(0, 4000)}

Ответь ТОЛЬКО в JSON без markdown:
{
  "score": число от 1 до 10,
  "result": "продал" | "не продал" | "перезвонит" | "думает",
  "client_interest": "высокий" | "средний" | "низкий",
  "manager_name": "имя менеджера из разговора или null",
  "errors": ["конкретная ошибка менеджера"],
  "strengths": ["конкретная сильная сторона"],
  "loss_reason": "конкретная причина потери или null",
  "recommendation": "конкретный совет менеджеру"
}`);

      // Пробуем извлечь имя менеджера из анализа
      let managerName = call.manager_name || null;
      try {
        const parsed = JSON.parse(analysis);
        if (!managerName && parsed.manager_name) managerName = parsed.manager_name;
      } catch(e) {}

      db.run(`UPDATE calls SET transcript = ?, analysis = ?, manager_name = ? WHERE id = ?`,
        [transcript, analysis, managerName, call.id]);

      processed++;
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error(`Call processing error ${call.call_id}:`, e.message);
    }
  }

  return processed;
}

// ─── WAZZUP WEBHOOK ───────────────────────────────────────────────────────────
app.post('/webhook/wazzup', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.json({ ok: true });

    for (const msg of messages) {
      const { messageId, chatId, channelId, text, dateTime, contact, authorId, authorName, isEcho } = msg;
      if (!text || !text.trim()) continue;

      const direction = isEcho ? 'out' : 'in';
      const contactPhone = contact?.phone || chatId;
      const contactName = contact?.name || contactPhone;
      const ts = toSeconds(dateTime ? Math.floor(new Date(dateTime).getTime() / 1000) : null);

      let managerName = null;
      if (isEcho && authorId) {
        managerName = MANAGERS[String(authorId)] || authorName || null;
      }

      db.run(`INSERT OR IGNORE INTO messages 
        (chat_id, wazzup_message_id, channel_id, contact_name, contact_phone, manager_name, direction, text, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [chatId, messageId, channelId, contactName, contactPhone, managerName, direction, text.trim(), ts]
      );

      db.run(`INSERT INTO conversations (chat_id, contact_name, contact_phone, manager_name, last_message_at, messages_count)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(chat_id) DO UPDATE SET
          last_message_at = excluded.last_message_at,
          messages_count = messages_count + 1,
          contact_name = excluded.contact_name,
          manager_name = COALESCE(excluded.manager_name, manager_name)`,
        [chatId, contactName, contactPhone, managerName, ts]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.json({ ok: true });
  }
});

// ─── WEBHOOK: MANUAL CALL ─────────────────────────────────────────────────────
app.post('/webhook/call', async (req, res) => {
  try {
    const { call_id, manager_name, lead_id, contact_phone, duration, direction, transcript, called_at } = req.body;
    if (!transcript || !call_id) return res.status(400).json({ error: 'Missing fields' });

    const analysis = await claudeAnalyze(`
Ты — аудитор отдела продаж фитнес-клуба Invictus GO (Алматы).
Менеджер: ${manager_name}, Клиент: ${contact_phone}
ТРАНСКРИПЦИЯ: ${transcript}
Ответь ТОЛЬКО в JSON: { "score":1-10, "result":"продал"|"не продал"|"перезвонит"|"думает", "client_interest":"высокий"|"средний"|"низкий", "errors":[], "strengths":[], "loss_reason":null, "recommendation":"" }`);

    db.run(`INSERT OR REPLACE INTO calls (call_id, manager_name, lead_id, contact_phone, duration, direction, transcript, analysis, called_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [call_id, manager_name, lead_id, contact_phone, duration, direction, transcript, analysis, toSeconds(called_at)]
    );

    let parsed = null;
    try { parsed = JSON.parse(analysis); } catch(e) {}
    res.json({ ok: true, analysis: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: SYNC CALLS ──────────────────────────────────────────────────────────
app.post('/api/sync-calls', async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const syncResult = await syncCallsForDate(date);
    res.json({ ok: true, ...syncResult });

    // Запускаем транскрипцию в фоне
    processPendingCalls(20).then(n => console.log(`Processed ${n} calls`));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: ANALYZE ALL CONVERSATIONS ──────────────────────────────────────────
app.post('/api/analyze-all', async (req, res) => {
  try {
    const conversations = await new Promise((resolve) => {
      db.all(`SELECT * FROM conversations WHERE analysis IS NULL AND messages_count > 0 ORDER BY messages_count DESC LIMIT 50`,
        (err, rows) => resolve(rows || []));
    });

    if (!conversations.length) return res.json({ ok: true, analyzed: 0, message: 'Все уже проанализированы' });
    res.json({ ok: true, total: conversations.length, message: `Анализируем ${conversations.length} переписок...` });

    (async () => {
      for (const conv of conversations) {
        try {
          const messages = await new Promise((resolve) => {
            db.all(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`, [conv.chat_id],
              (err, rows) => resolve(rows || []));
          });
          if (!messages.length) continue;

          const transcript = messages.map(m =>
            `${m.direction === 'out' ? (m.manager_name || 'Менеджер') : 'Клиент'}: ${m.text}`
          ).join('\n');

          const managerFromMsgs = messages.find(m => m.direction === 'out' && m.manager_name)?.manager_name;
          const managerName = conv.manager_name || managerFromMsgs || 'Неизвестно';

          if (managerFromMsgs && !conv.manager_name) {
            db.run(`UPDATE conversations SET manager_name = ? WHERE chat_id = ?`, [managerFromMsgs, conv.chat_id]);
          }

          const analysis = await claudeAnalyze(`
Ты — аудитор отдела продаж фитнес-клуба Invictus GO (Алматы).
Менеджер: ${managerName}, Клиент: ${conv.contact_name}
ПЕРЕПИСКА WhatsApp:
${transcript.slice(0, 4000)}
Ответь ТОЛЬКО в JSON без markdown:
{
  "score": число 1-10,
  "result": "продал"|"не продал"|"перезвонит"|"думает",
  "client_interest": "высокий"|"средний"|"низкий",
  "errors": ["конкретная ошибка"],
  "strengths": ["конкретная сильная сторона"],
  "loss_reason": "причина или null",
  "recommendation": "конкретный совет менеджеру ${managerName}"
}`);

          db.run(`UPDATE conversations SET analysis = ?, analyzed_at = CURRENT_TIMESTAMP WHERE chat_id = ?`,
            [analysis, conv.chat_id]);

          await new Promise(r => setTimeout(r, 500));
        } catch(e) {
          console.error('Analysis error:', conv.chat_id, e.message);
        }
      }
      console.log('Conversations analysis complete');
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: AUDIT ───────────────────────────────────────────────────────────────
app.get('/api/audit', async (req, res) => {
  try {
    const { period = 'day', date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    let dateFrom, dateTo;
    if (period === 'day') {
      dateFrom = targetDate; dateTo = targetDate;
    } else {
      const d = new Date(targetDate);
      dateFrom = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
      dateTo = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    }
    const tsFrom = Math.floor(new Date(dateFrom).getTime() / 1000);
    const tsTo = Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000);

    let totalLeads = 0;
    try {
      const leadsData = await amoGet(`/leads?filter[created_at][from]=${tsFrom}&filter[created_at][to]=${tsTo}&limit=1`);
      totalLeads = leadsData._total_items || 0;
    } catch(e) {}

    const calls = await new Promise(r => db.all(
      `SELECT * FROM calls WHERE called_at >= ? AND called_at <= ? ORDER BY called_at DESC`,
      [tsFrom, tsTo], (e, rows) => r(rows || [])
    ));

    const conversations = await new Promise(r => db.all(
      `SELECT * FROM conversations WHERE last_message_at >= ? AND last_message_at <= ? ORDER BY last_message_at DESC`,
      [tsFrom, tsTo], (e, rows) => r(rows || [])
    ));

    const analyzedCalls = calls.filter(c => c.analysis);
    let callAvgScore = 0;
    if (analyzedCalls.length) {
      const scores = analyzedCalls.map(c => { try { return JSON.parse(c.analysis).score || 0; } catch(e) { return 0; } });
      callAvgScore = (scores.reduce((a,b)=>a+b,0) / scores.length).toFixed(1);
    }

    const report = {
      period, dateFrom, dateTo,
      amo: { totalLeads },
      calls: { total: calls.length, analyzed: analyzedCalls.length, avgScore: callAvgScore,
        withTranscript: calls.filter(c => c.transcript).length },
      conversations: { total: conversations.length, analyzed: conversations.filter(c => c.analysis).length },
      recentCalls: calls.slice(0, 15).map(c => ({
        id: c.call_id, manager: c.manager_name, phone: c.contact_phone,
        duration: c.duration, direction: c.direction,
        date: new Date(c.called_at * 1000).toLocaleString('ru-RU'),
        hasTranscript: !!c.transcript,
        analysis: c.analysis ? (() => { try { return JSON.parse(c.analysis); } catch(e) { return null; } })() : null
      })),
      recentConversations: conversations.slice(0, 30).map(c => ({
        ...c,
        lastDate: c.last_message_at ? new Date(c.last_message_at * 1000).toLocaleString('ru-RU') : '—'
      }))
    };

    db.run(`INSERT INTO audits (period, date_from, date_to, report) VALUES (?, ?, ?, ?)`,
      [period, dateFrom, dateTo, JSON.stringify(report)]);

    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: MANAGER REPORT ──────────────────────────────────────────────────────
app.get('/api/manager-report', async (req, res) => {
  try {
    const conversations = await new Promise(r => db.all(
      `SELECT * FROM conversations WHERE analysis IS NOT NULL`, (e, rows) => r(rows || [])
    ));
    const calls = await new Promise(r => db.all(
      `SELECT * FROM calls WHERE analysis IS NOT NULL`, (e, rows) => r(rows || [])
    ));

    const managers = {};
    const addToManager = (name, item, type) => {
      if (!managers[name]) managers[name] = { name, convs:[], calls:[], scores:[], errors:[], strengths:[], recommendations:[] };
      try {
        const a = JSON.parse(type === 'conv' ? item.analysis : item.analysis);
        managers[name][type === 'conv' ? 'convs' : 'calls'].push({ ...a });
        if (a.score) managers[name].scores.push(a.score);
        if (a.errors) managers[name].errors.push(...a.errors);
        if (a.strengths) managers[name].strengths.push(...a.strengths);
        if (a.recommendation) managers[name].recommendations.push(a.recommendation);
      } catch(e) {}
    };

    conversations.forEach(c => addToManager(c.manager_name || 'Неизвестно', c, 'conv'));
    calls.forEach(c => addToManager(c.manager_name || 'Неизвестно', c, 'call'));

    const report = Object.values(managers).map(m => {
      const avgScore = m.scores.length ? (m.scores.reduce((a,b)=>a+b,0)/m.scores.length).toFixed(1) : 0;
      const all = [...m.convs, ...m.calls];
      const errorCount = {};
      m.errors.forEach(e => { errorCount[e] = (errorCount[e]||0)+1; });
      const topErrors = Object.entries(errorCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([e])=>e);
      const strCount = {};
      m.strengths.forEach(s => { strCount[s] = (strCount[s]||0)+1; });
      const topStrengths = Object.entries(strCount).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s])=>s);
      return {
        name: m.name,
        totalInteractions: all.length,
        convs: m.convs.length,
        calls: m.calls.length,
        avgScore: Number(avgScore),
        topErrors,
        topStrengths,
        lastRecommendation: m.recommendations[m.recommendations.length-1] || null,
        results: {
          sold: all.filter(x=>x.result==='продал').length,
          lost: all.filter(x=>x.result==='не продал').length,
          pending: all.filter(x=>['перезвонит','думает'].includes(x.result)).length,
        }
      };
    }).sort((a,b) => b.avgScore - a.avgScore);

    res.json({ managers: report, totalConvs: conversations.length, totalCalls: calls.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: STATS ───────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [callsCount, convsCount, msgsCount, analyzedConvs, analyzedCalls, withTranscript] = await Promise.all([
      new Promise(r => db.get('SELECT COUNT(*) as n FROM calls', (e,row)=>r(row?.n||0))),
      new Promise(r => db.get('SELECT COUNT(*) as n FROM conversations', (e,row)=>r(row?.n||0))),
      new Promise(r => db.get('SELECT COUNT(*) as n FROM messages', (e,row)=>r(row?.n||0))),
      new Promise(r => db.get('SELECT COUNT(*) as n FROM conversations WHERE analysis IS NOT NULL', (e,row)=>r(row?.n||0))),
      new Promise(r => db.get('SELECT COUNT(*) as n FROM calls WHERE analysis IS NOT NULL', (e,row)=>r(row?.n||0))),
      new Promise(r => db.get('SELECT COUNT(*) as n FROM calls WHERE transcript IS NOT NULL', (e,row)=>r(row?.n||0))),
    ]);
    res.json({ callsCount, convsCount, msgsCount, analyzedConvs, analyzedCalls, withTranscript });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug/conversations', async (req, res) => {
  const rows = await new Promise(r => db.all(
    'SELECT chat_id, contact_name, manager_name, last_message_at, messages_count, analysis, created_at FROM conversations ORDER BY created_at DESC LIMIT 50',
    (e, rows) => r(rows || [])
  ));
  res.json(rows);
});

app.listen(PORT, () => console.log(`🚀 Invictus Audit на порту ${PORT}`));
