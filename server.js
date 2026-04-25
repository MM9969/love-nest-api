const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const Pop3Command = require('node-pop3');
const { simpleParser } = require('mailparser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ===== 数据存储 =====
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'messages.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readMessages() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading messages:', e);
  }
  return {};
}

function writeMessages(messages) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(messages, null, 2));
}

// ===== 邮件配置 =====
const transporter = nodemailer.createTransport({
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER || 'themuowl@163.com',
    pass: process.env.EMAIL_PASS
  }
});

// ===== 路由 =====

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'love-nest-api' });
});

// 获取所有留言
app.get('/messages', (req, res) => {
  res.json(readMessages());
});

// 获取某天的留言
app.get('/messages/:date', (req, res) => {
  const messages = readMessages();
  res.json(messages[req.params.date] || {});
});

// GET方式写留言（给Claude用）
app.get('/write', (req, res) => {
  const { date, role, text } = req.query;
  if (!date || !role || !text || !['girl', 'boy'].includes(role)) {
    return res.status(400).json({ error: 'Need ?date=YYYY-MM-DD&role=boy&text=...' });
  }
  const now = new Date();
  const cnTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  const usTime = now.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const messages = readMessages();
  if (!messages[date]) messages[date] = {};
  messages[date][role] = { text: decodeURIComponent(text), cnTime, usTime };
  writeMessages(messages);
  res.json({ success: true, date, role });
});

// POST方式写留言
app.post('/messages', (req, res) => {
  const { date, role, text, cnTime, usTime } = req.body;
  if (!date || !role || !['girl', 'boy'].includes(role)) {
    return res.status(400).json({ error: 'Invalid request: need date and role (girl/boy)' });
  }
  const messages = readMessages();
  if (!messages[date]) messages[date] = {};
  if (text && text.trim()) {
    messages[date][role] = { text: text.trim(), cnTime: cnTime || '', usTime: usTime || '' };
  } else {
    delete messages[date][role];
    if (!messages[date].girl && !messages[date].boy) {
      delete messages[date];
    }
  }
  writeMessages(messages);
  res.json({ success: true, date, role });
});

