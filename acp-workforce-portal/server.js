/**
 * Workforce Portal Server
 *
 * Minimal Express server with multiple zones:
 *
 *   PUBLIC (/) — Landing page & static assets
 *     Served through PA's unprotected API application (context root /).
 *     No OIDC session required.
 *
 *   PROTECTED (/workforce-portal) — Dashboard, chat, user identity, traces
 *     Served through PA's Web application (context root /workforce-portal).
 *     PA handles OIDC auth, injects identity headers via Header Identity Mapping:
 *       X-PA-Sub, X-PA-Name, X-PA-Email
 *
 *   PROTECTED (/authenticator-app) — CIBA consent PWA
 *     Served through PA's Web application (context root /authenticator-app).
 *     PA handles OIDC auth, injects identity headers.
 *
 * The browser never sees tokens — only the PA session cookie.
 *
 * CIBA consent endpoints live in acp-ciba-service (standalone microservice).
 * This server proxies /workforce-portal/ciba/* and /authenticator-app/ciba/*
 * to the CIBA service at /ciba/*, forwarding PA identity headers.
 * Each path falls under its respective PA app (correct session automatically).
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { project } from './lib/traceProjector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON body parsing for API requests
app.use(express.json());

// ─── Shared /me handler ──────────────────────────────────────────────────────
// PA's Header Identity Mapping adds these headers to every proxied request
// under protected context roots:
//   X-PA-Sub   → OIDC subject (unique user ID)
//   X-PA-Name  → Display name from UserInfo
//   X-PA-Email → Email from UserInfo
function handleMe(req, res) {
    const sub   = req.headers['x-pa-sub']   || null;
    const name  = req.headers['x-pa-name']  || null;
    const email = req.headers['x-pa-email'] || null;

    if (!sub) {
        // No identity headers — PA session not established or mapping misconfigured
        return res.status(401).json({ error: 'Not authenticated' });
    }

    res.json({ sub, name, email });
}

// PROTECTED: /workforce-portal/me and /authenticator-app/me
app.get('/workforce-portal/me', handleMe);
app.get('/authenticator-app/me', handleMe);

// ─── CIBA proxy — forward to acp-ciba-service ───────────────────────────────
// Both /workforce-portal/ciba/* and /authenticator-app/ciba/* fall under their
// respective PA apps (WorkforcePortalWeb, AuthenticatorApp), so PA resolves the
// correct OIDC session and injects identity headers (X-PA-Sub, etc.).
// We proxy to the CIBA service's /ciba/* routes, forwarding identity headers.
const CIBA_SERVICE_URL = process.env.CIBA_SERVICE_URL
    || 'http://acp-ciba-service.acp-ciba-service.svc.cluster.local:3000';

async function proxyCiba(req, res) {
    const cibaPath = '/ciba' + req.url;  // req.url is relative to the mount point
    const target = `${CIBA_SERVICE_URL}${cibaPath}`;
    try {
        const headers = { 'Content-Type': 'application/json' };
        // Forward PA identity headers so the CIBA service can filter by user
        if (req.headers['x-pa-sub'])   headers['x-pa-sub']   = req.headers['x-pa-sub'];
        if (req.headers['x-pa-name'])  headers['x-pa-name']  = req.headers['x-pa-name'];
        if (req.headers['x-pa-email']) headers['x-pa-email'] = req.headers['x-pa-email'];

        const opts = { method: req.method, headers };
        if (req.method === 'POST' && req.body) {
            opts.body = JSON.stringify(req.body);
        }
        const upstream = await fetch(target, opts);
        const contentType = upstream.headers.get('content-type') || '';
        res.status(upstream.status);
        if (contentType.includes('application/json')) {
            res.json(await upstream.json());
        } else {
            res.send(await upstream.text());
        }
    } catch (err) {
        console.error(`[CIBA Proxy] ${req.method} ${cibaPath} failed:`, err.message);
        res.status(502).json({ error: `CIBA service unreachable: ${err.message}` });
    }
}

app.use('/workforce-portal/ciba', proxyCiba);
app.use('/authenticator-app/ciba', proxyCiba);

// AG-UI agent endpoints (/api/agent/run, /api/agent/elicitation/:id,
// /api/agent/resource) are reached by the browser directly through PA's
// WorkforceAgentAPI application (contextRoot /api). PA injects the PA-signed
// JWT as Authorization: Bearer for that app via AgentJwtMapping; the portal
// pod is no longer in that path.

// ─── PROTECTED: /workforce-portal/reset — Reset MCP server demo data ────────
// Calls the MCP server via Traefik ingress (TLS verified against platform CA).
app.post('/workforce-portal/reset', async (_req, res) => {
    try {
        const url = process.env.MCP_RESET_URL || 'https://acp-expense-mcp.localhost/reset';
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('[Reset] Failed:', err.message);
        res.status(502).json({ error: `MCP server unreachable: ${err.message}` });
    }
});

// ─── PROTECTED: /workforce-portal/traces — Browser OTel trace forwarder ─────
// The browser OTel SDK cannot reach the cluster-internal Jaeger OTLP endpoint
// directly. This same-origin endpoint forwards OTLP JSON payloads transparently.
// PA protects /workforce-portal/* so only authenticated users can submit traces.
const OTEL_COLLECTOR_URL = process.env.OTEL_COLLECTOR_URL
    || 'http://jaeger.observability.svc.cluster.local:4318/v1/traces';

const JAEGER_QUERY_URL = process.env.JAEGER_QUERY_URL
    || 'http://jaeger.observability.svc.cluster.local:16686';

app.post('/workforce-portal/traces', async (req, res) => {
    try {
        // express.json() (global) already parsed req.body; re-serialize for the upstream POST
        const response = await fetch(OTEL_COLLECTOR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
        });
        if (!response.ok) {
            console.error(`[OTel] Jaeger returned ${response.status}: ${await response.text()}`);
        }
        res.status(response.ok ? 200 : response.status).end();
    } catch (err) {
        console.error('[OTel] Trace forward failed:', err.message);
        res.status(502).end();
    }
});

// ─── PROTECTED: /workforce-portal/trace/:traceId — Jaeger trace query ──────
// Fetches a trace by ID from Jaeger's HTTP query API and projects it to the
// Telemetry panel spans JSON contract. Retries for up to ~5 s to absorb Jaeger
// ingestion lag (typically 2–5 s after the span is exported).
// PA protects /workforce-portal/* — only authenticated users can query traces.
app.get('/workforce-portal/trace/:traceId', async (req, res) => {
    const { traceId } = req.params;

    if (!/^[0-9a-f]{32}$/i.test(traceId)) {
        return res.status(400).json({ error: 'invalid traceId' });
    }

    const url = `${JAEGER_QUERY_URL}/api/traces/${traceId}`;

    // Retry helper: attempts the fetch up to maxAttempts times with linear delay.
    // Returns { ok: true, data } on success, or { ok: false, status, message } on failure.
    async function retryFetch(url, delays) {
        for (let attempt = 0; attempt <= delays.length; attempt++) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    const data = await response.json();
                    return { ok: true, data };
                }
                if (response.status === 404) {
                    // Trace not yet ingested — retry if delays remain
                    if (attempt < delays.length) {
                        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
                        continue;
                    }
                    return { ok: false, status: 404, message: 'trace not found' };
                }
                // Any non-404 error from Jaeger is a gateway error — do not retry
                return { ok: false, status: 502, message: `Jaeger error: ${response.status}` };
            } catch (err) {
                // Network error — do not retry
                return { ok: false, status: 502, message: `Jaeger unreachable: ${err.message}` };
            }
        }
        return { ok: false, status: 404, message: 'trace not found' };
    }

    const result = await retryFetch(url, [500, 1000, 1500]);

    if (!result.ok) {
        const httpStatus = result.status === 404 ? 404 : 502;
        return res.status(httpStatus).json({ error: result.message });
    }

    const projection = project(result.data);
    return res.json(projection);
});

// ─── PROTECTED: /workforce-portal/trace-raw/:traceId — Raw Jaeger trace ──────
// Returns the unprocessed Jaeger trace response for use by the browser graph view.
// PA protects /workforce-portal/* — only authenticated users can query traces.
app.get('/workforce-portal/trace-raw/:traceId', async (req, res) => {
    const { traceId } = req.params;

    if (!/^[0-9a-f]{32}$/i.test(traceId)) {
        return res.status(400).json({ error: 'invalid traceId' });
    }

    const url = `${JAEGER_QUERY_URL}/api/traces/${traceId}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            return res.status(response.status === 404 ? 404 : 502).json({ error: 'trace not found' });
        }
        const data = await response.json();
        return res.json(data);
    } catch (err) {
        return res.status(502).json({ error: `Jaeger unreachable: ${err.message}` });
    }
});

// ─── PROTECTED: /workforce-portal — Serve authenticated dashboard ────────────
// PA Web application protects /workforce-portal/* — user must have a valid OIDC session.
app.get('/workforce-portal', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ─── PROTECTED: /workforce-portal/graph — Trace graph view ───────────────────
app.get('/workforce-portal/graph', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'graph.html'));
});

// ─── PROTECTED: /authenticator-app — CIBA consent PWA ────────────────────────
// PA Web application protects /authenticator-app/* — user must have a valid OIDC session.
// In Docker the authenticator-app/ dir is at public/authenticator-app/; locally it's at ./authenticator-app/.
// Try both paths so the app works in both environments.
const authenticatorDir = existsSync(join(__dirname, 'public', 'authenticator-app'))
    ? join(__dirname, 'public', 'authenticator-app')
    : join(__dirname, 'authenticator-app');
app.use('/authenticator-app', express.static(authenticatorDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

// ─── Redirect: /mobile* → /authenticator-app (stale PWA installs) ───────────
app.use('/mobile', (req, res) => {
    res.redirect(301, '/authenticator-app' + (req.url === '/' ? '' : req.url));
});

// ─── PUBLIC: / — Landing page ────────────────────────────────────────────────
// Must be defined BEFORE express.static, which would otherwise serve index.html
// for the root path automatically.
app.get('/', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'landing.html'));
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.send('OK'));

// ─── Static files ────────────────────────────────────────────────────────────
// Cache-busting: no-cache for JS/CSS so deployments take effect immediately.
// Static assets are served publicly (CSS, JS don't contain sensitive data).
app.use(express.static(join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

// ─── PUBLIC: / — Landing page (default for unmatched routes) ─────────────────
app.use((_req, res) => {
    res.sendFile(join(__dirname, 'public', 'landing.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Workforce Portal listening on port ${PORT}`);
});
