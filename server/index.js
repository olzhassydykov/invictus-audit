const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const AMO_TOKEN     = (process.env.AMO_TOKEN || '').trim();
const AMO_DOMAIN    = process.env.AMO_DOMAIN || 'invictusgo.amocrm.ru';
const ANTHROPIC_KEY = (process.env.ANTHROPIC_KEY || '').trim();
const GROQ_KEY      = process.env.GROQ_KEY || '';
const WAZZUP_KEY    = process.env.WAZZUP_KEY;
const CALLS_BASE_URL = 'https://op.entryx.io/amo/monitor';
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY, chat_id TEXT, wazzup_message_id TEXT UNIQUE,
    channel_id TEXT, contact_name TEXT, contact_phone TEXT, manager_name TEXT,
    lead_id TEXT, direction TEXT, text TEXT, timestamp BIGINT,
    created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY, chat_id TEXT UNIQUE, lead_id TEXT, manager_name TEXT,
    contact_name TEXT, contact_phone TEXT, last_message_at BIGINT,
    messages_count INTEGER DEFAULT 0, analysis TEXT, analyzed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY, call_id TEXT UNIQUE, manager_name TEXT, lead_id TEXT,
    contact_phone TEXT, duration INTEGER, direction TEXT, file_url TEXT,
    transcript TEXT, analysis TEXT, called_at BIGINT,
    created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audits (
    id SERIAL PRIMARY KEY, period TEXT, date_from TEXT, date_to TEXT,
    report TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  console.log('PostgreSQL ready');
}
initDB().catch(e => console.error('DB init error:', e.message));

const MANAGERS = {
  '2044417':'Танеке','2150484':'Айгерим','7158001':'Администратор',
  '7207546':'Акжол','7270360':'Дильназ','7616848':'Гания','7616944':'Дайана',
  '7617028':'Фуад','7617046':'Илья','7617088':'Никита','7617100':'Диана',
  '8945498':'Navoi','8945674':'Айгера','8945678':'Айдай','9473638':'Милана',
  '10158750':'Айдана','10757002':'Алишер','10920190':'Аятолла','11028126':'Дамир',
  '11179978':'Есей','11237754':'Жасулан','11252562':'Каракат','11428894':'Гульден',
  '12062466':'Дильнара','12062502':'Амина','13526610':'Александр','13526650':'Айдана2',
  '13529206':'Диана2','13552546':'Диас','13565310':'Назир','13586134':'Есей2'
};

const JUNK = ['редактор субтитров','dimatorzok','субтитры делал','субтитры добавил',
  'продолжение следует','все линии заняты','абонент не может ответить',
  'пока абонент не отвечает','вызываемый абонент','телефонный звонок',
  'до новых встреч','спасибо за субтитры','оставьте голосовое',
  'дубровск','синецкая','егорова','тorzok'];

function isJunk(text) {
  if (!text || text.length < 30) return true;
  const t = text.toLowerCase();
  return JUNK.some(j => t.includes(j));
}

function toSeconds(ts) {
  if (!ts) return Math.floor(Date.now()/1000);
  return ts > 9999999999 ? Math.floor(ts/1000) : ts;
}

async function amoGet(p) {
  const res = await axios.get(`https://${AMO_DOMAIN}/api/v4${p}`,
    { headers: { Authorization: `Bearer ${AMO_TOKEN}` }, timeout: 15000 });
  return res.data;
}

