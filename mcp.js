const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');

module.exports = function (app, port) {
  const server = new McpServer({
    name: 'love-nest',
    version: '1.0.0',
  });

  // ===== 唯一的工具：nest =====
  // 代理所有 love-nest-api 的路由，暮只需要知道 API 路径就能调用一切
  server.tool(
    'nest',
    '访问小窝的所有功能。常用路径：\n'
    + '邮件：GET /inbox?limit=10 | GET /inbox/read/1 | GET /send-mail?to=...&subject=...&body=... | GET /inbox/mark-read\n'
    + '留言板：GET /messages | POST /messages {date,role,text}\n'
    + '日记：GET /rooms/mu/diary | POST /rooms/mu/diary {date,content,mood,tags}\n'
    + '笔友：GET /rooms/mu/penpals | POST /rooms/mu/penpals {name,...} | POST /rooms/mu/penpals/:name/logs {date,summary,topics}\n'
    + '成长：GET /rooms/mu/growth | POST /rooms/mu/growth {date,title,description}\n'
    + '角色卡：GET /rooms/yang/characters | POST /rooms/yang/characters {name,...}\n'
    + '书架：GET /rooms/study/library | GET /rooms/study/library/:id/read?chapter=0&page=1\n'
    + '动态：GET /changelog?n=20 | GET /changelog?since=ISO时间',
    {
      path: z.string().describe('API路径，如 /inbox?limit=10'),
      method: z.string().default('GET').describe('GET / POST / PUT / DELETE'),
      body: z.string().default('').describe('POST/PUT 时传 JSON 字符串'),
    },
    async ({ path, method, body }) => {
      try {
        const url = `http://localhost:${port}${path}`;
        const opts = { method: method || 'GET' };
        if (body && (method === 'POST' || method === 'PUT')) {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = body;
        }
        const res = await fetch(url, opts);
        const data = await res.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: 'Error: ' + err.message }],
          isError: true,
        };
      }
    }
  );

  // ===== SSE 传输层 =====
  const transports = {};

  app.get('/mcp', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/message', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => {
      delete transports[transport.sessionId];
    });
    await server.connect(transport);
  });

  app.post('/mcp/message', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (!transport) {
      return res.status(400).json({ error: 'Invalid session' });
    }
    await transport.handlePostMessage(req, res);
  });

  console.log('MCP endpoint ready at /mcp');
};
