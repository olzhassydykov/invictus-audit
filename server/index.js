const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const AMO_TOKEN = (process.env.AMO_TOKEN || '').trim();
const AMO_DOMAIN = process.env.AMO_DOMAIN || 'invictusgo.amocrm.ru';
const ANTHROPIC_KEY = (process.env.ANTHROPIC_KEY || '').trim();
const WAZZUP_KEY = process.env.WAZZUP_KEY;
const PORT = process.env.PORT || 3001;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new sqlite3.Database('./audit.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    wazzup_message_id TEXT UNIQUE,
    channel_id TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    manager_name TEXT,
    lead_id TEXT,
    direction TEXT,
    text TEXT,
    timestamp INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT UNIQUE,
    lead_id TEXT,
    manager_name TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    last_message_at INTEGER,
    messages_count INTEGER DEFAULT 0,
    analysis TEXT,
    analyzed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT UNIQUE,
    manager_name TEXT,
    lead_id TEXT,
    contact_phone TEXT,
    duration INTEGER,
    direction TEXT,
    transcript TEXT,
    analysis TEXT,
    called_at INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT,
    date_from TEXT,
    date_to TEXT,
    report TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function toSeconds(ts) {
  if (!ts) return Math.floor(Date.now() / 1000);
  // Если timestamp в миллисекундах — конвертируем
  return ts > 9999999999 ? Math.floor(ts / 1000) : ts;
}

async function amoGet(path) {
  const res = await axios.get(`https://${AMO_DOMAIN}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${AMO_TOKEN}` },
    timeout: 15000
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
    }
  });
  return res.data.content[0].text;
}

