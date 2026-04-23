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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Love nest API running on port ${PORT}`);
});