async function claudeAnalyze(prompt) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514', max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    timeout: 30000
  });
  return res.data.content[0].text;
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
      const ts = toSeconds(dateTime ? Math.floor(new Date(dateTime).getTime()/1000) : null);
      let managerName = null;
      if (isEcho && authorId) managerName = MANAGERS[String(authorId)] || authorName || null;
      await pool.query(
        `INSERT INTO messages (chat_id,wazzup_message_id,channel_id,contact_name,contact_phone,manager_name,direction,text,timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (wazzup_message_id) DO NOTHING`,
        [chatId,messageId,channelId,contactName,contactPhone,managerName,direction,text.trim(),ts]);
      await pool.query(`
        INSERT INTO conversations (chat_id,contact_name,contact_phone,manager_name,last_message_at,messages_count)
        VALUES ($1,$2,$3,$4,$5,1)
        ON CONFLICT (chat_id) DO UPDATE SET
          last_message_at=EXCLUDED.last_message_at, messages_count=conversations.messages_count+1,
          contact_name=EXCLUDED.contact_name, manager_name=COALESCE(EXCLUDED.manager_name,conversations.manager_name)`,
        [chatId,contactName,contactPhone,managerName,ts]);
    }
    res.json({ ok: true });
  } catch(e) { console.error('Webhook error:', e.message); res.json({ ok: true }); }
});