// ─── WAZZUP WEBHOOK ───────────────────────────────────────────────────────────
app.post('/webhook/wazzup', async (req, res) => {
  try {
    console.log('Wazzup webhook received:', JSON.stringify(req.body).slice(0, 500));
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.json({ ok: true });

    for (const msg of messages) {
      const { messageId, chatId, channelId, text, timestamp, contact, author } = msg;
      if (!text) continue;

      const direction = author?.channelId ? 'out' : 'in';
      const contactPhone = contact?.phone || chatId;
      const contactName = contact?.name || contactPhone;
      const ts = toSeconds(timestamp);

      db.run(`INSERT OR IGNORE INTO messages 
        (chat_id, wazzup_message_id, channel_id, contact_name, contact_phone, direction, text, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [chatId, messageId, channelId, contactName, contactPhone, direction, text, ts]
      );

      db.run(`INSERT INTO conversations (chat_id, contact_name, contact_phone, last_message_at, messages_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(chat_id) DO UPDATE SET
          last_message_at = excluded.last_message_at,
          messages_count = messages_count + 1,
          contact_name = excluded.contact_name`,
        [chatId, contactName, contactPhone, ts]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.json({ ok: true });
  }
});

// ─── WEBHOOK: YANDEX CALL TRANSCRIPTION ───────────────────────────────────────
app.post('/webhook/call', async (req, res) => {
  try {
    const { call_id, manager_name, lead_id, contact_phone, duration, direction, transcript, called_at } = req.body;
    if (!transcript || !call_id) return res.status(400).json({ error: 'Missing fields' });

    const analysis = await claudeAnalyze(`
Ты — аудитор отдела продаж фитнес-клуба Invictus GO (Алматы).
Проанализируй звонок менеджера "${manager_name}".

ТРАНСКРИПЦИЯ:
${transcript}

Ответь ТОЛЬКО в JSON без markdown:
{
  "score": число от 1 до 10,
  "result": "продал" | "не продал" | "перезвонит" | "думает",
  "client_interest": "высокий" | "средний" | "низкий",
  "errors": ["ошибка 1", "ошибка 2"],
  "strengths": ["сильная сторона 1"],
  "loss_reason": "причина если не продал или null",
  "recommendation": "конкретный совет менеджеру"
}`);

    const ts = toSeconds(called_at);
    db.run(`INSERT OR REPLACE INTO calls 
      (call_id, manager_name, lead_id, contact_phone, duration, direction, transcript, analysis, called_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [call_id, manager_name, lead_id, contact_phone, duration, direction, transcript, analysis, ts]
    );

    let parsed = null;
    try { parsed = JSON.parse(analysis); } catch(e) {}
    res.json({ ok: true, analysis: parsed });
  } catch (e) {
    console.error('Call webhook error:', e.message);
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
      dateFrom = targetDate;
      dateTo = targetDate;
    } else {
      const d = new Date(targetDate);
      dateFrom = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
      dateTo = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    }

    const tsFrom = Math.floor(new Date(dateFrom).getTime() / 1000);
    const tsTo = Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000);

    console.log(`Audit: ${dateFrom} to ${dateTo} (${tsFrom} - ${tsTo})`);

    // AMO статистика
    let totalLeads = 0;
    try {
      const leadsData = await amoGet(`/leads?filter[created_at][from]=${tsFrom}&filter[created_at][to]=${tsTo}&limit=1`);
      totalLeads = leadsData._total_items || 0;
    } catch(e) {
      console.error('AMO error:', e.message);
    }

    // Звонки из БД
    const calls = await new Promise((resolve) => {
      db.all(`SELECT * FROM calls WHERE called_at >= ? AND called_at <= ? ORDER BY called_at DESC`,
        [tsFrom, tsTo], (err, rows) => resolve(rows || []));
    });

    // Переписки — показываем все что есть в базе за период
    // Также проверяем created_at на случай если timestamp некорректный
    const conversations = await new Promise((resolve) => {
      db.all(`SELECT * FROM conversations 
        WHERE (last_message_at >= ? AND last_message_at <= ?)
           OR (last_message_at = 0)
           OR (created_at >= datetime(?, 'unixepoch') AND created_at <= datetime(?, 'unixepoch'))
        ORDER BY last_message_at DESC`,
        [tsFrom, tsTo, tsFrom, tsTo], (err, rows) => resolve(rows || []));
    });

    console.log(`Found: ${calls.length} calls, ${conversations.length} conversations`);

    // Статистика звонков
    const callStats = { total: calls.length, analyzed: calls.filter(c => c.analysis).length, avgScore: 0, byManager: {} };
    let totalScore = 0, scoredCalls = 0;

    for (const call of calls) {
      if (call.analysis) {
        try {
          const a = JSON.parse(call.analysis);
          totalScore += a.score || 0;
          scoredCalls++;
          const name = call.manager_name || 'Неизвестно';
          if (!callStats.byManager[name]) callStats.byManager[name] = { calls: 0, totalScore: 0, errors: [] };
          callStats.byManager[name].calls++;
          callStats.byManager[name].totalScore += a.score || 0;
          if (a.errors) callStats.byManager[name].errors.push(...a.errors);
        } catch (e) {}
      }
    }

    if (scoredCalls > 0) callStats.avgScore = (totalScore / scoredCalls).toFixed(1);

    const managerSummary = Object.entries(callStats.byManager).map(([name, data]) => ({
      name,
      calls: data.calls,
      avgScore: data.calls > 0 ? (data.totalScore / data.calls).toFixed(1) : 0,
      topErrors: [...new Set(data.errors)].slice(0, 3)
    })).sort((a, b) => b.avgScore - a.avgScore);

    const report = {
      period, dateFrom, dateTo,
      amo: { totalLeads },
      calls: callStats,
      conversations: {
        total: conversations.length,
        analyzed: conversations.filter(c => c.analysis).length
      },
      managerSummary,
      recentCalls: calls.slice(0, 10).map(c => ({
        id: c.call_id, manager: c.manager_name, phone: c.contact_phone,
        duration: c.duration,
        date: new Date(c.called_at * 1000).toLocaleDateString('ru-RU'),
        analysis: c.analysis ? (() => { try { return JSON.parse(c.analysis); } catch(e) { return null; } })() : null
      })),
      recentConversations: conversations.slice(0, 20).map(c => ({
        ...c,
        lastDate: c.last_message_at ? new Date(c.last_message_at * 1000).toLocaleString('ru-RU') : '—'
      }))
    };

    db.run(`INSERT INTO audits (period, date_from, date_to, report) VALUES (?, ?, ?, ?)`,
      [period, dateFrom, dateTo, JSON.stringify(report)]);

    res.json(report);
  } catch (e) {
    console.error('Audit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: ANALYZE CONVERSATION ────────────────────────────────────────────────
app.post('/api/analyze-conversation/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const messages = await new Promise((resolve) => {
      db.all(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`, [chatId],
        (err, rows) => resolve(rows || []));
    });

    if (!messages.length) return res.status(404).json({ error: 'No messages' });

    const transcript = messages.map(m =>
      `${m.direction === 'out' ? 'Менеджер' : 'Клиент'}: ${m.text}`
    ).join('\n');

    const analysis = await claudeAnalyze(`
Ты — аудитор отдела продаж фитнес-клуба Invictus GO (Алматы).
Проанализируй переписку WhatsApp.

ПЕРЕПИСКА:
${transcript}

Ответь ТОЛЬКО в JSON без markdown:
{
  "score": число от 1 до 10,
  "result": "продал" | "не продал" | "перезвонит" | "думает",
  "client_interest": "высокий" | "средний" | "низкий",
  "errors": ["ошибка 1"],
  "strengths": ["сильная сторона 1"],
  "loss_reason": "причина если не продал или null",
  "recommendation": "конкретный совет"
}`);

    db.run(`UPDATE conversations SET analysis = ?, analyzed_at = CURRENT_TIMESTAMP WHERE chat_id = ?`,
      [analysis, chatId]);

    let parsed = null;
    try { parsed = JSON.parse(analysis); } catch(e) {}
    res.json({ ok: true, analysis: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: STATS ───────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [callsCount, convsCount, msgsCount, lastAudit] = await Promise.all([
      new Promise(r => db.get('SELECT COUNT(*) as n FROM calls', (e, row) => r(row?.n || 0))),
      new Promise(r => db.get('SELECT COUNT(*) as n FROM conversations', (e, row) => r(row?.n || 0))),
      new Promise(r => db.get('SELECT COUNT(*) as n FROM messages', (e, row) => r(row?.n || 0))),
      new Promise(r => db.get('SELECT * FROM audits ORDER BY created_at DESC LIMIT 1', (e, row) => r(row)))
    ]);
    res.json({ callsCount, convsCount, msgsCount, lastAudit: lastAudit?.created_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DEBUG: посмотреть сырые данные из БД ─────────────────────────────────────
app.get('/api/debug/conversations', async (req, res) => {
  const rows = await new Promise(r => db.all('SELECT chat_id, contact_name, last_message_at, messages_count, created_at FROM conversations ORDER BY created_at DESC LIMIT 20', (e, rows) => r(rows || [])));
  res.json(rows);
});

app.listen(PORT, () => console.log(`🚀 Invictus Audit на порту ${PORT}`));
