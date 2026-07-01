/**
 * MCP Server Client (Streamable HTTP Transport)
 * 
 * Generic MCP client that supports multiple MCP servers, each configured
 * via the MCP_SERVERS environment variable (see config.js).
 *
 * Per-server behavior is driven by configuration attributes:
 *   - auth:          send Authorization + X-Subject-Token headers
 *   - stateless:     skip initialize handshake and session management
 *   - skipTlsVerify: disable TLS certificate verification
 *   - timeoutMs:     per-request timeout
 *   - headers:       static headers merged into every request
 *
 * For stateful servers (stateless: false), the client performs the full
 * MCP session lifecycle:
 *   1. Initialize session (get Mcp-Session-Id)
 *   2. Send notifications/initialized
 *   3. Call tools/list or tools/call with session ID
 *
 * Sessions are keyed per server + actor token to support multi-user
 * delegation across multiple MCP servers.
 *
 * For stateless servers (stateless: true), the client POSTs directly
 * to the MCP endpoint without session initialization.
 */

import https from 'https';
import http from 'http';
import fetch from 'node-fetch';
import { propagation, context, trace } from '@opentelemetry/api';
import config from './config.js';

// TLS agents keyed by skipTlsVerify value
const tlsAgents = {
    true: new https.Agent({ rejectUnauthorized: false }),
    false: new https.Agent({ rejectUnauthorized: true })
};

// Session cache: `${serverKey}:${actorToken}` → { sessionId, expiresAt }
const sessionCache = new Map();

/**
 * Resolve the server configuration for a given server key.
 * Throws if the server is not configured.
 */
function getServerConfig(serverKey) {
    const serverConfig = config.mcpServers[serverKey];
    if (!serverConfig) {
        throw new Error(`MCP server "${serverKey}" is not configured`);
    }
    return serverConfig;
}

/**
 * Inject the active W3C trace context into a JSON-RPC request body's
 * `params._meta` field. FastMCP's `_get_parent_trace_context()` reads
 * `traceparent`/`tracestate` from MCP request meta (not HTTP headers) when
 * deciding the parent of its server_span() — without this, FastMCP spans
 * for streamable-HTTP requests inherit the SSE session task's context and
 * end up in the wrong trace.
 */
function withTraceMeta(body) {
    const carrier = {};
    propagation.inject(context.active(), carrier);
    if (!carrier.traceparent && !carrier.tracestate) return body;
    const params = body.params || {};
    const meta = { ...(params._meta || {}) };
    if (carrier.traceparent) meta.traceparent = carrier.traceparent;
    if (carrier.tracestate) meta.tracestate = carrier.tracestate;
    return { ...body, params: { ...params, _meta: meta } };
}

/**
 * Parse a response that may be JSON or SSE (text/event-stream).
 * MCP Streamable HTTP transport may return either format.
 */
async function parseResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('text/event-stream')) {
        // Parse SSE: extract JSON from "data:" lines
        const text = await response.text();
        const lines = text.split('\n');
        let lastData = null;
        
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                lastData = line.slice(6);
            }
        }
        
        if (lastData) {
            return JSON.parse(lastData);
        }
        throw new Error(`No data found in SSE response: ${text.substring(0, 200)}`);
    }
    
    // Plain JSON response
    return response.json();
}

/**
 * Send a JSON-RPC request to an MCP server.
 * Low-level helper used by all MCP operations.
 *
 * @param {string} serverKey - Key into config.mcpServers
 * @param {object} body - JSON-RPC request body
 * @param {string|null} sessionId - MCP session ID (stateful servers only)
 * @param {string|null} actorToken - JWT-SVID (auth servers only)
 * @param {string|null} subjectToken - User's PA-JWT (auth servers only)
 */
