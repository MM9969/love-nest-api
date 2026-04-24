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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Love nest API running on port ${PORT}`);
});