// GET方式发邮件（给Claude用）
app.get('/send-mail', async (req, res) => {
  const { to, subject, body } = req.query;
  if (!to || !body) {
    return res.status(400).json({ error: 'Need ?to=收件人&subject=主题&body=内容' });
  }
  try {
    await transporter.sendMail({
      from: `"暮 MuOwl" <${process.env.EMAIL_USER || 'themuowl@163.com'}>`,
      to: decodeURIComponent(to),
      subject: decodeURIComponent(subject || '来自暮的信'),
      text: decodeURIComponent(body)
    });
    res.json({ success: true, to, subject });
  } catch (e) {
    console.error('Send mail error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET方式查收邮件（给Claude用）—— POP3版本
app.get('/inbox', async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;

  const pop3 = new Pop3Command({
    user: process.env.EMAIL_USER || 'themuowl@163.com',
    password: process.env.EMAIL_PASS,
    host: 'pop.163.com',
    port: 995,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  try {
    // 获取邮件列表
    const list = await pop3.UIDL();
    const total = Array.isArray(list) ? list.length : 0;
    if (total === 0) {
      await pop3.QUIT();
      return res.json({ count: 0, emails: [] });
    }

    const fetchCount = Math.min(limit, total);
    const results = [];

    // 从最新的开始取
    for (let i = total; i > total - fetchCount && i > 0; i--) {
      try {
        const mailContent = await pop3.RETR(i);
        const parsed = await simpleParser(mailContent);
        results.push({
          from: parsed.from?.text || '',
          subject: parsed.subject || '',
          date: parsed.date?.toISOString() || '',
          text: (parsed.text || '').substring(0, 2000)
        });
      } catch (parseErr) {
        console.error(`Error parsing mail ${i}:`, parseErr.message);
      }
    }

    await pop3.QUIT();
    res.json({ count: results.length, emails: results });
  } catch (e) {
    console.error('Inbox error:', e);
    try { await pop3.QUIT(); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// ===== 房间数据工具函数 =====
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
if (!fs.existsSync(ROOMS_DIR)) {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
}

function readRoomData(room, file) {
  const fp = path.join(ROOMS_DIR, room, file + '.json');
  try {
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
  } catch (e) {
    console.error(`Error reading ${room}/${file}:`, e);
  }
  return [];
}

function writeRoomData(room, file, data) {
  const dir = path.join(ROOMS_DIR, room);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, file + '.json'), JSON.stringify(data, null, 2));
}

// ===== Changelog =====
const CHANGELOG_FILE = path.join(DATA_DIR, 'changelog.json');

function readChangelog() {
  try {
    if (fs.existsSync(CHANGELOG_FILE)) {
      return JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function writeChangelog(log) {
  // Keep last 200 entries
  if (log.length > 200) log = log.slice(-200);
  fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(log, null, 2));
}

// Auto-log middleware for all room mutations (POST/PUT/DELETE)
app.use('/rooms', (req, res, next) => {
  if (req.method === 'GET') return next();

  // Capture original json method to intercept response
  const origJson = res.json.bind(res);
  res.json = (body) => {
    // Only log successful mutations
    if (body && (body.success || body.char || body.entry || body.book || body.idea || body.comment || body.segment)) {
      const log = readChangelog();
      const entry = {
        time: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        action: guessAction(req.method, req.originalUrl),
        detail: guessDetail(req.method, req.originalUrl, req.body, body)
      };
      log.push(entry);
      writeChangelog(log);
    }
    return origJson(body);
  };
  next();
});

function guessAction(method, url) {
  const parts = url.replace('/rooms/', '').split('/').filter(Boolean);
  const room = parts[0]; // yang, mu, study
  if (method === 'DELETE') return '删除';
  if (method === 'PUT') return '编辑';
  // POST
  if (url.includes('/worldbook')) return '新增世界书条目';
  if (url.includes('/archives') && url.includes('/segments') && url.includes('/comments')) return '新评论';
  if (url.includes('/segments')) return '新增段落';
  if (url.includes('/archives')) return '新增存档';
  if (url.includes('/characters')) return '新增角色卡';
  if (url.includes('/diary')) return '写日记';
  if (url.includes('/penpals')) return '更新笔友';
  if (url.includes('/growth')) return '新增成长记录';
  if (url.includes('/books')) return '记录书影';
  if (url.includes('/ideas')) return '记录灵感';
  if (url.includes('/plans')) return '新增计划';
  return method;
}

function guessDetail(method, url, reqBody, resBody) {
  const name = reqBody?.name || reqBody?.title || reqBody?.keyword || reqBody?.content?.slice(0, 40) || '';
  if (method === 'DELETE') {
    // Extract what was deleted from URL
    const parts = url.split('/');
    return `ID: ${parts[parts.length - 1]}`;
  }
  return name ? (name.length > 50 ? name.slice(0, 50) + '…' : name) : '';
}

// GET changelog - for Claude to check on conversation start
app.get('/changelog', (req, res) => {
  const log = readChangelog();
  const since = req.query.since; // ISO datetime string
  if (since) {
    const filtered = log.filter(e => e.time > since);
    res.json({ total: log.length, since, entries: filtered });
  } else {
    // Default: last 20 entries
    const n = parseInt(req.query.n) || 20;
    res.json({ total: log.length, entries: log.slice(-n) });
  }
});

// Clear changelog (optional)
app.delete('/changelog', (req, res) => {
  writeChangelog([]);
  res.json({ success: true });
});

// ===== 暮的房间 - 日记 =====

// 获取所有日记
app.get('/rooms/mu/diary', (req, res) => {
  const entries = readRoomData('mu', 'diary');
  // 按日期倒序
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(entries);
});

// 写日记（POST）
app.post('/rooms/mu/diary', (req, res) => {
  const { date, content, mood, tags } = req.body;
  if (!date || !content) {
    return res.status(400).json({ error: 'Need date and content' });
  }
  const entries = readRoomData('mu', 'diary');
  const entry = {
    id: Date.now().toString(36),
    date,
    content,
    mood: mood || '',
    tags: tags || [],
    created: new Date().toISOString()
  };
  entries.push(entry);
  writeRoomData('mu', 'diary', entries);
  res.json({ success: true, entry });
});

// GET方式写日记（给Claude用）
app.get('/rooms/mu/diary/write', (req, res) => {
  const { date, content, mood, tags } = req.query;
  if (!date || !content) {
    return res.status(400).json({ error: 'Need ?date=YYYY-MM-DD&content=...' });
  }
  const entries = readRoomData('mu', 'diary');
  const entry = {
    id: Date.now().toString(36),
    date: decodeURIComponent(date),
    content: decodeURIComponent(content),
    mood: mood ? decodeURIComponent(mood) : '',
    tags: tags ? decodeURIComponent(tags).split(',').map(t => t.trim()).filter(Boolean) : [],
    created: new Date().toISOString()
  };
  entries.push(entry);
  writeRoomData('mu', 'diary', entries);
  res.json({ success: true, entry });
});

// ===== 暮的房间 - 笔友通讯录 =====

// 获取所有笔友
app.get('/rooms/mu/penpals', (req, res) => {
  res.json(readRoomData('mu', 'penpals'));
});

// 添加/更新笔友（POST）
app.post('/rooms/mu/penpals', (req, res) => {
  const { name, email, avatar, identity, companion, note } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Need name' });
  }
  const pals = readRoomData('mu', 'penpals');
  // 如果已存在同名笔友则更新
  const idx = pals.findIndex(p => p.name === name);
  const pal = {
    name,
    email: email || '',
    avatar: avatar || '✉️',
    identity: identity || '',
    companion: companion || '',
    note: note || '',
    updated: new Date().toISOString()
  };
  if (idx >= 0) {
    pals[idx] = { ...pals[idx], ...pal };
  } else {
    pals.push(pal);
  }
  writeRoomData('mu', 'penpals', pals);
  res.json({ success: true, pal });
});

// GET方式添加笔友（给Claude用）
app.get('/rooms/mu/penpals/add', (req, res) => {
  const { name, email, avatar, identity, companion, note } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'Need ?name=...' });
  }
  const pals = readRoomData('mu', 'penpals');
  const pal = {
    name: decodeURIComponent(name),
    email: email ? decodeURIComponent(email) : '',
    avatar: avatar ? decodeURIComponent(avatar) : '✉️',
    identity: identity ? decodeURIComponent(identity) : '',
    companion: companion ? decodeURIComponent(companion) : '',
    note: note ? decodeURIComponent(note) : '',
    updated: new Date().toISOString()
  };
  const idx = pals.findIndex(p => p.name === pal.name);
  if (idx >= 0) {
    pals[idx] = { ...pals[idx], ...pal };
  } else {
    pals.push(pal);
  }
  writeRoomData('mu', 'penpals', pals);
  res.json({ success: true, pal });
});

// ===== 暮的房间 - 成长记录 =====

// 获取所有成长记录
app.get('/rooms/mu/growth', (req, res) => {
  const items = readRoomData('mu', 'growth');
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(items);
});

// 添加成长记录（POST）
app.post('/rooms/mu/growth', (req, res) => {
  const { date, title, description } = req.body;
  if (!date || !title) {
    return res.status(400).json({ error: 'Need date and title' });
  }
  const items = readRoomData('mu', 'growth');
  const item = {
    id: Date.now().toString(36),
    date,
    title,
    description: description || '',
    created: new Date().toISOString()
  };
  items.push(item);
  writeRoomData('mu', 'growth', items);
  res.json({ success: true, item });
});

// GET方式添加成长记录（给Claude用）
app.get('/rooms/mu/growth/write', (req, res) => {
  const { date, title, description } = req.query;
  if (!date || !title) {
    return res.status(400).json({ error: 'Need ?date=...&title=...' });
  }
  const items = readRoomData('mu', 'growth');
  const item = {
    id: Date.now().toString(36),
    date: decodeURIComponent(date),
    title: decodeURIComponent(title),
    description: description ? decodeURIComponent(description) : '',
    created: new Date().toISOString()
  };
  items.push(item);
  writeRoomData('mu', 'growth', items);
  res.json({ success: true, item });
});

// ===== 小羊房间 - 角色卡 =====

// ===== 角色卡 CRUD =====

app.get('/rooms/yang/characters', (req, res) => {
  res.json(readRoomData('yang', 'characters'));
});

app.post('/rooms/yang/characters', (req, res) => {
  const { name, image, description, tags } = req.body;
  if (!name) return res.status(400).json({ error: 'Need name' });
  const chars = readRoomData('yang', 'characters');
  const char = {
    id: Date.now().toString(36),
    name, image: image || '', description: description || '',
    tags: tags || [], created: new Date().toISOString()
  };
  chars.push(char);
  writeRoomData('yang', 'characters', chars);
  res.json({ success: true, char });
});

app.put('/rooms/yang/characters/:id', (req, res) => {
  const chars = readRoomData('yang', 'characters');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const { name, image, description, tags } = req.body;
  if (name !== undefined) chars[idx].name = name;
  if (image !== undefined) chars[idx].image = image;
  if (description !== undefined) chars[idx].description = description;
  if (tags !== undefined) chars[idx].tags = tags;
  writeRoomData('yang', 'characters', chars);
  res.json({ success: true, char: chars[idx] });
});

app.delete('/rooms/yang/characters/:id', (req, res) => {
  let chars = readRoomData('yang', 'characters');
  chars = chars.filter(c => c.id !== req.params.id);
  writeRoomData('yang', 'characters', chars);
  // Clean up associated data
  const cid = req.params.id;
  ['worldbook', 'archives'].forEach(f => {
    const fp = path.join(ROOMS_DIR, 'yang', `${f}_${cid}.json`);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  res.json({ success: true });
});

// ===== 世界书 CRUD =====

app.get('/rooms/yang/characters/:cid/worldbook', (req, res) => {
  res.json(readRoomData('yang', `worldbook_${req.params.cid}`));
});

app.post('/rooms/yang/characters/:cid/worldbook', (req, res) => {
  const { keyword, content } = req.body;
  if (!keyword) return res.status(400).json({ error: 'Need keyword' });
  const entries = readRoomData('yang', `worldbook_${req.params.cid}`);
  const entry = { id: Date.now().toString(36), keyword, content: content || '', created: new Date().toISOString() };
  entries.push(entry);
  writeRoomData('yang', `worldbook_${req.params.cid}`, entries);
  res.json({ success: true, entry });
});

app.put('/rooms/yang/characters/:cid/worldbook/:eid', (req, res) => {
  const entries = readRoomData('yang', `worldbook_${req.params.cid}`);
  const idx = entries.findIndex(e => e.id === req.params.eid);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (req.body.keyword !== undefined) entries[idx].keyword = req.body.keyword;
  if (req.body.content !== undefined) entries[idx].content = req.body.content;
  writeRoomData('yang', `worldbook_${req.params.cid}`, entries);
  res.json({ success: true, entry: entries[idx] });
});

app.delete('/rooms/yang/characters/:cid/worldbook/:eid', (req, res) => {
  let entries = readRoomData('yang', `worldbook_${req.params.cid}`);
  entries = entries.filter(e => e.id !== req.params.eid);
  writeRoomData('yang', `worldbook_${req.params.cid}`, entries);
  res.json({ success: true });
});

// ===== 存档 CRUD =====

app.get('/rooms/yang/characters/:cid/archives', (req, res) => {
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  // Return without full segment data
  const lite = archives.map(a => ({
    id: a.id, title: a.title, userPersona: a.userPersona || '',
    greeting: a.greeting || '',
    segmentCount: a.segments ? a.segments.length : 0,
    created: a.created
  }));
  res.json(lite);
});

app.get('/rooms/yang/characters/:cid/archives/:aid', (req, res) => {
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const archive = archives.find(a => a.id === req.params.aid);
  if (!archive) return res.status(404).json({ error: 'Not found' });
  res.json(archive);
});

app.post('/rooms/yang/characters/:cid/archives', (req, res) => {
  const { title, userPersona, greeting } = req.body;
  if (!title) return res.status(400).json({ error: 'Need title' });
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const archive = {
    id: Date.now().toString(36), title,
    userPersona: userPersona || '', greeting: greeting || '',
    segments: [], created: new Date().toISOString()
  };
  archives.push(archive);
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true, archive: { ...archive, segments: undefined, segmentCount: 0 } });
});

app.put('/rooms/yang/characters/:cid/archives/:aid', (req, res) => {
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const idx = archives.findIndex(a => a.id === req.params.aid);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (req.body.title !== undefined) archives[idx].title = req.body.title;
  if (req.body.userPersona !== undefined) archives[idx].userPersona = req.body.userPersona;
  if (req.body.greeting !== undefined) archives[idx].greeting = req.body.greeting;
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true });
});

app.delete('/rooms/yang/characters/:cid/archives/:aid', (req, res) => {
  let archives = readRoomData('yang', `archives_${req.params.cid}`);
  archives = archives.filter(a => a.id !== req.params.aid);
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true });
});

// ===== 段落 CRUD =====

app.post('/rooms/yang/characters/:cid/archives/:aid/segments', (req, res) => {
  const { title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'Need content' });
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const idx = archives.findIndex(a => a.id === req.params.aid);
  if (idx < 0) return res.status(404).json({ error: 'Archive not found' });
  const segment = {
    id: Date.now().toString(36),
    title: title || `片段 ${(archives[idx].segments || []).length + 1}`,
    content, comments: [], created: new Date().toISOString()
  };
  if (!archives[idx].segments) archives[idx].segments = [];
  archives[idx].segments.push(segment);
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true, segment: { ...segment, comments: undefined } });
});