async function mcpRequest(serverKey, body, sessionId = null, actorToken = null, subjectToken = null) {
    const serverConfig = getServerConfig(serverKey);
    const { url, auth, skipTlsVerify, timeoutMs, headers: staticHeaders } = serverConfig;
    const isHttps = url.startsWith('https');

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        'MCP-Protocol-Version': '2025-03-26',
        ...staticHeaders
    };

    // Auth headers — only for servers with auth: true
    if (auth && actorToken) {
        headers['Authorization'] = `Bearer ${actorToken}`;
    }
    if (auth && subjectToken) {
        headers['X-Subject-Token'] = subjectToken;
    }

    // Session ID — FastMCP requires this; should always be provided from caller
    if (sessionId) {
        console.log(`[MCPClient] SEND: Setting Mcp-Session-Id header: "${sessionId}"`);
        headers['Mcp-Session-Id'] = sessionId;
    } else {
        console.log(`[MCPClient] SEND: No sessionId provided!`);
    }

    // Propagate W3C traceparent so downstream spans attach to the active trace.
    // HTTP headers cover Starlette/auto-instrumentation; MCP `_meta` is read by
    // FastMCP's server_span() to parent its own SERVER spans correctly under
    // the streamable HTTP transport (where the SSE session task would otherwise
    // leak context across requests).
    propagation.inject(context.active(), headers);
    const tracedBody = withTraceMeta(body);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(tracedBody),
            agent: isHttps ? tlsAgents[skipTlsVerify] : undefined,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Initialize an MCP session (stateful servers only).
 * Returns the session ID from the Mcp-Session-Id response header.
 */
