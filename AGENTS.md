# AGENTS.md

Guidance for AI agents working in this repository.

## Project

CocosMCPPlugin is a Cocos Creator 3.8.x editor extension that exposes an HTTP MCP (JSON-RPC 2.0) server on port 3000. See `CLAUDE.md` and `README.md` for architecture and tool details.

## Build (Cloud VM)

```bash
npm install
npm run build    # TypeScript → dist/
npm run watch    # watch mode during development
```

There is no ESLint or automated test suite. **`npm run build` (tsc) is the compile/lint gate.**

Requires Node.js 18+ (Node 22 works). Dependencies are managed with npm (`package-lock.json`).

## Cursor Cloud specific instructions

### What runs in the cloud VM vs on a Creator machine

| Capability | Cloud VM | Cocos Creator 3.8.x |
|---|---|---|
| `npm install` / `npm run build` / `npm run watch` | Yes | Yes |
| Type-check against `@cocos/creator-types` | Yes | Yes |
| Extension load, Editor APIs, scene tools | No | Yes |
| Full E2E MCP against live scenes/assets | No | Yes |

The MCP HTTP server is normally started inside Cocos Creator when the extension loads. For **compile-only verification** in the cloud VM, you can start the compiled `MCPServer` directly with Node (no Creator required):

```bash
node -e "
const { MCPServer } = require('./dist/mcp-server.js');
const server = new MCPServer({
  port: 3000,
  autoStart: false,
  enableDebugLog: true,
  allowedOrigins: ['*'],
  maxConnections: 10
});
server.start();
"
```

Then verify:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/tools
curl -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Tools that call `Editor.*` or scene scripts will fail without Creator; **`validation_*` tools work standalone** and are suitable for smoke tests.

### Services

- **Required for cloud development:** Node.js + npm only.
- **Required for full E2E:** Cocos Creator 3.8.x with a project, extension enabled, and (for most tools) an open scene.
- **Optional:** AI MCP client (Cursor/Claude); use `curl` against `/mcp` or `/api/*` instead.

### Gotchas

- After source changes on a Creator machine, rebuild (`npm run build`) and disable/re-enable the extension in Extension Manager.
- Settings persist under `{project}/settings/mcp-server.json` and `tool-manager.json` when running inside Creator.
- Default bind address is `127.0.0.1:3000`; stop any demo Node process before starting Creator's server on the same port.
