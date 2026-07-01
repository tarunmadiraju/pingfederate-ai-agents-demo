/**
 * Workforce AI Agent Server
 *
 * Express server that exposes the AG-UI protocol to the Workforce Portal
 * and acts as an MCP Client to downstream MCP servers (expense-mcp,
 * travel-mcp). Endpoints:
 *
 *   POST /api/agent/run                       — RunAgentInput → AG-UI SSE event stream
 *                                               (carries `resume[]` for AG-UI Interrupts)
 *   GET  /api/agent/resource?uri=...          — Proxy a downstream MCP resource
 *   GET  /api/health                          — Health + active-run count
 *
 * On each inbound request:
 * 1. Envoy receives the request and calls the Authn Sidecar (ext_proc)
 * 2. The sidecar moves the subject token to X-Subject-Token and injects a
 *    SPIFFE JWT-SVID as the Authorization: Bearer header (actor identity)
 * 3. The AG-UI run handler streams events back to the portal as the
 *    keyword/LLM router executes downstream MCP tools.
 *
 * Outbound MCP requests are intercepted by iptables → Envoy.
 * CIBA-capable hosts are routed to the CIBA proxy for step-up authorization.
 *
 * Routing modes (switchable at runtime via `/mode` chat command):
 *   - keyword: deterministic keyword matching (default)
 *   - llm:     ReAct loop with token streaming via Ollama
 */

import express from 'express';
import config from './config.js';
import { readMcpResource } from './mcpClient.js';
import { routerState } from './routerState.js';
import { runHandler, activeRuns } from './agui/runHandler.js';
import { extractAuth } from './agui/auth.js';

const app = express();

const ALLOWED_ORIGINS = new Set(
    (process.env.ALLOWED_ORIGINS || 'https://portal-external.localhost').split(',').map(s => s.trim())
);

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

/**
 * Validate that the request Origin (when present) is allow-listed.
 * DNS-rebinding protection (per MCP spec §5.4.14, applied here for AG-UI).
 */
function checkOrigin(req, res) {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
        console.warn(`[AG-UI] Rejected request from disallowed origin: ${origin}`);
        res.status(403).json({ error: 'Forbidden: origin not allowed' });
        return false;
    }
    return true;
}

// =============================================================================
// Health
// =============================================================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'workforce-ai-agent',
        timestamp: new Date().toISOString(),
        config: {
            mcpServers: Object.fromEntries(
                Object.entries(config.mcpServers).map(([key, srv]) => [key, { type: srv.type, url: srv.url }])
            ),
            routingMode: routerState.mode
        },
        agui: {
            activeRuns: activeRuns.size
        }
    });
});

// =============================================================================
// AG-UI endpoints
// =============================================================================

/**
 * POST /api/agent/run — accept RunAgentInput, stream AG-UI events via SSE.
 */
app.post('/api/agent/run', async (req, res) => {
    if (!checkOrigin(req, res)) return;
    await runHandler(req, res);
});

/**
 * GET /api/agent/resource?uri=ui://server-key/path — proxy an MCP resource
 * from a downstream MCP server. Used by the portal to fetch MCP App HTML
 * templates declared via `mcpApp.resourceUri` in card data.
 */
app.get('/api/agent/resource', async (req, res) => {
    if (!checkOrigin(req, res)) return;
    const auth = extractAuth(req);
    if (!auth) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const uri = typeof req.query.uri === 'string' ? req.query.uri : '';
    if (!uri.startsWith('ui://')) {
        return res.status(400).json({ error: 'uri must be a ui:// resource' });
    }

    // ui://serverKey/path → extract serverKey
    const withoutScheme = uri.slice('ui://'.length);
    const slash = withoutScheme.indexOf('/');
    if (slash <= 0) {
        return res.status(400).json({ error: 'uri must be ui://<serverKey>/<path>' });
    }
    const serverKey = withoutScheme.slice(0, slash);
    const serverConfig = config.mcpServers[serverKey];
    if (!serverConfig) {
        return res.status(404).json({ error: `Unknown server: ${serverKey}` });
    }

    try {
        const contents = serverConfig.auth
            ? await readMcpResource(serverKey, uri, auth.actorToken, auth.subjectToken)
            : await readMcpResource(serverKey, uri);
        const item = contents.find(c => c.mimeType?.startsWith('text/html')) || contents[0];
        if (!item) {
            return res.status(404).json({ error: 'No content for resource' });
        }
        res.setHeader('Content-Type', item.mimeType || 'text/html;profile=mcp-app');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.send(item.text || '');
    } catch (err) {
        console.error('[AG-UI] resource read failed:', err);
        res.status(502).json({ error: err.message });
    }
});

// =============================================================================
// Start server
// =============================================================================

const { port, host } = config.server;
app.listen(port, host, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Workforce AI Agent Server`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Server: http://${host}:${port}`);
    console.log(`Health: http://${host}:${port}/api/health`);
    console.log(`AG-UI:  POST http://${host}:${port}/api/agent/run`);
    console.log(`\nConfiguration:`);
    console.log(`  MCP Servers:`);
    for (const [name, srv] of Object.entries(config.mcpServers)) {
        console.log(`    ${name}: ${srv.url} (${srv.type}, auth=${srv.auth}, stateless=${srv.stateless})`);
    }
    console.log(`  Routing mode:   ${routerState.mode}`);
    console.log(`  Ollama URL:     ${config.llm.ollamaUrl}`);
    console.log(`  Ollama model:   ${config.llm.model}`);
    console.log(`  Token Exchange: sidecar (transparent)`);
    console.log(`${'='.repeat(60)}\n`);
});

// Graceful shutdown — AG-UI runs are short-lived per-request, no transport
// session map to drain.
process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    process.exit(0);
});