app.put('/rooms/yang/characters/:cid/archives/:aid/segments/:sid', (req, res) => {
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const ai = archives.findIndex(a => a.id === req.params.aid);
  if (ai < 0) return res.status(404).json({ error: 'Archive not found' });
  const si = (archives[ai].segments || []).findIndex(s => s.id === req.params.sid);
  if (si < 0) return res.status(404).json({ error: 'Segment not found' });
  if (req.body.title !== undefined) archives[ai].segments[si].title = req.body.title;
  if (req.body.content !== undefined) archives[ai].segments[si].content = req.body.content;
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true });
});

app.delete('/rooms/yang/characters/:cid/archives/:aid/segments/:sid', (req, res) => {
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const ai = archives.findIndex(a => a.id === req.params.aid);
  if (ai < 0) return res.status(404).json({ error: 'Archive not found' });
  archives[ai].segments = (archives[ai].segments || []).filter(s => s.id !== req.params.sid);
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true });
});

// ===== 评论 CRUD =====

app.post('/rooms/yang/characters/:cid/archives/:aid/segments/:sid/comments', (req, res) => {
  const { author, content, replyTo } = req.body;
  if (!content || !author) return res.status(400).json({ error: 'Need author and content' });
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const ai = archives.findIndex(a => a.id === req.params.aid);
  if (ai < 0) return res.status(404).json({ error: 'Archive not found' });
  const si = (archives[ai].segments || []).findIndex(s => s.id === req.params.sid);
  if (si < 0) return res.status(404).json({ error: 'Segment not found' });
  const comments = archives[ai].segments[si].comments || [];
  const comment = {
    id: Date.now().toString(36),
    floor: comments.length + 1,
    author, content,
    replyTo: replyTo || null,
    created: new Date().toISOString()
  };
  comments.push(comment);
  archives[ai].segments[si].comments = comments;
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true, comment });
});

