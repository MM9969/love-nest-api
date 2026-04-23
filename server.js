const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

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

// 写留言
app.post('/messages', (req, res) => {
  const { date, role, text, cnTime, usTime } = req.body;

  if (!date || !role || !['girl', 'boy'].includes(role)) {
    return res.status(400).json({ error: 'Invalid request: need date and role (girl/boy)' });
  }

  const messages = readMessages();

  if (!messages[date]) {
    messages[date] = {};
  }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Love nest API running on port ${PORT}`);
});