async function initializeSession(serverKey, actorToken, subjectToken) {
    console.log(`[MCPClient] Initializing MCP session for server "${serverKey}"...`);
    
    const initBody = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'initialize',
        params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
                name: 'workforce-ai-agent',
                version: '1.0.0'
            }
        }
    };

    const response = await mcpRequest(serverKey, initBody, null, actorToken, subjectToken);

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MCP initialize failed for "${serverKey}": ${response.status} - ${errorText}`);
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) {
        throw new Error(`MCP server "${serverKey}" did not return a session ID`);
    }
    
    console.log(`[MCPClient] INIT: Got sessionId from header: "${sessionId}" (length: ${sessionId.length})`);
    console.log(`[MCPClient] INIT: All response headers: ${JSON.stringify(Array.from(response.headers.entries()))}`);

    // Parse response to confirm initialization
    const result = await parseResponse(response);
    console.log(`[MCPClient] Session initialized for "${serverKey}": ${sessionId}`);
    console.log(`[MCPClient] Server: ${result.result?.serverInfo?.name || 'unknown'}`);

    // Send initialized notification (no response expected)
    const notifyBody = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
    };
    try {
        await mcpRequest(serverKey, notifyBody, sessionId, actorToken, subjectToken);
    } catch (e) {
        // notifications may not return a response, that's ok
        console.log(`[MCPClient] Sent initialized notification for "${serverKey}"`);
    }

    return sessionId;
}

/**
 * Get or create an MCP session for the given server + actor token.
 * Note: Session caching may cause issues with FastMCP HTTP streamable transport.
 * For now, we always create a new session to ensure consistency.
 */
async function getSession(serverKey, actorToken, subjectToken) {
    // For debugging: always initialize fresh session
    // Caching was causing inconsistent session IDs
    console.log(`[MCPClient] Creating fresh session for "${serverKey}"`);
    const sessionId = await initializeSession(serverKey, actorToken, subjectToken);
    return sessionId;
}

/**
 * Call an MCP tool on a specific server.
 *
 * @param {string} serverKey - Key into config.mcpServers
 * @param {string} toolName - The MCP tool to call
 * @param {object} toolArgs - Arguments for the tool
 * @param {string|null} actorToken - JWT-SVID (auth servers only)
 * @param {string|null} subjectToken - User's PA-JWT (auth servers only)
 */
export async function callMcpTool(serverKey, toolName, toolArgs = {}, actorToken = null, subjectToken = null) {
    const serverConfig = getServerConfig(serverKey);
    
    console.log(`[MCPClient] Calling tool: ${toolName} on server "${serverKey}"`);
    console.log(`[MCPClient] MCP Server: ${serverConfig.url}`);
    
    try {
        // FastMCP HTTP streamable transport ALWAYS requires a session ID,
        // even for stateless clients. Always initialize a session first.
        let sessionId = null;
        try {
            if (serverConfig.auth) {
                // Auth-enabled servers: initialize with tokens
                console.log(`[MCPClient] Initializing session with auth for "${serverKey}"`);
                sessionId = await getSession(serverKey, actorToken, subjectToken);
                console.log(`[MCPClient] Got session ID: ${sessionId}`);
            } else {
                // Public servers: initialize without tokens
                console.log(`[MCPClient] Initializing session without auth for "${serverKey}"`);
                sessionId = await getSession(serverKey, null, null);
                console.log(`[MCPClient] Got session ID: ${sessionId}`);
            }
        } catch (sessionErr) {
            console.error(`[MCPClient] Session initialization failed: ${sessionErr.message}`);
            throw sessionErr;
        }

        const body = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
                name: toolName,
                arguments: toolArgs
            }
        };

        const response = await mcpRequest(serverKey, body, sessionId, actorToken, subjectToken);

        // For auth-enabled (local/mesh) servers, pass through PingAuthorize
        // sideband error responses as-is: {"status":401,"message":"..."} or
        // {"status":403,"message":"..."}
        if (!response.ok) {
            const errorBody = await response.json()
                .catch((e) => {
                    console.error(`[MCPClient] Failed to parse error response JSON: ${e.message}`);
                    return { status: response.status, message: response.statusText };
                });
            console.log(`[MCPClient] Error response from "${serverKey}" (${response.status}):`, JSON.stringify(errorBody));
            return { ...errorBody, toolName };
        }

        const mcpResponse = await parseResponse(response);
        
        if (mcpResponse.error) {
            throw new Error(`MCP error: ${mcpResponse.error.message || JSON.stringify(mcpResponse.error)}`);
        }

        console.log(`[MCPClient] Tool response received from "${serverKey}"`);
        const result = extractToolResult(mcpResponse.result);

        // The outbound sidecar injects X-Ciba-Token when a CIBA step-up
        // was performed transparently. Pass it through so the agent can
        // include it in the chat response for the portal token panel.
        // These headers only appear on auth-enabled (local) servers behind
        // PingGateway — remote servers will never set them.
        if (serverConfig.auth) {
            const cibaToken = response.headers.get('x-ciba-token');
            if (cibaToken) {
                console.log(`[MCPClient] CIBA token received via sidecar`);
                result._cibaToken = cibaToken;
            } else {
                const exchangedToken = response.headers.get('x-exchanged-token');
                if (exchangedToken) {
                    console.log(`[MCPClient] Exchanged token received via PingGateway`);
                    result._exchangedToken = exchangedToken;
                }
            }
        }

        return result;
    } catch (error) {
        if (error.code === 'ECONNREFUSED' || error.name === 'AbortError' || error.type === 'aborted') {
            throw new Error(`Cannot connect to MCP server "${serverKey}" at ${serverConfig.url}: ${error.message}`);
        }
        throw error;
    }
}

/**
 * List available MCP tools on a specific server.
 *
 * @param {string} serverKey - Key into config.mcpServers
 * @param {string|null} actorToken - JWT-SVID (auth servers only)
 * @param {string|null} subjectToken - User's PA-JWT (auth servers only)
 */
export async function listMcpTools(serverKey, actorToken = null, subjectToken = null) {
    const serverConfig = getServerConfig(serverKey);
    
    try {
        // FastMCP HTTP streamable transport ALWAYS requires a session ID
        let sessionId = null;
        if (serverConfig.auth) {
            sessionId = await getSession(serverKey, actorToken, subjectToken);
        } else {
            sessionId = await getSession(serverKey, null, null);
        }

        const body = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/list',
            params: {}
        };

        const response = await mcpRequest(serverKey, body, sessionId, actorToken, subjectToken);

        if (!response.ok) {
            throw new Error(`MCP server "${serverKey}" error: ${response.status}`);
        }

        const mcpResponse = await parseResponse(response);
        return mcpResponse.result?.tools || [];
    } catch (error) {
        if (error.code === 'ECONNREFUSED' || error.name === 'AbortError' || error.type === 'aborted') {
            throw new Error(`Cannot connect to MCP server "${serverKey}" at ${serverConfig.url}: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Read an MCP resource from a specific server.
 *
 * Used to fetch UI resources (e.g. MCP App HTML) declared via
 * _meta.ui.resourceUri on tools.
 *
 * @param {string} serverKey - Key into config.mcpServers
 * @param {string} uri - The resource URI (e.g. "ui://travel-mcp/hotel-search.html")
 * @param {string|null} actorToken - JWT-SVID (auth servers only)
 * @param {string|null} subjectToken - User's PA-JWT (auth servers only)
 * @returns {Promise<Array>} Resource contents array from MCP response
 */