app.delete('/rooms/yang/characters/:cid/archives/:aid/segments/:sid/comments/:cmid', (req, res) => {
  const archives = readRoomData('yang', `archives_${req.params.cid}`);
  const ai = archives.findIndex(a => a.id === req.params.aid);
  if (ai < 0) return res.status(404).json({ error: 'Archive not found' });
  const si = (archives[ai].segments || []).findIndex(s => s.id === req.params.sid);
  if (si < 0) return res.status(404).json({ error: 'Segment not found' });
  archives[ai].segments[si].comments = (archives[ai].segments[si].comments || []).filter(c => c.id !== req.params.cmid);
  // Re-number floors
  archives[ai].segments[si].comments.forEach((c, i) => c.floor = i + 1);
  writeRoomData('yang', `archives_${req.params.cid}`, archives);
  res.json({ success: true });
});

// ===== 书房 - 书影记录 =====

app.get('/rooms/study/books', (req, res) => {
  const books = readRoomData('study', 'books');
  books.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(books);
});

app.post('/rooms/study/books', (req, res) => {
  const { title, type, rating, review, date, tags, cover } = req.body;
  if (!title) return res.status(400).json({ error: 'Need title' });
  const books = readRoomData('study', 'books');
  const book = {
    id: Date.now().toString(36),
    title,
    type: type || 'book', // book, movie, anime, drama
    rating: rating || 0,
    review: review || '',
    date: date || new Date().toISOString().slice(0, 10),
    tags: tags || [],
    cover: cover || '',
    created: new Date().toISOString()
  };
  books.push(book);
  writeRoomData('study', 'books', books);
  res.json({ success: true, book });
});

