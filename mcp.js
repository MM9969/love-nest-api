// MCP SSE 端点 ── 零额外依赖，手写协议
const crypto = require('crypto');

module.exports = function (app, port) {
  const sessions = {};

  // ===== SSE 连接入口 =====
  app.get('/mcp', (req, res) => {
    const sid = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: endpoint\ndata: /mcp/message?sessionId=${sid}\n\n`);
    sessions[sid] = res;
    req.on('close', () => delete sessions[sid]);
  });

  // ===== 消息端点 =====
  app.post('/mcp/message', async (req, res) => {
    const sse = sessions[req.query.sessionId];
    if (!sse) return res.status(400).json({ error: 'Invalid session' });

    const { id, method, params } = req.body;
    if (!id) return res.status(202).end();

    let result;
    try {
      if (method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'love-nest', version: '1.0.0' },
          capabilities: { tools: {} },
        };
      } else if (method === 'ping') {
        result = {};
      } else if (method === 'tools/list') {
        result = {
          tools: [{
            name: 'nest',
            description:
              '访问小窝的所有功能。常用路径：\n'
              + '邮件：GET /inbox?limit=10 | GET /inbox/read/1 | GET /send-mail?to=…&subject=…&body=… | GET /inbox/mark-read\n'
              + '留言板：GET /messages | POST /messages {date,role,text}\n'
              + '日记：GET /rooms/mu/diary | POST /rooms/mu/diary {date,content,mood,tags}\n'
              + '笔友：GET /rooms/mu/penpals | POST /rooms/mu/penpals {name,…} | POST /rooms/mu/penpals/:name/logs {date,summary,topics}\n'
              + '成长：GET /rooms/mu/growth | POST /rooms/mu/growth {date,title,description}\n'
              + '角色卡：GET /rooms/yang/characters\n'
              + '书架：GET /rooms/study/library | GET /rooms/study/library/:id/read?chapter=0&page=1\n'
              + '动态：GET /changelog?n=20 | GET /changelog?since=ISO时间',
            inputSchema: {
              type: 'object',
              properties: {
                path:   { type: 'string', description: 'API路径，如 /inbox?limit=10' },
                method: { type: 'string', description: 'GET / POST / PUT / DELETE', default: 'GET' },
                body:   { type: 'string', description: 'POST/PUT 时传 JSON 字符串', default: '' },
              },
              required: ['path'],
            },
          }],
        };
      } else if (method === 'tools/call') {
        const args = (params && params.arguments) || {};
        const httpMethod = args.method || 'GET';
        const url = `http://localhost:${port}${args.path}`;
        const opts = { method: httpMethod };
        if (args.body && (httpMethod === 'POST' || httpMethod === 'PUT')) {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = args.body;
        }
        const apiRes = await fetch(url, opts);
        const data = await apiRes.json();
        result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } else {
        sse.write(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0', id,
          error: { code: -32601, message: 'Method not found' },
        })}\n\n`);
        return res.status(202).end();
      }
    } catch (err) {
      result = { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true };
    }

    sse.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
    res.status(202).end();
  });

  console.log('MCP endpoint ready at /mcp');
};
