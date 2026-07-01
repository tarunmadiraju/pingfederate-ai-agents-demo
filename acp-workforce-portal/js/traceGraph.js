/**
 * traceGraph.js — Derives a service dependency graph from raw Jaeger trace data.
 *
 * Consumed by graph.html. No bundler — loaded as a classic script.
 */

const traceGraph = (() => {

    // Per-agent cluster definitions. Each entry declares the raw OTel service
    // names that belong to the agent and maps them to display labels.
    // The graph builds one named cluster per agent found in the trace.
    //
    // The `topology` field describes the real intra-pod Envoy data path so the
    // EXPANDED graph can render the network exchange between filters (see
    // _expandIntraPod). It is a static descriptor — the Envoy filter chain,
    // the JWKS fetch, the TLS/HTTP outbound fork, and the sidecar's two ports
    // emit no per-filter spans, so this mirrors the bootstrap YAML the same way
    // SPIRE / Open-Meteo nodes are injected from static knowledge.
    //
    //   inbound.filters / outbound.filters — ordered http_filters in the listener.
    //     kind: 'jwt_authn' | 'ext_proc' | 'router'
    //     jwks: true        — jwt_authn fetches the SPIRE OIDC JWKS (side call)
    //     role: 'paz' | 'header-mint' | 'mint' | 'exchange'  — what ext_proc does
    //     port: 9010        — sidecar listener the ext_proc filter calls (gRPC)
    //     to:   'agent' | 'authz_proxy'  — router upstream
    //   outbound.fork — TLS-inspector splits TLS (passthrough, bypasses sidecar)
    //                   from HTTP (intercepted via the filter chain). Rendered
    //                   as the 'tls_inspector' caption on the Envoy Outbound node.
    //
    // Fields consumed by _expandIntraPod today: inbound/outbound.filters (+ their
    // kind/role/jwks/port/to) and outbound.fork. The descriptive fields below
    // document the data path for readers and future synthesis but are NOT yet
    // read by the renderer — the corresponding edges are drawn only when the
    // live trace contains the matching span:
    //   outbound.downstream — what authz_proxy :15002 TLS-originates to.
    //   outbound.downstream — what authz_proxy :15002 TLS-originates to.
    //   outbound.ciba       — authz_proxy performs CIBA step-up on 403.
    const AGENT_CONFIGS = [
        {
            clusterLabel: 'Workforce AI Agent',
            nodes: {
                agent:    { raw: 'acp-workforce-ai-agent',        label: 'AI Agent' },
                inbound:  { raw: 'acp-wf-ai-agent-proxy-inbound', label: 'Envoy Inbound' },
                sidecar:  { raw: 'acp-wf-ai-agent-identity-sidecar', label: 'Identity Sidecar' },
                outbound: { raw: 'acp-wf-ai-agent-proxy-outbound', label: 'Envoy Outbound' },
            },
            topology: {
                inbound: {
                    filters: [
                        { kind: 'ext_proc', role: 'header-mint', port: 9010 },
                        { kind: 'router', to: 'agent' },
                    ],
                },
                // Models the base acp-workforce-ai-agent/deploy/envoy.yaml
                // (CIBA step-up inside authz_proxy). The ciba-gateway overlay
                // relocates CIBA to PingGateway and changes this data path —
                // if that overlay is deployed, this descriptor drifts.
                outbound: {
                    fork: true,
                    filters: [
                        { kind: 'router', to: 'authz_proxy' },
                    ],
                    downstream: 'PingGateway',
                    ciba: true,
                },
            },
        },
        {
            clusterLabel: 'Weather Agent',
            nodes: {
                agent:   { raw: 'acp-weather-agent',                  label: 'Weather Agent' },
                inbound: { raw: 'acp-weather-agent-envoy-inbound',    label: 'Envoy Inbound' },
                sidecar: { raw: 'acp-weather-agent-identity-sidecar',    label: 'Identity Sidecar' },
            },
            topology: {
                inbound: {
                    filters: [
                        { kind: 'jwt_authn', jwks: true },
                        { kind: 'ext_proc', role: 'paz', port: 9010 },
                        { kind: 'router', to: 'agent' },
                    ],
                },
            },
        },
        {
            clusterLabel: 'Trip Planner Agent',
            nodes: {
                agent:    { raw: 'acp-trip-planner-agent',                    label: 'Trip Planner' },
                inbound:  { raw: 'acp-trip-planner-agent-proxy-inbound',      label: 'Envoy Inbound' },
                sidecar:  { raw: 'acp-trip-planner-agent-identity-sidecar',   label: 'Identity Sidecar' },
                outbound: { raw: 'acp-trip-planner-agent-proxy-outbound',     label: 'Envoy Outbound' },
            },
            topology: {
                inbound: {
                    // ext_proc → sidecar :9011 performs the single RFC 8693 exchange
                    // at the inbound trust boundary, injecting X-Tx-Token onto the
                    // request. paz.enabled=false so no PAZ enforcement here.
                    filters: [
                        { kind: 'ext_proc', role: 'exchange', port: 9011 },
                        { kind: 'router', to: 'agent' },
                    ],
                },
                outbound: {
                    fork: true,
                    filters: [
                        { kind: 'ext_proc', role: 'mint', port: 9010 },
                        { kind: 'router', to: 'authz_proxy' },
                    ],
                    downstream: 'A2A',
                },
            },
        },
        {
            clusterLabel: 'Flight Booker Agent',
            nodes: {
                agent:   { raw: 'acp-flight-booker-agent',                label: 'Flight Booker' },
                inbound: { raw: 'acp-flight-booker-agent-envoy-inbound',  label: 'Envoy Inbound' },
                sidecar: { raw: 'acp-flight-booker-agent-identity-sidecar',  label: 'Identity Sidecar' },
            },
            topology: {
                inbound: {
                    filters: [
                        { kind: 'jwt_authn', jwks: true },
                        { kind: 'ext_proc', role: 'paz', port: 9010 },
                        { kind: 'router', to: 'agent' },
                    ],
                },
            },
        },
        {
            clusterLabel: 'Hotel Booker Agent',
            nodes: {
                agent:   { raw: 'acp-hotel-booker-agent',                label: 'Hotel Booker' },
                inbound: { raw: 'acp-hotel-booker-agent-envoy-inbound',  label: 'Envoy Inbound' },
                sidecar: { raw: 'acp-hotel-booker-agent-identity-sidecar',  label: 'Identity Sidecar' },
            },
            topology: {
                inbound: {
                    filters: [
                        { kind: 'jwt_authn', jwks: true },
                        { kind: 'ext_proc', role: 'paz', port: 9010 },
                        { kind: 'router', to: 'agent' },
                    ],
                },
            },
        },
    ];

    // Build flat DISPLAY_LABELS from AGENT_CONFIGS + non-agent services.
    const DISPLAY_LABELS = {};
    for (const cfg of AGENT_CONFIGS) {
        for (const { raw, label } of Object.values(cfg.nodes)) {
            DISPLAY_LABELS[raw] = label;
        }
    }
    Object.assign(DISPLAY_LABELS, {
        'acp-workforce-portal-browser':   'Workforce Portal',
        'acp-workforce-portal':           'Workforce Portal',
        'acp-pinggateway':                'PingGateway',
        'acp-pingfederate':               'PingFederate',
        'acp-pingauthorize':              'PingAuthorize',
        'PingAuthorize':                  'PingAuthorize',
        'acp-expense-mcp-server':         'Expense MCP Server',
        'acp-travel-mcp-server':          'Travel MCP Server',
        'acp-expense-api':                'Expense API',
        'acp-ciba-service':               'CIBA Service',
    });

    const PING_NODES    = new Set(['PingGateway', 'PingFederate', 'PingAuthorize']);
    const BACKEND_IDS   = new Set(['Expense MCP Server', 'Travel MCP Server', 'Expense API', 'Open-Meteo API']);

    // Build set of all agent-runtime display labels from AGENT_CONFIGS + SPIRE nodes.
    const SPIRE_NODE_IDS = ['SPIRE Server', 'SPIRE Workload Agent', 'SPIRE OIDC Bridge'];
    const AGENT_RUNTIME_LABELS = new Set(SPIRE_NODE_IDS);
    for (const cfg of AGENT_CONFIGS) {
        for (const { label } of Object.values(cfg.nodes)) {
            AGENT_RUNTIME_LABELS.add(label);
        }
    }

    // Map raw service → which agent config it belongs to (for cluster assignment).
    const RAW_TO_AGENT_CONFIG = {};
    for (const cfg of AGENT_CONFIGS) {
        for (const { raw } of Object.values(cfg.nodes)) {
            RAW_TO_AGENT_CONFIG[raw] = cfg;
        }
    }

    // Raw service names of the Envoy listeners and the identity sidecars, used to
    // resolve edge ownership directly from the span tree (see _nearestEnvoyAncestor)
    // rather than re-deriving it from the static topology. A sidecar emits no
    // cross-service span for the listener it serves, but every sidecar span sits
    // beneath the owning Envoy listener in the CHILD_OF chain — so the trace itself
    // tells us whether a given sidecar call belongs to the inbound or outbound path.
    const ENVOY_LISTENER_RAWS = new Set();
    const SIDECAR_RAWS = new Set();
    for (const cfg of AGENT_CONFIGS) {
        if (cfg.nodes.inbound)  ENVOY_LISTENER_RAWS.add(cfg.nodes.inbound.raw);
        if (cfg.nodes.outbound) ENVOY_LISTENER_RAWS.add(cfg.nodes.outbound.raw);
        if (cfg.nodes.sidecar)  SIDECAR_RAWS.add(cfg.nodes.sidecar.raw);
    }

    const NODE_ICONS = {
        'Workforce Portal':    'fa-window-restore',
        'AI Agent':            'fa-robot',
        'Weather Agent':       'fa-cloud-sun',
        'Trip Planner':        'fa-map',
        'Flight Booker':       'fa-plane-departure',
        'Hotel Booker':        'fa-hotel',
        'Envoy Inbound':       'fa-arrow-right-to-bracket',
        'Envoy Outbound':      'fa-arrow-right-from-bracket',
        'Identity Sidecar':       'fa-id-badge',
        'SPIRE Server':        'fa-server',
        'SPIRE Workload Agent':'fa-fingerprint',
        'SPIRE OIDC Bridge':   'fa-id-card',
        'PingGateway':         'fa-route',
        'PingFederate':        'fa-key',
        'PingAuthorize':       'fa-shield-halved',
        'PingIDM':             'fa-users-gear',
        'A2A Registry':        'fa-address-book',
        'Expense MCP Server':  'fa-cube',
        'Travel MCP Server':   'fa-plane',
        'Expense API':         'fa-database',
        'Open-Meteo API':      'fa-cloud',
        'CIBA Service':        'fa-bell',
    };

    const EDGE_META = {
        // ── Workforce AI Agent inbound (fan-out from Envoy Inbound) ───────────
        'Workforce Portal->Envoy Inbound':    { role: 'AG-UI',        protocol: 'HTTPS / SSE' },
        'Envoy Inbound->Identity Sidecar':       { role: 'ext_proc',     protocol: 'gRPC' },
        'Envoy Inbound->AI Agent':            { role: 'HTTP',         protocol: 'HTTP' },
        // ── Workforce AI Agent outbound ───────────────────────────────────────
        'AI Agent->Envoy Outbound':           { role: 'MCP Client',   protocol: 'HTTP' },
        'Envoy Outbound->Identity Sidecar':      { role: 'CIBA Proxy',   protocol: 'HTTP' },
        'Identity Sidecar->PingGateway':         { role: 'MCP Proxy',    protocol: 'HTTPS' },
        // ── Weather Agent inbound ─────────────────────────────────────────────
        'AI Agent->Weather Agent':            { role: 'A2A',          protocol: 'HTTPS' },
        'Envoy Inbound->Weather Agent':       { role: 'HTTP',         protocol: 'HTTP' },
        // ── SPIRE ─────────────────────────────────────────────────────────────
        'Identity Sidecar->SPIRE Workload Agent':{ role: 'Workload API', protocol: 'Unix socket' },
        'SPIRE Workload Agent->SPIRE Server': { role: 'Node Attest',  protocol: 'gRPC / mTLS' },
        // ── Ping Agentic Platform ─────────────────────────────────────────────
        'PingGateway->PingFederate':          { role: 'Token Exchange', protocol: 'RFC 8693 / HTTPS' },
        'PingGateway->PingAuthorize':         { role: 'PDP Sideband', protocol: 'HTTPS / REST' },
        'PingGateway->Expense MCP Server':    { role: 'MCP Forward',  protocol: 'HTTPS' },
        'PingGateway->Travel MCP Server':     { role: 'MCP Forward',  protocol: 'HTTPS' },
        // ── Backends ─────────────────────────────────────────────────────────
        'Expense MCP Server->Expense API':    { role: 'REST',         protocol: 'HTTPS' },
        'Travel MCP Server->Expense API':     { role: 'REST',         protocol: 'HTTPS' },
        'Weather Agent->Open-Meteo API':      { role: 'REST',         protocol: 'HTTPS' },
    };

    function _tagsToObject(tags) {
        const obj = {};
        for (const tag of tags || []) obj[tag.key] = tag.value;
        return obj;
    }

    function _serviceName(traceData, span) {
        return traceData.processes?.[span.processID]?.serviceName || '?';
    }

    // Walk the CHILD_OF chain upward from `span` and return the raw service name
    // of the nearest ancestor that is an Envoy listener (inbound or outbound).
    // This is how we learn — straight from the trace — which data path a sidecar
    // call belongs to: a sidecar's authz-proxy (downstream A2A/MCP) sits beneath
    // the OUTBOUND listener, while its ext_proc work (PAZ, RFC 8693) sits beneath
    // the listener whose filter chain invoked it. Returns null if none is found.
    function _nearestEnvoyAncestor(traceData, span, spanIndex) {
        let cur = span;
        const guard = new Set(); // cycle guard — malformed traces can self-reference
        while (cur) {
            const parentRef = (cur.references || []).find(r => r.refType === 'CHILD_OF');
            if (!parentRef || guard.has(parentRef.spanID)) break;
            guard.add(parentRef.spanID);
            const parent = spanIndex[parentRef.spanID];
            if (!parent) break;
            if (ENVOY_LISTENER_RAWS.has(_serviceName(traceData, parent))) {
                return _serviceName(traceData, parent);
            }
            cur = parent;
        }
        return null;
    }

    function _labelFor(rawService) {
        return DISPLAY_LABELS[rawService] || rawService;
    }

    function _iconFor(label) {
        return NODE_ICONS[label] || 'fa-circle-nodes';
    }

    function _statusFor(tags, statusCode) {
        const code = typeof statusCode === 'number' ? statusCode : parseInt(statusCode, 10);
        const httpErr = Number.isFinite(code) && code >= 400;
        const otelErr = tags['otel.status_code'] === 'ERROR';
        const flagErr = tags['error'] === true || tags['error'] === 'true';
        return (httpErr || otelErr || flagErr) ? 'error' : 'ok';
    }

    // Detect which agent configs are actually present in this trace.
    function _detectAgentConfigs(spans, traceData) {
        const presentRaws = new Set(spans.map(s => _serviceName(traceData, s)));
        return AGENT_CONFIGS.filter(cfg =>
            Object.values(cfg.nodes).some(n => presentRaws.has(n.raw))
        );
    }

    /**
     * Build nodes and edges from raw Jaeger trace data (the `data[0]` object).
     * Returns { nodes, edges, totalDurationMs, traceId, deepLink, agentConfigs }.
     */
    function buildGraph(traceData, opts = {}) {
        const spans = traceData.spans || [];
        const spanIndex = {};
        for (const s of spans) spanIndex[s.spanID] = s;

        let traceMinStart = Infinity;
        let traceMaxEnd = -Infinity;
        for (const s of spans) {
            if (s.startTime < traceMinStart) traceMinStart = s.startTime;
            const end = s.startTime + s.duration;
            if (end > traceMaxEnd) traceMaxEnd = end;
        }
        if (!Number.isFinite(traceMinStart)) traceMinStart = 0;

        const activeAgentConfigs = _detectAgentConfigs(spans, traceData);

        const nodeMap = {};

        for (const span of spans) {
            const raw = _serviceName(traceData, span);
            const label = _labelFor(raw);
            if (!nodeMap[raw]) {
                nodeMap[raw] = {
                    id: raw,
                    label,
                    isPing: PING_NODES.has(label),
                    isAgentRuntime: AGENT_RUNTIME_LABELS.has(label),
                    isBackend: BACKEND_IDS.has(label),
                    isSynthetic: false,
                    icon: _iconFor(label),
                    rawServices: new Set(),
                    totalSpans: 0,
                    totalDurationMs: 0,
                    operationCounts: {},
                    spans: [],
                    _hasOk: false,
                    _hasError: false,
                };
            }
            const node = nodeMap[raw];
            node.rawServices.add(raw);
            node.totalSpans++;
            node.totalDurationMs += Math.round((span.duration || 0) / 1000);
            node.operationCounts[span.operationName] = (node.operationCounts[span.operationName] || 0) + 1;

            const tags = _tagsToObject(span.tags);
            const statusCode = tags['http.response.status_code'] ?? tags['http.status_code'];
            const status = _statusFor(tags, statusCode);
            if (status === 'error') node._hasError = true;
            else node._hasOk = true;

            node.spans.push({
                spanID: span.spanID,
                operationName: span.operationName,
                processName: _serviceName(traceData, span),
                durationMs: Math.round((span.duration || 0) / 1000),
                startTimeOffsetMs: Math.round((span.startTime - traceMinStart) / 1000),
                statusCode: statusCode !== undefined ? String(statusCode) : null,
                status,
                tags,
            });
        }

        // Inject synthetic SPIRE nodes whenever any agent with a sidecar is present.
        // nodeMap is keyed by raw service name now.
        // When opts.hideSpire is set, the SPIRE cluster is suppressed entirely: the
        // nodes are never injected, and because the synthetic SPIRE edges only
        // connect SPIRE nodes to each other / to sidecars (never relaying a business
        // flow), _injectSyntheticEdge no-ops on the missing endpoints and the final
        // endpoint-existence edge filter drops anything dangling — no edge surgery.
        const hasAnySidecar = !opts.hideSpire && activeAgentConfigs.some(cfg =>
            cfg.nodes.sidecar && nodeMap[cfg.nodes.sidecar.raw]
        );
        if (hasAnySidecar) {
            for (const id of SPIRE_NODE_IDS) {
                if (!nodeMap[id]) {
                    nodeMap[id] = {
                        id,
                        label: id,
                        // SPIRE nodes have no raw OTel service name — id serves as both
                        isPing: false,
                        isAgentRuntime: true,
                        isBackend: false,
                        isSynthetic: true,
                        icon: _iconFor(id),
                        rawServices: [`${id} (synthetic)`],
                        totalSpans: 0,
                        totalDurationMs: 0,
                        operationCounts: {},
                        spans: [],
                        aggregateStatus: 'ok',
                    };
                }
            }
        }

        // Inject synthetic Open-Meteo API node from Weather Agent CLIENT spans.
        // nodeMap is now keyed by raw service name, so look up the raw key.
        const weatherAgentRaw = AGENT_CONFIGS.find(c => c.nodes.agent?.label === 'Weather Agent')?.nodes.agent?.raw;
        if (weatherAgentRaw && nodeMap[weatherAgentRaw]) {
            const weatherNode = nodeMap[weatherAgentRaw];
            const hasOpenMeteoSpan = weatherNode.spans.some(s => {
                const url = s.tags['http.url'] || s.tags['url.full'] || s.tags['server.address'] || '';
                return String(url).includes('open-meteo.com');
            });
            if (hasOpenMeteoSpan && !nodeMap['Open-Meteo API']) {
                nodeMap['Open-Meteo API'] = {
                    id: 'Open-Meteo API',
                    label: 'Open-Meteo API',
                    isPing: false,
                    isAgentRuntime: false,
                    isBackend: true,
                    isSynthetic: true,
                    icon: _iconFor('Open-Meteo API'),
                    rawServices: ['open-meteo.com (external)'],
                    totalSpans: 0,
                    totalDurationMs: 0,
                    operationCounts: {},
                    spans: [],
                    aggregateStatus: 'ok',
                };
            }
        }

        for (const node of Object.values(nodeMap)) {
            node.rawServices = [...(node.rawServices instanceof Set ? node.rawServices : node.rawServices)].sort();
            node.spans.sort((a, b) => a.startTimeOffsetMs - b.startTimeOffsetMs);
            if (!node.isSynthetic) {
                if (node._hasError && node._hasOk) node.aggregateStatus = 'mixed';
                else if (node._hasError) node.aggregateStatus = 'error';
                else node.aggregateStatus = 'ok';
            }
            delete node._hasOk;
            delete node._hasError;
        }

        // Build edges from span parent-child relationships.
        // Edges use raw service names as source/target IDs (matching nodeMap keys).
        const edgeMap = {};

        for (const span of spans) {
            const childRaw = _serviceName(traceData, span);
            const parentRef = (span.references || []).find(r => r.refType === 'CHILD_OF');
            if (!parentRef) continue;
            const parentSpan = spanIndex[parentRef.spanID];
            if (!parentSpan) continue;
            const parentRaw = _serviceName(traceData, parentSpan);
            if (parentRaw === childRaw) continue;

            const tags = _tagsToObject(span.tags);

            // Skip FastMCP application-layer spans — they propagate trace context
            // via the JSON-RPC envelope, not HTTP headers, so their server spans
            // are parented at the MCP client (AI Agent), bypassing PingGateway.
            // The HTTP transport layer creates the correct PingGateway→MCP edge.
            if (tags['otel.scope.name'] === 'fastmcp') continue;

            // Edge meta lookup: try raw→raw key first, then label→label for static
            // entries (Ping/backend nodes that are still label-keyed in EDGE_META).
            const parentLabel = _labelFor(parentRaw);
            const childLabel  = _labelFor(childRaw);
            const edgeKey = `${parentRaw}->${childRaw}`;
            const edgeKeyByLabel = `${parentLabel}->${childLabel}`;
            if (!edgeMap[edgeKey]) {
                const meta = EDGE_META[edgeKeyByLabel] || { role: 'HTTP', protocol: 'HTTPS' };
                edgeMap[edgeKey] = {
                    source: parentRaw,
                    target: childRaw,
                    sourceLabel: parentLabel,
                    targetLabel: childLabel,
                    role: meta.role,
                    protocol: meta.protocol,
                    callCount: 0,
                    totalDurationMs: 0,
                    outcomes: {},
                    spans: [],
                };
            }
            const edge = edgeMap[edgeKey];
            edge.callCount++;
            edge.totalDurationMs += Math.round((span.duration || 0) / 1000);

            // For sidecar-originated edges, record which Envoy listener owns the
            // call — read straight from the span tree (the listener ancestor of the
            // originating sidecar span), not inferred from the target. This is what
            // lets _expandIntraPod re-anchor the suppressed sidecar's edges onto the
            // correct inbound/outbound listener. parentSpan IS the sidecar span here.
            if (SIDECAR_RAWS.has(parentRaw)) {
                const owner = _nearestEnvoyAncestor(traceData, parentSpan, spanIndex);
                if (owner) {
                    (edge._envoyOwners || (edge._envoyOwners = new Set())).add(owner);
                }
            }

            const statusCode = tags['http.response.status_code'] ?? tags['http.status_code'];
            if (statusCode !== undefined) {
                const key = String(statusCode);
                edge.outcomes[key] = (edge.outcomes[key] || 0) + 1;
            }

            edge.spans.push({
                spanID: span.spanID,
                operationName: span.operationName,
                processName: _serviceName(traceData, span),
                durationMs: Math.round((span.duration || 0) / 1000),
                startTimeOffsetMs: Math.round((span.startTime - traceMinStart) / 1000),
                statusCode: statusCode !== undefined ? String(statusCode) : null,
                status: _statusFor(tags, statusCode),
                tags,
            });
        }

        // Span-derive, per sidecar, which Envoy listeners that sidecar minted a
        // JWT-SVID for. Each `spire.FetchJWTSVID` span sits beneath the listener
        // whose ext_proc filter triggered the mint, so its nearest Envoy ancestor
        // is the true owner. The Trip Planner mints on both paths (inbound
        // exchange + outbound A2A), so a sidecar can map to multiple owners.
        // Consumed by _expandIntraPod to anchor SPIRE edges without guessing.
        const sidecarSpireOwners = {};
        for (const span of spans) {
            if (span.operationName !== 'spire.FetchJWTSVID') continue;
            const raw = _serviceName(traceData, span);
            if (!SIDECAR_RAWS.has(raw)) continue;
            const owner = _nearestEnvoyAncestor(traceData, span, spanIndex);
            if (owner) (sidecarSpireOwners[raw] || (sidecarSpireOwners[raw] = new Set())).add(owner);
        }

        // Inject synthetic SPIRE edges.
        // Each sidecar (identified by raw service name) gets its own edge to
        // SPIRE Workload Agent. SPIRE Server and SPIRE OIDC Bridge are shared
        // infrastructure — one edge from SPIRE Workload Agent → SPIRE Server.
        if (hasAnySidecar) {
            for (const cfg of activeAgentConfigs) {
                if (!cfg.nodes.sidecar) continue;
                const sidecarRaw = cfg.nodes.sidecar.raw;
                if (nodeMap[sidecarRaw]) {
                    _injectSyntheticEdge(edgeMap, sidecarRaw, 'SPIRE Workload Agent', nodeMap);
                }
            }
            _injectSyntheticEdge(edgeMap, 'SPIRE Workload Agent', 'SPIRE Server', nodeMap);
        }

        // Inject synthetic Weather Agent → Open-Meteo API edge (raw key lookup).
        if (weatherAgentRaw && nodeMap[weatherAgentRaw] && nodeMap['Open-Meteo API']) {
            _injectSyntheticEdge(edgeMap, weatherAgentRaw, 'Open-Meteo API', nodeMap);
        }

        for (const edge of Object.values(edgeMap)) {
            edge.avgDurationMs = edge.callCount > 0
                ? Math.round(edge.totalDurationMs / edge.callCount)
                : 0;
            edge.spans.sort((a, b) => a.startTimeOffsetMs - b.startTimeOffsetMs);
        }

        const totalDurationMs = spans.length > 0 ? Math.round((traceMaxEnd - traceMinStart) / 1000) : 0;
        const nodes = Object.values(nodeMap);
        const nodeIds = new Set(nodes.map(n => n.id));
        const edges = Object.values(edgeMap).filter(
            e => nodeIds.has(e.source) && nodeIds.has(e.target)
        );

        const result = {
            nodes,
            edges,
            totalDurationMs,
            traceId: traceData.traceID || '',
            deepLink: `https://jaeger.localhost/trace/${traceData.traceID || ''}`,
            agentConfigs: activeAgentConfigs,
            // Span-derived: raw sidecar → Set of Envoy listener raws it minted for.
            sidecarSpireOwners,
        };

        // Expanded view: split sidecars into their two ports, add the JWKS
        // edge, and tag intra-pod edges with exchangeKind. Collapsed mode
        // calls buildGraph() with no opts, so this is a no-op there.
        return opts.intraPod ? _expandIntraPod(result) : result;
    }

    function _injectSyntheticEdge(edgeMap, source, target, nodeMap) {
        if (!nodeMap[source] || !nodeMap[target]) return;
        const key = `${source}->${target}`;
        if (edgeMap[key]) return;
        // Try raw→raw key first, then label→label for SPIRE/backend static entries.
        const srcLabel = nodeMap[source]?.label || source;
        const tgtLabel = nodeMap[target]?.label || target;
        const meta = EDGE_META[key] || EDGE_META[`${srcLabel}->${tgtLabel}`] || { role: 'internal', protocol: '' };
        edgeMap[key] = {
            source,
            target,
            sourceLabel: srcLabel,
            targetLabel: tgtLabel,
            role: meta.role,
            protocol: meta.protocol,
            callCount: 0,
            totalDurationMs: 0,
            avgDurationMs: 0,
            outcomes: {},
            spans: [],
            isSynthetic: true,
        };
    }

    // ── Intra-pod expansion ────────────────────────────────────────────────────
    // Annotates Envoy listener nodes with their filter-chain captions, adds the
    // jwt_authn JWKS edge, suppresses the authn-sidecar node (it is an internal
    // gRPC plugin of Envoy, not a peer service), and re-anchors its edges to the
    // correct Envoy listener:
    //
    //   Sidecar → SPIRE Workload Agent  →  Envoy that owns the ext_proc role
    //   Sidecar → PingFederate          →  Envoy Inbound (owns the exchange role)
    //   Envoy → sidecar (live gRPC)     →  dropped (internal, now implied by caption)
    //
    // exchangeKind tags on the surviving edges drive dash-pattern rendering:
    //   jwks      — jwt_authn → SPIRE OIDC Bridge
    //   exchange  — Envoy Inbound → PingFederate (RFC 8693)
    //   synthetic — SPIRE infra edges

    function _filterChainLabels(filters) {
        return (filters || []).map(f => {
            if (f.kind === 'jwt_authn') return 'jwt_authn';
            if (f.kind === 'router')   return 'router';
            if (f.kind === 'ext_proc') {
                const role = f.role === 'paz'         ? 'PAZ'
                           : f.role === 'exchange'    ? 'exchange'
                           : f.role === 'mint'        ? 'mint'
                           : f.role === 'header-mint' ? 'mint' : '';
                return role ? `ext_proc (${role})` : 'ext_proc';
            }
            return f.kind;
        });
    }

    /**
     * Expand each agent pod into its real intra-pod data path. Operates on a
     * `buildGraph` result (NOT collapsed). Returns a new {nodes, edges, ...}
     * with filter-chain captions on Envoy nodes, the JWKS edge, sidecar nodes
     * suppressed, and their edges re-anchored to the owning Envoy listener.
     * Never mutates the shared AGENT_CONFIGS objects.
     */
    function _expandIntraPod(graph) {
        const nodeMap = {};
        for (const n of graph.nodes) nodeMap[n.id] = n;

        const agentConfigs = graph.agentConfigs.map(cfg => ({ ...cfg, nodes: { ...cfg.nodes } }));

        // Edges will be rebuilt: start with a mutable copy, then filter at the end.
        const edges = graph.edges.map(e => ({ ...e }));
        const edgeByKey = {};
        for (const e of edges) edgeByKey[`${e.source}->${e.target}`] = e;

        const addEdge = (source, target, sourceLabel, targetLabel, role, protocol, exchangeKind) => {
            const key = `${source}->${target}`;
            if (edgeByKey[key]) { edgeByKey[key].exchangeKind = exchangeKind; return; }
            const e = {
                source, target, sourceLabel, targetLabel, role, protocol,
                exchangeKind, callCount: 0, totalDurationMs: 0, avgDurationMs: 0,
                outcomes: {}, spans: [], isSynthetic: true,
            };
            edgeByKey[key] = e;
            edges.push(e);
        };

        // Sidecar raw ids to suppress — collected across all agent configs.
        const sidecarRaws = new Set();

        // Synthetic nodes injected below (A2A Registry per agent, shared PingIDM).
        // graph.nodes never held them, so they are tracked here and merged into the
        // live node set at the end (step 7).
        const injected = [];

        for (const cfg of agentConfigs) {
            const topo = cfg.topology;
            if (!topo) continue;

            const inboundRaw  = cfg.nodes.inbound?.raw;
            const outboundRaw = cfg.nodes.outbound?.raw;
            const sidecarRaw  = cfg.nodes.sidecar?.raw;

            // 1. Annotate Envoy listener nodes with their ordered filter chain.
            if (inboundRaw && nodeMap[inboundRaw] && topo.inbound) {
                nodeMap[inboundRaw].filterChain = _filterChainLabels(topo.inbound.filters);
            }
            if (outboundRaw && nodeMap[outboundRaw] && topo.outbound) {
                const fork = topo.outbound.fork ? ['tls_inspector'] : [];
                nodeMap[outboundRaw].filterChain = [...fork, ..._filterChainLabels(topo.outbound.filters)];
            }

            // 2. jwt_authn JWKS callout — Envoy Inbound → SPIRE OIDC Bridge.
            const hasJwtAuthn = (topo.inbound?.filters || []).some(f => f.kind === 'jwt_authn');
            if (hasJwtAuthn && inboundRaw && nodeMap[inboundRaw] && nodeMap['SPIRE OIDC Bridge']) {
                addEdge(inboundRaw, 'SPIRE OIDC Bridge',
                    nodeMap[inboundRaw].label, 'SPIRE OIDC Bridge',
                    'JWKS', 'HTTPS', 'jwks');
            }

            // 2.5 A2A registry discovery. When this agent read its sidecar's
            //     registry in THIS trace (the `a2a.discovery.sidecar` span is
            //     present on the agent node), surface the discovery story:
            //       agent → A2A Registry   (real read; rides the discovery span)
            //       PingIDM → A2A Registry (source of truth; static annotation)
            //     The A2A Registry node lives inside this agent's inner cluster
            //     (added to the cloned cfg.nodes); PingIDM lands in the Ping
            //     cluster (isPing) and is shared across agents. Both are
            //     expanded-mode only — _expandIntraPod is never called collapsed.
            const agentRaw = cfg.nodes.agent?.raw;
            const discoverySpan = agentRaw && nodeMap[agentRaw]
                ? (nodeMap[agentRaw].spans || []).find(s => s.operationName === 'a2a.discovery.sidecar')
                : null;
            if (discoverySpan) {
                const registryId = `__a2a_registry_${cfg.clusterLabel}__`;
                if (!nodeMap[registryId]) {
                    const agentCount = parseInt(discoverySpan.tags?.['discovery.agent_count'], 10);
                    const agents = discoverySpan.tags?.['discovery.agents'];
                    const registryNode = {
                        id: registryId,
                        label: 'A2A Registry',
                        isPing: false,
                        isAgentRuntime: true,
                        isBackend: false,
                        isSynthetic: true,
                        icon: _iconFor('A2A Registry'),
                        rawServices: ['localhost:15002/a2a-agents (sidecar cache)'],
                        // Data-driven: real timing + status from the discovery span.
                        totalSpans: 1,
                        totalDurationMs: discoverySpan.durationMs || 0,
                        operationCounts: { 'a2a.discovery.sidecar': 1 },
                        spans: [discoverySpan],
                        aggregateStatus: discoverySpan.status === 'error' ? 'error' : 'ok',
                        discoveryAgentCount: Number.isFinite(agentCount) ? agentCount : null,
                        discoveryAgents: agents ? String(agents) : null,
                    };
                    nodeMap[registryId] = registryNode;
                    injected.push(registryNode);
                    // Add to the cloned cfg so the layout nests it in the inner cluster.
                    cfg.nodes.registry = { raw: registryId, label: 'A2A Registry' };

                    // PingIDM — source of truth, static annotation (rides no span).
                    if (!nodeMap['PingIDM']) {
                        const idmNode = {
                            id: 'PingIDM',
                            label: 'PingIDM',
                            isPing: true,
                            isAgentRuntime: false,
                            isBackend: false,
                            isSynthetic: true,
                            icon: _iconFor('PingIDM'),
                            rawServices: ['pingidm (agent inventory, source of truth)'],
                            totalSpans: 0,
                            totalDurationMs: 0,
                            operationCounts: {},
                            spans: [],
                            aggregateStatus: 'ok',
                        };
                        nodeMap['PingIDM'] = idmNode;
                        injected.push(idmNode);
                    }

                    // Edges: agent → registry (real read), PingIDM → registry (source).
                    if (agentRaw && nodeMap[agentRaw]) {
                        addEdge(agentRaw, registryId,
                            nodeMap[agentRaw].label, 'A2A Registry',
                            'A2A Discovery', 'HTTPS', 'http');
                    }
                    addEdge('PingIDM', registryId,
                        'PingIDM', 'A2A Registry',
                        'Agent Inventory', 'REST', 'synthetic');
                }
            }

            if (!sidecarRaw || !nodeMap[sidecarRaw]) continue;
            sidecarRaws.add(sidecarRaw);

            // 3. Topology-derived owners — used ONLY as a fallback when the trace
            //    has no spans to read ownership from (e.g. synthetic fixtures). The
            //    live path below prefers span-derived ownership, which is correct by
            //    construction. The fallback fixes the historical bug too: a sidecar's
            //    authz-proxy (downstream A2A/MCP) is reached via the listener whose
            //    router targets 'authz_proxy' — the OUTBOUND path, not inbound.
            const inboundFilters  = topo.inbound?.filters  || [];
            const outboundFilters = topo.outbound?.filters || [];
            const inboundHasExchange = inboundFilters.some(f  => f.kind === 'ext_proc' && f.role === 'exchange');
            const inboundHasPaz      = inboundFilters.some(f  => f.kind === 'ext_proc' && f.role === 'paz');
            const routesToAuthzProxy = (filters) => (filters || []).some(f => f.kind === 'router' && f.to === 'authz_proxy');

            const exchangeOwner    = (inboundHasExchange && inboundRaw) ? inboundRaw : outboundRaw;
            const pazOwner         = (inboundHasPaz      && inboundRaw) ? inboundRaw : outboundRaw;
            const authzProxyOwner  = (outboundRaw && routesToAuthzProxy(outboundFilters)) ? outboundRaw
                                   : (inboundRaw  && routesToAuthzProxy(inboundFilters))  ? inboundRaw
                                   : (outboundRaw || inboundRaw);

            // 4. Re-anchor sidecar → SPIRE Workload Agent onto each owning Envoy
            //    listener. Prefer the span-derived owners (every spire.FetchJWTSVID
            //    span sits beneath the listener that triggered the mint); fall back
            //    to the topology owners when the trace has no such spans.
            const spireOwners = new Set(graph.sidecarSpireOwners?.[sidecarRaw] || []);
            if (spireOwners.size === 0) {
                if (exchangeOwner) spireOwners.add(exchangeOwner);
                if (pazOwner)      spireOwners.add(pazOwner);
                if (authzProxyOwner && (outboundFilters.length || routesToAuthzProxy(outboundFilters))) {
                    spireOwners.add(authzProxyOwner);
                }
            }
            for (const owner of spireOwners) {
                if (nodeMap[owner] && nodeMap['SPIRE Workload Agent']) {
                    addEdge(owner, 'SPIRE Workload Agent',
                        nodeMap[owner].label, 'SPIRE Workload Agent',
                        'Workload API', 'Unix socket', 'synthetic');
                }
            }

            // 5. Re-anchor every live sidecar → external edge onto the Envoy
            //    listener that the trace says owns the call. _envoyOwners was filled
            //    in buildGraph by walking each originating span up to its nearest
            //    listener ancestor; when present it is authoritative. Only when an
            //    edge carries no span-derived owner (span-less fixtures) do we fall
            //    back to classifying by target. exchangeKind stays target-derived —
            //    it tags the call semantics (dash rendering), not the data path.
            for (const e of edges) {
                if (e.source !== sidecarRaw) continue;

                const isPingFederate  = e.targetLabel === 'PingFederate'  || e.target === 'acp-pingfederate';
                const isPingAuthorize = e.targetLabel === 'PingAuthorize' || e.target === 'acp-pingauthorize';
                const kind = isPingFederate ? 'exchange' : (e.exchangeKind || 'http');

                let owner = null;
                if (e._envoyOwners && e._envoyOwners.size > 0) {
                    // Span-derived: pick the owner that actually exists as a node.
                    for (const o of e._envoyOwners) { if (nodeMap[o]) { owner = o; break; } }
                } else {
                    // Fallback (no spans): classify by target.
                    owner = isPingFederate  ? exchangeOwner
                          : isPingAuthorize ? pazOwner
                          : authzProxyOwner;
                }

                if (owner && nodeMap[owner]) {
                    e.source = owner;
                    e.sourceLabel = nodeMap[owner].label;
                    e.exchangeKind = kind;
                }
                delete e._envoyOwners;
            }
        }

        // 6. Drop all remaining edges that touch a suppressed sidecar node,
        //    then drop the sidecar nodes themselves. Synthetic discovery nodes
        //    (A2A Registry, PingIDM) injected in step 2.5 are appended here —
        //    they were never in graph.nodes.
        const liveNodes = graph.nodes.filter(n => !sidecarRaws.has(n.id)).concat(injected);
        const liveIds   = new Set(liveNodes.map(n => n.id));
        // Also keep synthetic non-agent nodes (SPIRE, etc.) that were already in nodeMap.
        for (const id of Object.keys(nodeMap)) {
            if (!sidecarRaws.has(id)) liveIds.add(id);
        }
        const liveEdges = edges.filter(e => liveIds.has(e.source) && liveIds.has(e.target));

        return { ...graph, nodes: liveNodes, edges: liveEdges, agentConfigs };
    }

    /**
     * Build a simplified graph where each agent cluster is collapsed to a single node.
     * Intra-cluster edges are dropped; inter-cluster edges are re-mapped to the cluster node.
     */
    function buildCollapsedGraph(traceData, opts = {}) {
        // hideSpire flows straight into buildGraph: with no SPIRE nodes emitted,
        // presentSpireIds below is empty and the SPIRE-folding blocks become no-ops.
        const full = buildGraph(traceData, { hideSpire: opts.hideSpire });
        const { nodes: fullNodes, edges: fullEdges, totalDurationMs, traceId, deepLink, agentConfigs } = full;

        const rawToCollapsedId = {};
        const collapsedIdToLabel = {};
        for (const cfg of agentConfigs) {
            const collapsedId = `__collapsed_${cfg.clusterLabel}__`;
            collapsedIdToLabel[collapsedId] = cfg.clusterLabel;
            for (const { raw } of Object.values(cfg.nodes)) {
                rawToCollapsedId[raw] = collapsedId;
            }
        }

        // Collapse the SPIRE control-plane nodes (SPIRE Server / Workload Agent /
        // OIDC Bridge) into a single 'SPIFFE / SPIRE' node, mirroring how each
        // agent cluster collapses. SPIRE nodes are synthetic and keyed by display
        // label (not raw OTel service), so they map by id here. Edge folding
        // reuses rawToCollapsedId, so agent→SPIRE edges re-anchor automatically.
        const SPIRE_COLLAPSED_ID = '__collapsed_SPIFFE / SPIRE__';
        const presentSpireIds = SPIRE_NODE_IDS.filter(id => fullNodes.some(n => n.id === id));
        if (presentSpireIds.length > 0) {
            collapsedIdToLabel[SPIRE_COLLAPSED_ID] = 'SPIFFE / SPIRE';
            for (const id of presentSpireIds) rawToCollapsedId[id] = SPIRE_COLLAPSED_ID;
        }

        const agentRawIds = new Set(Object.keys(rawToCollapsedId));

        const fullNodeMap = {};
        for (const n of fullNodes) fullNodeMap[n.id] = n;

        const collapsedNodes = [];

        for (const node of fullNodes) {
            if (!agentRawIds.has(node.id)) collapsedNodes.push(node);
        }

        if (presentSpireIds.length > 0) {
            collapsedNodes.push({
                id: SPIRE_COLLAPSED_ID,
                label: 'SPIFFE / SPIRE',
                isPing: false,
                // isAgentRuntime stays false so the renderer styles this node teal
                // (isSpire) rather than purple. Compound layout is still driven by the
                // collapsed agent nodes, which are always present: SPIRE nodes are only
                // injected when an agent-with-sidecar exists (see hasAnySidecar above).
                isAgentRuntime: false,
                isSpire: true,
                isBackend: false,
                isSynthetic: true,
                isCollapsedCluster: true,
                icon: 'fa-fingerprint',
                rawServices: presentSpireIds.slice(),
                totalSpans: 0,
                totalDurationMs: 0,
                operationCounts: {},
                spans: [],
                aggregateStatus: 'ok',
            });
        }

        for (const cfg of agentConfigs) {
            const collapsedId = `__collapsed_${cfg.clusterLabel}__`;
            const agentLabel = cfg.nodes.agent?.label;
            const agentIcon = agentLabel ? (NODE_ICONS[agentLabel] || 'fa-robot') : 'fa-robot';

            const memberNodes = Object.values(cfg.nodes).map(n => fullNodeMap[n.raw]).filter(Boolean);
            const hasError = memberNodes.some(n => n.aggregateStatus === 'error' || n.aggregateStatus === 'mixed');
            const hasOk    = memberNodes.some(n => n.aggregateStatus === 'ok'    || n.aggregateStatus === 'mixed');
            const aggregateStatus = (hasError && hasOk) ? 'mixed' : hasError ? 'error' : 'ok';

            collapsedNodes.push({
                id: collapsedId,
                label: cfg.clusterLabel,
                isPing: false,
                isAgentRuntime: true,
                isBackend: false,
                isSynthetic: false,
                isCollapsedCluster: true,
                icon: agentIcon,
                rawServices: Object.values(cfg.nodes).map(n => n.raw),
                totalSpans: memberNodes.reduce((s, n) => s + n.totalSpans, 0),
                totalDurationMs: memberNodes.reduce((s, n) => s + n.totalDurationMs, 0),
                operationCounts: {},
                spans: [],
                aggregateStatus,
            });
        }

        const collapsedEdgeMap = {};
        for (const edge of fullEdges) {
            const src = rawToCollapsedId[edge.source] || edge.source;
            const tgt = rawToCollapsedId[edge.target] || edge.target;
            if (src === tgt) continue;

            const key = `${src}->${tgt}`;
            if (!collapsedEdgeMap[key]) {
                const srcLabel = collapsedIdToLabel[src] || (fullNodeMap[src]?.label ?? src);
                const tgtLabel = collapsedIdToLabel[tgt] || (fullNodeMap[tgt]?.label ?? tgt);
                collapsedEdgeMap[key] = {
                    source: src,
                    target: tgt,
                    sourceLabel: srcLabel,
                    targetLabel: tgtLabel,
                    role: edge.role,
                    protocol: edge.protocol,
                    callCount: edge.callCount,
                    totalDurationMs: edge.totalDurationMs,
                    avgDurationMs: edge.avgDurationMs,
                    outcomes: { ...edge.outcomes },
                    spans: [...edge.spans],
                    isSynthetic: edge.isSynthetic || false,
                };
            } else {
                const ce = collapsedEdgeMap[key];
                ce.callCount += edge.callCount;
                ce.totalDurationMs += edge.totalDurationMs;
                for (const [code, count] of Object.entries(edge.outcomes || {})) {
                    ce.outcomes[code] = (ce.outcomes[code] || 0) + count;
                }
                ce.spans.push(...edge.spans);
            }
        }

        for (const edge of Object.values(collapsedEdgeMap)) {
            edge.avgDurationMs = edge.callCount > 0 ? Math.round(edge.totalDurationMs / edge.callCount) : 0;
            edge.spans.sort((a, b) => a.startTimeOffsetMs - b.startTimeOffsetMs);
        }

        const collapsedNodeIds = new Set(collapsedNodes.map(n => n.id));
        const collapsedEdges = Object.values(collapsedEdgeMap).filter(
            e => collapsedNodeIds.has(e.source) && collapsedNodeIds.has(e.target)
        );

        return { nodes: collapsedNodes, edges: collapsedEdges, totalDurationMs, traceId, deepLink, agentConfigs, isCollapsed: true };
    }

    return { buildGraph, buildCollapsedGraph, AGENT_CONFIGS };
})();