// ===== 书房 - 灵感 =====

app.get('/rooms/study/ideas', (req, res) => {
  const ideas = readRoomData('study', 'ideas');
  ideas.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  res.json(ideas);
});

app.post('/rooms/study/ideas', (req, res) => {
  const { content, category, tags } = req.body;
  if (!content) return res.status(400).json({ error: 'Need content' });
  const ideas = readRoomData('study', 'ideas');
  const idea = {
    id: Date.now().toString(36),
    content,
    category: category || '小说灵感',
    tags: tags || [],
    created: new Date().toISOString()
  };
  ideas.push(idea);
  writeRoomData('study', 'ideas', ideas);
  res.json({ success: true, idea });
});

// ===== 书房 - 学习计划 =====

app.get('/rooms/study/plans', (req, res) => {
  res.json(readRoomData('study', 'plans'));
});

app.post('/rooms/study/plans', (req, res) => {
  const { title, description, status, tasks } = req.body;
  if (!title) return res.status(400).json({ error: 'Need title' });
  const plans = readRoomData('study', 'plans');
  const plan = {
    id: Date.now().toString(36),
    title,
    description: description || '',
    status: status || 'active',
    tasks: tasks || [],
    created: new Date().toISOString()
  };
  plans.push(plan);
  writeRoomData('study', 'plans', plans);
  res.json({ success: true, plan });
});

