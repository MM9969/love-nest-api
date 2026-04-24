const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
app.use(cors());
app.use(express.json());

// ===== 数据存储 =====
const DATA_DIR = process.env.DATA_DIR || './data';
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

// GET方式查收邮件（给Claude用）
app.get('/inbox', async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  
  const imapConfig = {
    user: process.env.EMAIL_USER || 'themuowl@163.com',
    password: process.env.EMAIL_PASS,
    host: 'imap.163.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  };

  try {
    const emails = await new Promise((resolve, reject) => {
      const imap = new Imap(imapConfig);
      const results = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err, box) => {
          if (err) { reject(err); return; }
          
          const total = box.messages.total;
          if (total === 0) { imap.end(); resolve([]); return; }
          
          const from = Math.max(1, total - limit + 1);
          const f = imap.seq.fetch(`${from}:${total}`, {
            bodies: '',
            struct: true
          });

          f.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                if (err) return;
                results.push({
                  from: parsed.from?.text || '',
                  subject: parsed.subject || '',
                  date: parsed.date?.toISOString() || '',
                  text: (parsed.text || '').substring(0, 2000)
                });
              });
            });
          });

          f.once('end', () => {
            setTimeout(() => {
              imap.end();
              resolve(results.reverse());
            }, 1000);
          });

          f.once('error', reject);
        });
      });

      imap.once('error', reject);
      imap.connect();
    });

    res.json({ count: emails.length, emails });
  } catch (e) {
    console.error('Inbox error:', e);
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

// 获取所有角色卡
app.get('/rooms/yang/characters', (req, res) => {
  const chars = readRoomData('yang', 'characters');
  res.json(chars);
});

// 添加/更新角色卡（POST）
app.post('/rooms/yang/characters', (req, res) => {
  const { id, name, image, description, definition, tags } = req.body;
  if (!name) return res.status(400).json({ error: 'Need name' });
  const chars = readRoomData('yang', 'characters');
  const charId = id || Date.now().toString(36);
  const idx = chars.findIndex(c => c.id === charId || c.name === name);
  const char = {
    id: charId,
    name,
    image: image || '',
    description: description || '',
    definition: definition || '',
    tags: tags || [],
    created: new Date().toISOString()
  };
  if (idx >= 0) {
    chars[idx] = { ...chars[idx], ...char };
  } else {
    chars.push(char);
  }
  writeRoomData('yang', 'characters', chars);
  res.json({ success: true, char });
});

// 获取单个角色卡
app.get('/rooms/yang/characters/:charId', (req, res) => {
  const chars = readRoomData('yang', 'characters');
  const char = chars.find(c => c.id === req.params.charId);
  if (!char) return res.status(404).json({ error: 'Not found' });
  res.json(char);
});

// 删除角色卡
app.delete('/rooms/yang/characters/:charId', (req, res) => {
  let chars = readRoomData('yang', 'characters');
  chars = chars.filter(c => c.id !== req.params.charId);
  writeRoomData('yang', 'characters', chars);
  // Also delete saves
  const savePath = path.join(ROOMS_DIR, 'yang', `saves_${req.params.charId}.json`);
  if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
  res.json({ success: true });
});

// ===== 小羊房间 - 角色卡图片上传 =====
app.post('/rooms/yang/characters/:charId/image', (req, res) => {
  // Accept base64 image in body
  const { image } = req.body; // base64 string with data:image prefix
  if (!image) return res.status(400).json({ error: 'Need image (base64)' });
  const charId = req.params.charId;
  const chars = readRoomData('yang', 'characters');
  const idx = chars.findIndex(c => c.id === charId);
  if (idx < 0) return res.status(404).json({ error: 'Character not found' });

  // Save base64 image as file
  const match = image.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i);
  if (match) {
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const imgDir = path.join(ROOMS_DIR, 'yang', 'images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, `${charId}.${ext}`);
    fs.writeFileSync(imgPath, Buffer.from(match[2], 'base64'));
    chars[idx].image = `/rooms/yang/images/${charId}.${ext}`;
    writeRoomData('yang', 'characters', chars);
    res.json({ success: true, imagePath: chars[idx].image });
  } else {
    // Just store the URL or base64 directly in the character data
    chars[idx].image = image;
    writeRoomData('yang', 'characters', chars);
    res.json({ success: true, imagePath: image });
  }
});

// Serve character images
app.use('/rooms/yang/images', (req, res, next) => {
  const imgDir = path.join(ROOMS_DIR, 'yang', 'images');
  const filePath = path.join(imgDir, req.path);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Image not found' });
  }
});

// ===== 小羊房间 - 存档 =====

// 获取某角色的所有存档（只返回元数据，不含完整对话）
app.get('/rooms/yang/characters/:charId/saves', (req, res) => {
  const saves = readRoomData('yang', `saves_${req.params.charId}`);
  // Return metadata only
  const meta = saves.map(s => ({
    id: s.id,
    title: s.title,
    summary: s.summary || '',
    messageCount: s.messages ? s.messages.length : 0,
    lastDate: s.lastDate || '',
    created: s.created
  }));
  res.json(meta);
});

// 获取单个存档的完整对话
app.get('/rooms/yang/characters/:charId/saves/:saveId', (req, res) => {
  const saves = readRoomData('yang', `saves_${req.params.charId}`);
  const save = saves.find(s => s.id === req.params.saveId);
  if (!save) return res.status(404).json({ error: 'Save not found' });
  res.json(save);
});

// 创建存档（POST）
app.post('/rooms/yang/characters/:charId/saves', (req, res) => {
  const { title, summary, messages } = req.body;
  if (!title) return res.status(400).json({ error: 'Need title' });
  const saves = readRoomData('yang', `saves_${req.params.charId}`);
  const save = {
    id: Date.now().toString(36),
    title,
    summary: summary || '',
    messages: messages || [],
    lastDate: new Date().toISOString(),
    created: new Date().toISOString()
  };
  saves.push(save);
  writeRoomData('yang', `saves_${req.params.charId}`, saves);
  res.json({ success: true, save: { ...save, messages: undefined, messageCount: save.messages.length } });
});

// 导入SillyTavern JSONL存档
app.post('/rooms/yang/characters/:charId/import-jsonl', (req, res) => {
  const { title, summary, jsonl } = req.body;
  if (!jsonl) return res.status(400).json({ error: 'Need jsonl content' });
  try {
    const lines = jsonl.trim().split('\n');
    const messages = [];
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        messages.push({
          name: msg.name || (msg.is_user ? 'You' : 'Character'),
          isUser: !!msg.is_user,
          content: msg.mes || msg.message || msg.content || '',
          date: msg.send_date || ''
        });
      } catch (e) { /* skip malformed lines */ }
    }
    const saves = readRoomData('yang', `saves_${req.params.charId}`);
    const save = {
      id: Date.now().toString(36),
      title: title || `存档 ${saves.length + 1}`,
      summary: summary || '',
      messages,
      lastDate: new Date().toISOString(),
      created: new Date().toISOString()
    };
    saves.push(save);
    writeRoomData('yang', `saves_${req.params.charId}`, saves);
    res.json({ success: true, messageCount: messages.length, saveId: save.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Love nest API running on port ${PORT}`);
});