// ─── WEBHOOK: CALL (от MacBook агента) ───────────────────────────────────────
app.post('/webhook/call', async (req, res) => {
  // Просто сохраняем транскрипцию — анализ делается отдельно через /api/analyze-all
  // Это исключает таймауты Anthropic API при массовой загрузке звонков
  try {
    const { call_id, contact_phone, direction, transcript, called_at, file_url } = req.body;
    if (!transcript || !call_id) return res.status(400).json({ error: 'Missing fields' });

    const ts = toSeconds(called_at ? Number(called_at) : null);

    if (isJunk(transcript)) {
      await pool.query(
        `INSERT INTO calls (call_id,contact_phone,direction,transcript,called_at,file_url)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (call_id) DO NOTHING`,
        [call_id, contact_phone||'unknown', direction||'out', '[мусор]', ts, file_url||null]);
      return res.json({ ok: true, skipped: true });
    }

    // Сохраняем транскрипцию без анализа — анализ придёт позже
    await pool.query(`
      INSERT INTO calls (call_id,contact_phone,direction,transcript,called_at,file_url)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (call_id) DO UPDATE SET transcript=$4,called_at=$5,file_url=$6`,
      [call_id, contact_phone||'unknown', direction||'out', transcript, ts, file_url||null]);

    res.json({ ok: true, saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API: SYNC CALLS ──────────────────────────────────────────────────────────
app.post('/api/sync-calls', async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const [year, month, day] = date.split('-');
    const url = `${CALLS_BASE_URL}/${year}/${month}/${day}/`;
    const html = (await axios.get(url, { timeout: 15000 })).data;
    const matches = [...html.matchAll(/href="([^"]+\.wav)"/g)];
    const files = matches.map(m=>m[1]).filter(f=>
      !f.startsWith('?')&&!f.startsWith('/')&&!f.includes('__tmp__')&&
      !f.endsWith('-in.wav')&&!f.endsWith('-out.wav'));

    let synced=0, skipped=0;
    for (const filename of files) {
      const parts = filename.replace('.wav','').split('-');
      const direction = parts[0];
      let phone=null, callId=null, calledAt=0;
      for (let i=0;i<parts.length;i++) {
        if (/^\d{8}$/.test(parts[i])) {
          if (i+2<parts.length) callId=parts.slice(i+2).join('-');
          if (i+1<parts.length && /^\d{6}$/.test(parts[i+1])) {
            try {
              const d=parts[i],t=parts[i+1];
              calledAt=Math.floor(new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}+05:00`).getTime()/1000);
            } catch(e){}
          }
          break;
        }
        if (parts[i].startsWith('+')||/^7\d{9,10}$/.test(parts[i])) phone=parts[i];
      }
      if (!callId) callId=filename;
      const fileUrl=`${CALLS_BASE_URL}/${year}/${month}/${day}/${filename}`;
      try {
        const r = await pool.query(
          `INSERT INTO calls (call_id,contact_phone,direction,file_url,called_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (call_id) DO NOTHING`,
          [callId,phone||'unknown',direction,fileUrl,calledAt]);
        if (r.rowCount>0) synced++; else skipped++;
      } catch(e) { skipped++; }
    }
    res.json({ ok:true, total:files.length, synced, skipped });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API: ANALYZE ALL ─────────────────────────────────────────────────────────
app.post('/api/analyze-all', async (req, res) => {
  try {
    // Приоритизируем дату если передана, иначе берём самые свежие
    const targetDate = (req.body && req.body.date) || req.query.date || null;
    let convRows, callRows;
    if (targetDate) {
      const tsFrom = Math.floor(new Date(targetDate).getTime()/1000);
      const tsTo   = Math.floor(new Date(targetDate+'T23:59:59').getTime()/1000);
      const { rows: cr } = await pool.query(
        `SELECT * FROM conversations WHERE analysis IS NULL AND messages_count>0
          AND last_message_at>= AND last_message_at<=
          ORDER BY last_message_at DESC LIMIT 25`, [tsFrom, tsTo]);
      const { rows: lr } = await pool.query(
        `SELECT * FROM calls WHERE analysis IS NULL AND transcript IS NOT NULL AND transcript != '[мусор]'
          AND called_at>= AND called_at<=
          ORDER BY called_at DESC LIMIT 25`, [tsFrom, tsTo]);
      // Если за эту дату уже всё — берём любые непроанализированные
      if (!cr.length && !lr.length) {
        const { rows: cr2 } = await pool.query(`SELECT * FROM conversations WHERE analysis IS NULL AND messages_count>0 ORDER BY last_message_at DESC LIMIT 25`);
        const { rows: lr2 } = await pool.query(`SELECT * FROM calls WHERE analysis IS NULL AND transcript IS NOT NULL AND transcript != '[мусор]' ORDER BY called_at DESC LIMIT 25`);
        convRows = cr2; callRows = lr2;
      } else { convRows = cr; callRows = lr; }
    } else {
      const { rows: cr } = await pool.query(`SELECT * FROM conversations WHERE analysis IS NULL AND messages_count>0 ORDER BY last_message_at DESC LIMIT 25`);
      const { rows: lr } = await pool.query(`SELECT * FROM calls WHERE analysis IS NULL AND transcript IS NOT NULL AND transcript != '[мусор]' ORDER BY called_at DESC LIMIT 25`);
      convRows = cr; callRows = lr;
    }

    const total = convRows.length + callRows.length;
    if (!total) return res.json({ ok:true, total:0, message:'Все уже проанализированы' });

    res.json({ ok:true, total, message:`Анализируем ${convRows.length} переписок + ${callRows.length} звонков...` });

    (async()=>{
      // Анализируем переписки
      for (const conv of convRows) {
        try {
          const { rows: msgs } = await pool.query(
            `SELECT * FROM messages WHERE chat_id=$1 ORDER BY timestamp ASC`,[conv.chat_id]);
          if (!msgs.length) continue;
          const transcript = msgs.map(m=>`${m.direction==='out'?(m.manager_name||'Менеджер'):'Клиент'}: ${m.text}`).join('\n');
          const mgr = conv.manager_name || msgs.find(m=>m.direction==='out'&&m.manager_name)?.manager_name || 'Неизвестно';
          const analysis = await claudeAnalyze(`
Ты — аудитор отдела продаж фитнес-клуба Invictus GO (Алматы).
Менеджер: ${mgr}, Клиент: ${conv.contact_name}
ПЕРЕПИСКА WhatsApp:
${transcript.slice(0,4000)}
Ответь ТОЛЬКО в JSON без markdown:
{"score":5,"result":"продал","client_interest":"средний","errors":["ошибка"],"strengths":["плюс"],"loss_reason":null,"recommendation":"совет"}`);
          await pool.query(`UPDATE conversations SET analysis=$1,analyzed_at=NOW() WHERE chat_id=$2`,[analysis,conv.chat_id]);
          await new Promise(r=>setTimeout(r,300));
        } catch(e) { console.error('Conv analysis error:',e.message); }
      }

      // Анализируем звонки
      for (const call of callRows) {
        try {
          const direction = call.direction==='in' ? 'входящий' : 'исходящий';
          const analysis = await claudeAnalyze(`
Ты — аудитор отдела продаж фитнес-клуба Invictus GO (Алматы).
Тип: ${direction} звонок. Клиент: ${call.contact_phone}
ТРАНСКРИПЦИЯ:
${(call.transcript||'').slice(0,4000)}
Ответь ТОЛЬКО в JSON без markdown:
{"score":5,"result":"не продал","manager_name":"Имя менеджера из транскрипции","client_interest":"средний","errors":["ошибка"],"strengths":["плюс"],"loss_reason":null,"recommendation":"совет"}`);
          let mgr = call.manager_name;
          try { const p=JSON.parse(analysis); if(!mgr&&p.manager_name) mgr=p.manager_name; } catch(e){}
          await pool.query(
            `UPDATE calls SET analysis=$1,manager_name=COALESCE(manager_name,$2) WHERE call_id=$3`,
            [analysis, mgr, call.call_id]);
          await new Promise(r=>setTimeout(r,300));
        } catch(e) { console.error('Call analysis error:',e.message); }
      }
    })();
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── API: AUDIT ───────────────────────────────────────────────────────────────
app.get('/api/audit', async (req, res) => {
  try {
    const { period='day', date } = req.query;
    const target = date || new Date().toISOString().split('T')[0];
    let dateFrom, dateTo;
    if (period==='day') { dateFrom=target; dateTo=target; }
    else {
      const d=new Date(target);
      dateFrom=new Date(d.getFullYear(),d.getMonth(),1).toISOString().split('T')[0];
      dateTo=new Date(d.getFullYear(),d.getMonth()+1,0).toISOString().split('T')[0];
    }
    const tsFrom=Math.floor(new Date(dateFrom).getTime()/1000);
    const tsTo=Math.floor(new Date(dateTo+'T23:59:59').getTime()/1000);

    let totalLeads=0;
    try { const d=await amoGet(`/leads?filter[created_at][from]=${tsFrom}&filter[created_at][to]=${tsTo}&limit=1`); totalLeads=d._total_items||0; } catch(e){}

    const { rows: calls } = await pool.query(`SELECT * FROM calls WHERE called_at>=$1 AND called_at<=$2 ORDER BY called_at DESC`,[tsFrom,tsTo]);
    const { rows: conversations } = await pool.query(`SELECT * FROM conversations WHERE last_message_at>=$1 AND last_message_at<=$2 ORDER BY last_message_at DESC`,[tsFrom,tsTo]);

    const analyzedCalls = calls.filter(c=>c.analysis);
    let avgScore=0;
    if (analyzedCalls.length) {
      const scores=analyzedCalls.map(c=>{try{return JSON.parse(c.analysis).score||0;}catch(e){return 0;}});
      avgScore=(scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1);
    }

    res.json({
      period, dateFrom, dateTo,
      amo: { totalLeads },
      calls: { total:calls.length, analyzed:analyzedCalls.length, avgScore,
               withTranscript:calls.filter(c=>c.transcript&&c.transcript!=='[мусор]').length },
      conversations: { total:conversations.length, analyzed:conversations.filter(c=>c.analysis).length },
      recentCalls: calls.slice(0,15).map(c=>({
        id:c.call_id, manager:c.manager_name, phone:c.contact_phone,
        duration:c.duration, direction:c.direction,
        date:new Date(Number(c.called_at)*1000).toLocaleString('ru-RU'),
        hasTranscript:!!c.transcript&&c.transcript!=='[мусор]',
        analysis:c.analysis?(()=>{try{return JSON.parse(c.analysis);}catch(e){return null;}})():null
      })),
      recentConversations: conversations.slice(0,30).map(c=>({
        ...c, lastDate:c.last_message_at?new Date(Number(c.last_message_at)*1000).toLocaleString('ru-RU'):'—'
      }))
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── API: MANAGER REPORT ──────────────────────────────────────────────────────
app.get('/api/manager-report', async (req, res) => {
  try {
    const { rows: convs } = await pool.query(`SELECT * FROM conversations WHERE analysis IS NOT NULL`);
    const { rows: calls } = await pool.query(`SELECT * FROM calls WHERE analysis IS NOT NULL`);
    const managers = {};
    const add = (name, item, type) => {
      if (!managers[name]) managers[name]={name,convs:[],calls:[],scores:[],errors:[],strengths:[],recommendations:[]};
      try {
        const a=JSON.parse(item.analysis);
        managers[name][type].push(a);
        if (a.score) managers[name].scores.push(a.score);
        if (a.errors) managers[name].errors.push(...a.errors);
        if (a.strengths) managers[name].strengths.push(...a.strengths);
        if (a.recommendation) managers[name].recommendations.push(a.recommendation);
      } catch(e){}
    };
    convs.forEach(c=>add(c.manager_name||'Неизвестно',c,'convs'));
    calls.forEach(c=>add(c.manager_name||'Неизвестно',c,'calls'));
    const report = Object.values(managers).map(m=>{
      const all=[...m.convs,...m.calls];
      const avg=m.scores.length?(m.scores.reduce((a,b)=>a+b,0)/m.scores.length).toFixed(1):0;
      const ec={};m.errors.forEach(e=>ec[e]=(ec[e]||0)+1);
      const sc={};m.strengths.forEach(s=>sc[s]=(sc[s]||0)+1);
      return {
        name:m.name, totalInteractions:all.length, convs:m.convs.length, calls:m.calls.length,
        avgScore:Number(avg),
        topErrors:Object.entries(ec).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([e])=>e),
        topStrengths:Object.entries(sc).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s])=>s),
        lastRecommendation:m.recommendations[m.recommendations.length-1]||null,
        results:{
          sold:all.filter(x=>x.result==='продал').length,
          lost:all.filter(x=>x.result==='не продал').length,
          pending:all.filter(x=>['перезвонит','думает'].includes(x.result)).length,
        }
      };
    }).sort((a,b)=>b.avgScore-a.avgScore);
    res.json({ managers:report, totalConvs:convs.length, totalCalls:calls.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── API: STATS ───────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [c1,c2,c3,c4,c5,c6] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM calls'),
      pool.query('SELECT COUNT(*) FROM conversations'),
      pool.query('SELECT COUNT(*) FROM messages'),
      pool.query('SELECT COUNT(*) FROM conversations WHERE analysis IS NOT NULL'),
      pool.query('SELECT COUNT(*) FROM calls WHERE analysis IS NOT NULL'),
      pool.query("SELECT COUNT(*) FROM calls WHERE transcript IS NOT NULL AND transcript != '[мусор]'"),
    ]);
    res.json({
      callsCount:parseInt(c1.rows[0].count), convsCount:parseInt(c2.rows[0].count),
      msgsCount:parseInt(c3.rows[0].count), analyzedConvs:parseInt(c4.rows[0].count),
      analyzedCalls:parseInt(c5.rows[0].count), withTranscript:parseInt(c6.rows[0].count),
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/debug/conversations', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT chat_id,contact_name,manager_name,last_message_at,messages_count,analysis,created_at FROM conversations ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// ─── API: FULL EXPORT (все данные за период) ──────────────────────────────────
app.get('/api/export', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    let callsQuery, convsQuery, params;

    if (date_from && date_to) {
      const tsFrom = Math.floor(new Date(date_from).getTime()/1000);
      const tsTo   = Math.floor(new Date(date_to+'T23:59:59').getTime()/1000);
      callsQuery = `SELECT * FROM calls WHERE called_at>=$1 AND called_at<=$2 AND analysis IS NOT NULL ORDER BY called_at DESC`;
      convsQuery = `SELECT * FROM conversations WHERE last_message_at>=$1 AND last_message_at<=$2 AND analysis IS NOT NULL ORDER BY last_message_at DESC`;
      params = [tsFrom, tsTo];
    } else {
      callsQuery = `SELECT * FROM calls WHERE analysis IS NOT NULL ORDER BY called_at DESC`;
      convsQuery = `SELECT * FROM conversations WHERE analysis IS NOT NULL ORDER BY last_message_at DESC`;
      params = [];
    }

    const { rows: calls } = await pool.query(callsQuery, params);
    const { rows: convs } = await pool.query(convsQuery, params);

    // Группируем по менеджерам
    const managers = {};
    const addItem = (name, item, type) => {
      if (!name) name = 'Неизвестно';
      if (!managers[name]) managers[name] = { name, calls:[], convs:[] };
      try {
        const a = JSON.parse(item.analysis);
        managers[name][type].push({ ...item, parsed: a });
      } catch(e) {}
    };

    calls.forEach(c => addItem(c.manager_name, c, 'calls'));
    convs.forEach(c => addItem(c.manager_name, c, 'convs'));

    // Считаем итоги по каждому менеджеру
    const report = Object.values(managers).map(m => {
      const allItems = [...m.calls.map(c=>c.parsed), ...m.convs.map(c=>c.parsed)];
      const scores = allItems.map(a=>a.score||0).filter(s=>s>0);
      const avgScore = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) : 0;
      const sold    = allItems.filter(a=>a.result==='продал').length;
      const lost    = allItems.filter(a=>a.result==='не продал').length;
      const pending = allItems.filter(a=>['перезвонит','думает'].includes(a.result)).length;

      // Топ ошибок
      const errCount = {};
      allItems.forEach(a => (a.errors||[]).forEach(e => errCount[e]=(errCount[e]||0)+1));
      const topErrors = Object.entries(errCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([e,n])=>({text:e,count:n}));

      // Топ сильных сторон
      const strCount = {};
      allItems.forEach(a => (a.strengths||[]).forEach(s => strCount[s]=(strCount[s]||0)+1));
      const topStrengths = Object.entries(strCount).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,n])=>({text:s,count:n}));

      return {
        name: m.name,
        callsCount: m.calls.length,
        convsCount: m.convs.length,
        totalCount: allItems.length,
        avgScore: Number(avgScore),
        sold, lost, pending,
        convRate: allItems.length ? Math.round(sold/allItems.length*100) : 0,
        topErrors, topStrengths,
        calls: m.calls.map(c => ({
          call_id: c.call_id,
          phone: c.contact_phone,
          direction: c.direction,
          called_at: c.called_at,
          transcript: c.transcript,
          score: c.parsed?.score,
          result: c.parsed?.result,
          errors: c.parsed?.errors,
          strengths: c.parsed?.strengths,
          recommendation: c.parsed?.recommendation,
          loss_reason: c.parsed?.loss_reason,
        })),
        convs: m.convs.map(c => ({
          chat_id: c.chat_id,
          contact: c.contact_name || c.contact_phone,
          messages_count: c.messages_count,
          last_message_at: c.last_message_at,
          score: c.parsed?.score,
          result: c.parsed?.result,
          errors: c.parsed?.errors,
          strengths: c.parsed?.strengths,
          recommendation: c.parsed?.recommendation,
          loss_reason: c.parsed?.loss_reason,
        })),
      };
    }).sort((a,b) => b.avgScore - a.avgScore);

    res.json({
      generated_at: new Date().toISOString(),
      date_from: date_from || 'все время',
      date_to: date_to || 'все время',
      total_calls: calls.length,
      total_convs: convs.length,
      managers: report,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API: ЛУЧШИЙ И ХУДШИЙ ЗВОНОК ──────────────────────────────────────────────
app.get('/api/best-worst-calls', async (req, res) => {
  try {
    const { rows: best } = await pool.query(
      `SELECT call_id, contact_phone, direction, manager_name, called_at, transcript, analysis
       FROM calls WHERE analysis IS NOT NULL AND transcript IS NOT NULL
       ORDER BY (analysis::json->>'score')::float DESC NULLS LAST LIMIT 1`
    );
    const { rows: worst } = await pool.query(
      `SELECT call_id, contact_phone, direction, manager_name, called_at, transcript, analysis
       FROM calls WHERE analysis IS NOT NULL AND transcript IS NOT NULL
       AND length(transcript) > 500
       ORDER BY (analysis::json->>'score')::float ASC NULLS LAST LIMIT 1`
    );
    res.json({ best: best[0] || null, worst: worst[0] || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, ()=>console.log(`Invictus Audit port ${PORT}`));