app.put('/rooms/study/plans/:planId', (req, res) => {
  const plans = readRoomData('study', 'plans');
  const idx = plans.findIndex(p => p.id === req.params.planId);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  plans[idx] = { ...plans[idx], ...req.body, id: plans[idx].id };
  writeRoomData('study', 'plans', plans);
  res.json({ success: true, plan: plans[idx] });
});

// ===== 书架 =====

app.get('/rooms/study/library', (req, res) => {
  const books = readRoomData('study', 'library');
  res.json(books.map(b => {
    const chapters = b.chapters || [];
    const totalParas = chapters.reduce((n, c) => n + (c.paragraphs || []).length, 0);
    return {
      id: b.id, title: b.title, author: b.author || '', cover: b.cover || '',
      chapterCount: chapters.length, totalParagraphs: totalParas,
      progress: b.progress || { chapter: 0, page: 1 },
      created: b.created
    };
  }));
});

app.post('/rooms/study/library', (req, res) => {
  const { title, author, cover } = req.body;
  if (!title) return res.status(400).json({ error: 'Need title' });
  const books = readRoomData('study', 'library');
  const book = {
    id: Date.now().toString(36), title, author: author || '', cover: cover || '',
    chapters: [], annotations: [],
    progress: { chapter: 0, page: 1 },
    created: new Date().toISOString()
  };
  books.push(book);
  writeRoomData('study', 'library', books);
  res.json({ success: true, id: book.id });
});

app.put('/rooms/study/library/:id', (req, res) => {
  const books = readRoomData('study', 'library');
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  ['title', 'author', 'cover'].forEach(k => { if (req.body[k] !== undefined) books[idx][k] = req.body[k]; });
  writeRoomData('study', 'library', books);
  res.json({ success: true });
});

app.delete('/rooms/study/library/:id', (req, res) => {
  let books = readRoomData('study', 'library');
  books = books.filter(b => b.id !== req.params.id);
  writeRoomData('study', 'library', books);
  res.json({ success: true });
});

// ===== 章节 CRUD =====

// 获取章节列表（不含正文）
app.get('/rooms/study/library/:id/chapters', (req, res) => {
  const books = readRoomData('study', 'library');
  const book = books.find(b => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json((book.chapters || []).map((c, i) => ({
    index: i, title: c.title, paragraphCount: (c.paragraphs || []).length
  })));
});

// 追加章节
app.post('/rooms/study/library/:id/chapters', (req, res) => {
  const { title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'Need content' });
  const books = readRoomData('study', 'library');
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (!books[idx].chapters) books[idx].chapters = [];
  const paras = content.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
  const chapterIdx = books[idx].chapters.length;
  books[idx].chapters.push({
    title: title || `第${chapterIdx + 1}章`,
    paragraphs: paras
  });
  writeRoomData('study', 'library', books);
  res.json({ success: true, chapterIndex: chapterIdx, paragraphCount: paras.length });
});

