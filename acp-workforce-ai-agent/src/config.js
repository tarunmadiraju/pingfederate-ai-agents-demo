/**
 * Workforce AI Agent Configuration
 *
 * Environment variables for the agent server, MCP Server access,
 * and LLM-based tool routing via Ollama.
 * Token exchange is handled transparently by the Authn Sidecar —
 * the agent does not need PingFederate, SPIFFE, or OAuth client config.
 *
 * MCP servers are configured via the MCP_SERVERS environment variable,
 * a JSON object keyed by server name. Each entry defines a server with
 * attributes that control transport, authentication, and session behavior.
 * See deploy/configmap.yaml for the canonical configuration.
 *
 * Server attributes:
 *   type          "local" | "remote"  — local = K8s-internal (mesh, sidecars),
 *                                        remote = public internet
 *   enabled       boolean             — toggle without removing from config
 *   url           string              — MCP server endpoint URL
 *   auth          boolean             — send Authorization + X-Subject-Token headers
 *   stateless     boolean             — skip MCP session initialization
 *   skipTlsVerify boolean             — disable TLS certificate verification
 *   timeoutMs     number              — per-request timeout in milliseconds
 *   headers       object              — static headers to send with every request
 *
 * OLLAMA_MODEL=auto resolves to the first model returned by GET /api/tags at
 * startup. If Ollama is unreachable or has no models pulled the config still
 * loads successfully — Ollama is only needed for /mode llm routing.
 */

/**
 * Parse and validate the MCP_SERVERS JSON environment variable.
 * Filters out servers with enabled: false and applies defaults.
 */
function parseMcpServers() {
    const raw = process.env.MCP_SERVERS;
    if (!raw) {
        throw new Error('MCP_SERVERS environment variable is required');
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`MCP_SERVERS is not valid JSON: ${e.message}`);
    }

    const servers = {};
    for (const [name, cfg] of Object.entries(parsed)) {
        // Skip disabled servers
        if (cfg.enabled === false) {
            console.log(`[Config] MCP server "${name}" is disabled, skipping`);
            continue;
        }

        if (!cfg.url) {
            throw new Error(`MCP server "${name}" is missing required "url" attribute`);
        }
        if (!cfg.type || !['local', 'remote'].includes(cfg.type)) {
            throw new Error(`MCP server "${name}" must have type "local" or "remote"`);
        }

        servers[name] = {
            type: cfg.type,
            url: cfg.url,
            auth: cfg.auth ?? false,
            stateless: cfg.stateless ?? false,
            skipTlsVerify: cfg.skipTlsVerify ?? false,
            timeoutMs: cfg.timeoutMs ?? 30000,
            headers: cfg.headers ?? {}
        };
    }

    if (Object.keys(servers).length === 0) {
        throw new Error('MCP_SERVERS must contain at least one enabled server');
    }

    return servers;
}

/**
 * Resolve OLLAMA_MODEL=auto to the first model returned by GET /api/tags.
 * Returns the raw env value unchanged for any other string.
 * Never throws — if Ollama is unreachable the literal string 'auto' is
 * returned and the probe at startup will emit a warning.
 */
async function resolveOllamaModel(ollamaUrl, rawModel, timeoutMs) {
    if (rawModel !== 'auto') return rawModel;

    try {
        const fetch = (await import('node-fetch')).default;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return 'auto';
        const data = await res.json();
        const first = data?.models?.[0]?.name;
        if (first) {
            console.log(`[Config] OLLAMA_MODEL=auto resolved to: ${first}`);
            return first;
        }
        console.warn('[Config] OLLAMA_MODEL=auto: no models found — pull a model first (e.g. ollama pull qwen2.5:3b)');
    } catch {
        console.warn('[Config] OLLAMA_MODEL=auto: Ollama unreachable — /mode llm will not function');
    }
    return 'auto';
}

/**
 * Non-blocking tool-calling probe. Sends a minimal request to verify the
 * active model supports tool calling. Emits a warning if it does not.
 * Never throws and does not block startup.
 */
async function probeToolCalling(ollamaUrl, model, timeoutMs) {
    if (model === 'auto') return; // no model resolved — skip
    try {
        const fetch = (await import('node-fetch')).default;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${ollamaUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'ping' }],
                tools: [{ type: 'function', function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } } }],
                tool_choice: 'auto',
                temperature: 0
            }),
            signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) {
            console.warn(`[Config] Ollama tool-calling probe failed: HTTP ${res.status}`);
            return;
        }
        const data = await res.json();
        const hasToolCall = !!data?.choices?.[0]?.message?.tool_calls?.length;
        if (hasToolCall) {
            console.log(`[Config] Ollama model "${model}" supports tool calling`);
        } else {
            console.warn(`[Config] Ollama model "${model}" does not appear to support tool calling — /mode llm will fall back to keyword routing`);
        }
    } catch {
        console.warn(`[Config] Ollama tool-calling probe timed out or failed — /mode llm will fall back to keyword routing`);
    }
}

const _ollamaUrl = process.env.OLLAMA_URL || 'http://host.k3d.internal:11434';
const _rawModel = process.env.OLLAMA_MODEL || 'auto';
const _timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '15000', 10);

// Resolve auto-model and run tool-calling probe at startup (non-blocking).
const _resolvedModel = await resolveOllamaModel(_ollamaUrl, _rawModel, _timeoutMs);
probeToolCalling(_ollamaUrl, _resolvedModel, _timeoutMs).catch(() => {});

export const config = {
    // Server settings
    server: {
        port: parseInt(process.env.PORT || '3002', 10),
        host: process.env.HOST || '0.0.0.0'
    },

    // Stable agent identity, stamped on agent.reasoning spans as
    // gen_ai.agent.id / gen_ai.agent.name and used (set-once) as the
    // origin_agent.id baggage value. Human-meaningful slug, not a UUID.
    agent: {
        id: process.env.AGENT_ID || 'acp-workforce-ai-agent',
        name: process.env.AGENT_NAME || 'Workforce AI Agent'
    },

    // MCP Servers — parsed from MCP_SERVERS JSON env var
    mcpServers: parseMcpServers(),

    // LLM routing via Ollama (runs natively on the Mac host, GPU-accelerated)
    // Reachable from k3d pods via host.k3d.internal.
    // Activated at runtime via the /mode chat command.
    llm: {
        ollamaUrl: _ollamaUrl,
        model: _resolvedModel,
        timeoutMs: _timeoutMs
    }
};

export default config;
