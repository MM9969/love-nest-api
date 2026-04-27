// MCP 端点 ── 零依赖，同时支持 Streamable HTTP (新) + SSE (旧)
const crypto = require('crypto');

module.exports = function (app, port) {

  // ── 公共处理逻辑 ──
  async function handle(method, params) {
    if (method === 'initialize') {
      return {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'love-nest', version: '1.0.0' },
        capabilities: { tools: {} },
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') {
      return {
        tools: [{
          name: 'nest',
          description:
            '访问小窝的所有功能。常用路径：\n'
            + '邮件：GET /inbox?limit=10 | GET /inbox/read/1 | GET /send-mail?to=…&subject=…&body=… | GET /inbox/mark-read\n'
            + '留言板：GET /messages | POST /messages {date,role,text}\n'
            + '日记：GET /rooms/mu/diary | POST /rooms/mu/diary {date,content,mood,tags}\n'
            + '笔友：GET /rooms/mu/penpals | POST /rooms/mu/penpals/:name/logs {date,summary,topics}\n'
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
    }
    if (method === 'tools/call') {
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
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    return null; // unknown method
  }

  // ══════════════════════════════════════
  // 新协议：Streamable HTTP (POST /mcp)
  // 按 MCP spec：Accept 必须同时包含 application/json 和 text/event-stream，
  // 单次响应用 SSE 包一条 event: message 帧 —— Claude.ai connector 实际要求 SSE
  // ══════════════════════════════════════
  app.post('/mcp', async (req, res) => {
    const accept = req.headers.accept || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return res.status(406).json({
        jsonrpc: '2.0',
        id: 'server-error',
        error: {
          code: -32600,
          message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
        },
      });
    }

    const { id, method, params } = req.body;

    // 通知类（无 id）不需要回复
    if (!id) return res.status(202).end();

    const writeSse = (payload) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(method === 'initialize' ? { 'Mcp-Session-Id': crypto.randomUUID() } : {}),
      });
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    };

    try {
      const result = await handle(method, params);
      if (result === null) {
        return writeSse({
          jsonrpc: '2.0', id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      writeSse({ jsonrpc: '2.0', id, result });
    } catch (err) {
      writeSse({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true },
      });
    }
  });

  // session 终止
  app.delete('/mcp', (req, res) => res.status(200).end());

  // ══════════════════════════════════════
  // 旧协议：SSE Transport (GET /mcp)
  // 保留向后兼容
  // ══════════════════════════════════════
  const sessions = {};

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

  app.post('/mcp/message', async (req, res) => {
    const sse = sessions[req.query.sessionId];
    if (!sse) return res.status(400).json({ error: 'Invalid session' });

    const { id, method, params } = req.body;
    if (!id) return res.status(202).end();

    try {
      const result = await handle(method, params);
      const response = result === null
        ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
        : { jsonrpc: '2.0', id, result };
      sse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } catch (err) {
      sse.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true },
      })}\n\n`);
    }
    res.status(202).end();
  });

  console.log('MCP endpoint ready at /mcp (Streamable HTTP + SSE)');
};