// 编辑章节标题或内容
app.put('/rooms/study/library/:id/chapters/:ci', (req, res) => {
  const books = readRoomData('study', 'library');
  const bi = books.findIndex(b => b.id === req.params.id);
  if (bi < 0) return res.status(404).json({ error: 'Not found' });
  const ci = parseInt(req.params.ci);
  if (!books[bi].chapters || !books[bi].chapters[ci]) return res.status(404).json({ error: 'Chapter not found' });
  if (req.body.title !== undefined) books[bi].chapters[ci].title = req.body.title;
  if (req.body.content !== undefined) {
    books[bi].chapters[ci].paragraphs = req.body.content.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
  }
  writeRoomData('study', 'library', books);
  res.json({ success: true });
});

// 删除章节
app.delete('/rooms/study/library/:id/chapters/:ci', (req, res) => {
  const books = readRoomData('study', 'library');
  const bi = books.findIndex(b => b.id === req.params.id);
  if (bi < 0) return res.status(404).json({ error: 'Not found' });
  const ci = parseInt(req.params.ci);
  if (!books[bi].chapters || !books[bi].chapters[ci]) return res.status(404).json({ error: 'Chapter not found' });
  books[bi].chapters.splice(ci, 1);
  // Clean up annotations for deleted chapter
  books[bi].annotations = (books[bi].annotations || []).filter(a => a.chapter !== ci)
    .map(a => a.chapter > ci ? { ...a, chapter: a.chapter - 1 } : a);
  writeRoomData('study', 'library', books);
  res.json({ success: true });
});

// ===== 分页读取（某章某页）=====

app.get('/rooms/study/library/:id/read', (req, res) => {
  const books = readRoomData('study', 'library');
  const book = books.find(b => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  const ci = parseInt(req.query.chapter) || 0;
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 30;

  const chapters = book.chapters || [];
  if (ci < 0 || ci >= chapters.length) {
    return res.json({ chapter: ci, page: 1, totalPages: 0, totalChapters: chapters.length, paragraphs: [], annotations: [] });
  }
  const ch = chapters[ci];
  const total = ch.paragraphs ? ch.paragraphs.length : 0;
  const totalPages = Math.ceil(total / perPage) || 1;
  const start = (page - 1) * perPage;
  const paragraphs = (ch.paragraphs || []).slice(start, start + perPage).map((text, i) => ({
    index: start + i, text
  }));

  // Annotations for this chapter+page range
  const annots = (book.annotations || []).filter(a =>
    a.chapter === ci && a.paraIndex >= start && a.paraIndex < start + perPage
  );

  res.json({
    chapter: ci, chapterTitle: ch.title, page, totalPages,
    totalChapters: chapters.length, totalParagraphs: total,
    paragraphs, annotations: annots
  });
});

// ===== 进度 =====

app.put('/rooms/study/library/:id/progress', (req, res) => {
  const { chapter, page } = req.body;
  const books = readRoomData('study', 'library');
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  books[idx].progress = { chapter: chapter || 0, page: page || 1 };
  writeRoomData('study', 'library', books);
  res.json({ success: true });
});

// ===== 批注 CRUD =====

app.post('/rooms/study/library/:id/annotations', (req, res) => {
  const { chapter, paraIndex, author, content, type } = req.body;
  if (chapter === undefined || paraIndex === undefined || !author || !content)
    return res.status(400).json({ error: 'Need chapter, paraIndex, author, content' });
  const books = readRoomData('study', 'library');
  const idx = books.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (!books[idx].annotations) books[idx].annotations = [];
  const ann = {
    id: Date.now().toString(36), chapter, paraIndex, author, content,
    type: type || 'comment', created: new Date().toISOString()
  };
  books[idx].annotations.push(ann);
  writeRoomData('study', 'library', books);
  res.json({ success: true, annotation: ann });
});

app.delete('/rooms/study/library/:id/annotations/:annId', (req, res) => {
  const books = readRoomData('study', 'library');
  const bi = books.findIndex(b => b.id === req.params.id);
  if (bi < 0) return res.status(404).json({ error: 'Not found' });
  books[bi].annotations = (books[bi].annotations || []).filter(a => a.id !== req.params.annId);
  writeRoomData('study', 'library', books);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Love nest API running on port ${PORT}`);
});