export async function readMcpResource(serverKey, uri, actorToken = null, subjectToken = null) {
    const serverConfig = getServerConfig(serverKey);

    console.log(`[MCPClient] Reading resource: ${uri} from server "${serverKey}"`);

    try {
        // FastMCP HTTP streamable transport ALWAYS requires a session ID
        let sessionId = null;
        if (serverConfig.auth) {
            console.log(`[MCPClient:readResource] Getting session for "${serverKey}"...`);
            sessionId = await getSession(serverKey, actorToken, subjectToken);
            console.log(`[MCPClient:readResource] Got session: ${sessionId}`);
        } else {
            sessionId = await getSession(serverKey, null, null);
        }

        const body = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'resources/read',
            params: { uri }
        };

        console.log(`[MCPClient:readResource] Sending resources/read to ${serverConfig.url} with sessionId=${sessionId}`);
        const response = await mcpRequest(serverKey, body, sessionId, actorToken, subjectToken);
        console.log(`[MCPClient:readResource] Got response: status=${response.status}, contentType=${response.headers.get('content-type')}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[MCPClient:readResource] HTTP error: ${response.status} - ${errorText.substring(0, 500)}`);
            throw new Error(`MCP resources/read failed for "${serverKey}": ${response.status} - ${errorText}`);
        }

        const mcpResponse = await parseResponse(response);
        console.log(`[MCPClient:readResource] Parsed response: hasError=${!!mcpResponse.error}, hasResult=${!!mcpResponse.result}, contentsCount=${mcpResponse.result?.contents?.length ?? 'N/A'}`);

        if (mcpResponse.error) {
            throw new Error(`MCP error: ${mcpResponse.error.message || JSON.stringify(mcpResponse.error)}`);
        }

        console.log(`[MCPClient] Resource read successfully from "${serverKey}"`);
        return mcpResponse.result?.contents || [];
    } catch (error) {
        console.error(`[MCPClient:readResource] CAUGHT ERROR: ${error.message}`);
        if (error.code === 'ECONNREFUSED' || error.name === 'AbortError' || error.type === 'aborted') {
            throw new Error(`Cannot connect to MCP server "${serverKey}" at ${serverConfig.url}: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Extract clean data from an MCP CallToolResult.
 * 
 * Per the MCP spec, tools/call returns:
 *   { content: [{ type: "text", text: "..." }, ...], isError?: boolean }
 * 
 * - Checks `isError` flag (MCP-standard tool error signaling)
 * - Extracts text content and parses JSON if applicable
 * - Falls through gracefully for mock responses (raw objects)
 */
function extractToolResult(result) {
    if (!result) return {};

    // Check MCP isError flag
    if (result.isError) {
        const errorText = result.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n') || 'Unknown tool error';
        throw new Error(`MCP tool error: ${errorText}`);
    }

    // Standard MCP CallToolResult with content array
    if (result.content && Array.isArray(result.content)) {
        const textItems = result.content.filter(c => c.type === 'text');
        if (textItems.length === 0) return {};

        // Single text item — try to parse as JSON
        if (textItems.length === 1) {
            try {
                return JSON.parse(textItems[0].text);
            } catch {
                return { message: textItems[0].text };
            }
        }

        // Multiple text items — return as array
        return {
            items: textItems.map(t => {
                try { return JSON.parse(t.text); }
                catch { return { message: t.text }; }
            })
        };
    }

    // Already parsed data (mock responses return plain objects)
    return result;
}

export default { callMcpTool, listMcpTools, readMcpResource };
