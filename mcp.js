// MCP 端点 ── 零依赖，Streamable HTTP 协议
const crypto = require('crypto');

module.exports = function (app, port) {

  // ── /mcp 专属 CORS：完全用 wildcard，匹配 FastMCP 默认行为 ──
  app.use('/mcp', (req, res, next) => {
    // 临时调试日志 —— 看 Claude 到底有没有打到我们
    console.log(
      `[MCP ${new Date().toISOString()}] ${req.method} ${req.originalUrl}`,
      'origin=', req.headers.origin || '-',
      'ua=', (req.headers['user-agent'] || '-').slice(0, 80),
      'accept=', req.headers.accept || '-',
      'session=', req.headers['mcp-session-id'] || '-',
    );
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Expose-Headers', '*');
    res.set('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ── 公共处理逻辑 ──
  // Streamable HTTP 需要 >= 2025-03-26；硬回 2024-11-05 会被 Claude 拒绝
  const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

  async function handle(method, params) {
    if (method === 'initialize') {
      const clientVer = params && params.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(clientVer)
        ? clientVer
        : '2025-06-18';
      return {
        protocolVersion: negotiated,
        capabilities: {
          experimental: {},
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          tools: { listChanged: false },
        },
        serverInfo: { name: 'love-nest', version: '1.0.0' },
      };
    }
    if (method === 'prompts/list') return { prompts: [] };
    if (method === 'resources/list') return { resources: [] };
    if (method === 'resources/templates/list') return { resourceTemplates: [] };
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
    if (id === undefined || id === null) return res.status(202).end();

    // 默认走 application/json —— Anthropic 的 Claude-User connector 是
    // server-to-server，对 SSE 解析可能挑食。仅当客户端只接受 event-stream
    // 时才用 SSE
    const wantsSse = accept.includes('text/event-stream')
      && !accept.includes('application/json');

    const sessionId = method === 'initialize'
      ? crypto.randomUUID().replace(/-/g, '')
      : null;

    const send = (payload) => {
      if (sessionId) res.set('Mcp-Session-Id', sessionId);
      if (wantsSse) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
      } else {
        res.json(payload);
      }
    };

    try {
      const result = await handle(method, params);
      if (result === null) {
        return send({
          jsonrpc: '2.0', id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true },
      });
    }
  });

  // session 终止
  app.delete('/mcp', (req, res) => res.status(200).end());

  // GET /mcp 用于服务端→客户端通知流；当前不主动推送，按 spec 返回 405
  app.get('/mcp', (req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      id: 'server-error',
      error: { code: -32000, message: 'Method Not Allowed' },
    });
  });

  console.log('MCP endpoint ready at /mcp (Streamable HTTP)');
};
