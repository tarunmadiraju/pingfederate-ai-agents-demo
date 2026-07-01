/**
 * traceGraph.intraPod.test.mjs — guards the EXPANDED intra-pod expansion in
 * js/traceGraph.js (_expandIntraPod).
 *
 * traceGraph.js is a classic browser IIFE, so we load it into a vm context.
 *
 * Run: npm test   (uses Node's built-in test runner — no extra deps)
 *
 * Key invariants:
 *   - authn-sidecar is NOT a visible node in expanded view; it is an internal
 *     gRPC plugin of Envoy, surfaced only via filter-chain captions.
 *   - Its edges (SPIRE Workload API, RFC 8693) are re-anchored to the Envoy
 *     listener that owns the ext_proc role.
 *   - Envoy Inbound owns 'exchange' (inbound :9011) and Envoy Outbound owns
 *     'mint' (outbound :9010) for the Trip Planner.
 *   - Inbound-only agents (Weather, Flight, Hotel) have no outbound node; their
 *     single sidecar SPIRE edge anchors to Envoy Inbound.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(join(__dirname, '..', 'js', 'traceGraph.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__tg = traceGraph;', ctx);
const traceGraph = ctx.__tg;

function span(spanID, processID, op, parent, tags = []) {
    return {
        spanID, processID, operationName: op, startTime: 1000, duration: 5000,
        references: parent ? [{ refType: 'CHILD_OF', spanID: parent }] : [],
        tags,
    };
}

// ── Weather agent: inbound-only, jwt_authn + ext_proc(PAZ) ───────────────────
function weatherTrace() {
    return {
        traceID: 'weather0001',
        processes: {
            p_in: { serviceName: 'acp-weather-agent-envoy-inbound' },
            p_sc: { serviceName: 'acp-weather-agent-identity-sidecar' },
            p_ag: { serviceName: 'acp-weather-agent' },
        },
        spans: [
            span('s1', 'p_in', 'ingress', null, [{ key: 'http.status_code', value: 200 }]),
            span('s2', 'p_sc', 'envoy.service.ext_proc.v3.ExternalProcessor/Process', 's1'),
            span('s3', 'p_sc', 'paz.authorization', 's2', [{ key: 'paz.decision', value: 'PERMIT' }]),
            span('s4', 'p_ag', 'handle', 's1', [{ key: 'http.status_code', value: 200 }]),
        ],
    };
}

// ── Trip Planner: inbound exchange (:9011) + outbound mint (:9010) ────────────
// Models the full A2A outbound data path observed in real traces:
//   app → Envoy Outbound → router authz_proxy → sidecar authz-proxy (:15002)
//       → HTTP POST → downstream agent's Envoy Inbound
// The downstream-agent edge (sidecar → weather inbound) is the case the static
// owner heuristic anchored to the WRONG listener (inbound); the originating
// sidecar span sits beneath proxy-OUTBOUND, so span-derived ownership fixes it.
function tripPlannerTrace() {
    return {
        traceID: 'trip0001',
        processes: {
            p_in:  { serviceName: 'acp-trip-planner-agent-proxy-inbound' },
            p_out: { serviceName: 'acp-trip-planner-agent-proxy-outbound' },
            p_sc:  { serviceName: 'acp-trip-planner-agent-identity-sidecar' },
            p_ag:  { serviceName: 'acp-trip-planner-agent' },
            p_pf:  { serviceName: 'acp-pingfederate' },
            p_win: { serviceName: 'acp-weather-agent-envoy-inbound' },
        },
        spans: [
            // Inbound: Envoy Inbound → sidecar :9011 → exchange → app
            span('i1', 'p_in', 'ingress', null, [{ key: 'http.status_code', value: 200 }]),
            span('i2', 'p_sc', 'envoy.service.ext_proc.v3.ExternalProcessor/Process', 'i1'),
            span('i3', 'p_sc', 'spire.FetchJWTSVID', 'i2', [{ key: 'spiffe.audience', value: 'https://pingfed.localhost' }]),
            span('i4', 'p_sc', 'oauth.token_exchange', 'i2', [{ key: 'oauth.cache_hit', value: false }]),
            span('pf1', 'p_pf', 'POST /as/token', 'i4', [{ key: 'http.status_code', value: 200 }]),
            span('i5', 'p_ag', 'run', 'i1'),
            // Outbound: app → Envoy Outbound → sidecar :9010 → mint → authz-proxy → A2A
            span('o1', 'p_out', 'egress', 'i5', [{ key: 'http.status_code', value: 200 }]),
            span('o2', 'p_sc', 'envoy.service.ext_proc.v3.ExternalProcessor/Process', 'o1'),
            span('o3', 'p_sc', 'spire.FetchJWTSVID', 'o2', [{ key: 'spiffe.audience', value: 'https://acp-weather-agent.localhost' }]),
            // authz_proxy router → sidecar :15002 → HTTP POST → downstream agent inbound
            span('o4', 'p_out', 'router authz_proxy egress', 'o1', [{ key: 'http.status_code', value: 200 }]),
            span('o5', 'p_sc', 'authz-proxy', 'o4'),
            span('o6', 'p_sc', 'HTTP POST', 'o5', [{ key: 'http.status_code', value: 200 }]),
            span('w1', 'p_win', 'ingress', 'o6', [{ key: 'http.status_code', value: 200 }]),
        ],
    };
}

// ── Sidecar suppression ───────────────────────────────────────────────────────

test('inbound-only agent: no sidecar node in expanded view', () => {
    const g = traceGraph.buildGraph(weatherTrace(), { intraPod: true });
    const sidecarNode = g.nodes.find(n => n.id === 'acp-weather-agent-identity-sidecar');
    assert.ok(!sidecarNode, 'authn-sidecar node suppressed');
});

test('trip planner: no sidecar node in expanded view', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const sidecarNode = g.nodes.find(n => n.id === 'acp-trip-planner-agent-identity-sidecar');
    assert.ok(!sidecarNode, 'authn-sidecar node suppressed');
});

// ── Filter-chain captions ─────────────────────────────────────────────────────

test('weather: inbound filter chain caption matches Envoy bootstrap', () => {
    const g = traceGraph.buildGraph(weatherTrace(), { intraPod: true });
    const inbound = g.nodes.find(n => n.id === 'acp-weather-agent-envoy-inbound');
    assert.deepEqual([...inbound.filterChain], ['jwt_authn', 'ext_proc (PAZ)', 'router']);
});

test('trip planner: inbound filter chain shows ext_proc (exchange) › router', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const inbound = g.nodes.find(n => n.id === 'acp-trip-planner-agent-proxy-inbound');
    assert.deepEqual([...inbound.filterChain], ['ext_proc (exchange)', 'router']);
});

test('trip planner: outbound filter chain shows tls_inspector › ext_proc (mint) › router', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const outbound = g.nodes.find(n => n.id === 'acp-trip-planner-agent-proxy-outbound');
    assert.deepEqual([...outbound.filterChain], ['tls_inspector', 'ext_proc (mint)', 'router']);
});

// ── SPIRE edge re-anchoring ───────────────────────────────────────────────────

test('inbound-only agent: SPIRE edge anchored to Envoy Inbound', () => {
    const g = traceGraph.buildGraph(weatherTrace(), { intraPod: true });
    const spireEdge = g.edges.find(e => e.target === 'SPIRE Workload Agent');
    assert.ok(spireEdge, 'SPIRE Workload Agent edge present');
    assert.equal(spireEdge.source, 'acp-weather-agent-envoy-inbound', 'anchored to Envoy Inbound');
});

test('trip planner: SPIRE edge from Envoy Inbound (exchange owner)', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const spireEdges = g.edges.filter(e => e.target === 'SPIRE Workload Agent');
    const sources = new Set(spireEdges.map(e => e.source));
    assert.ok(sources.has('acp-trip-planner-agent-proxy-inbound'), 'Envoy Inbound has SPIRE edge');
});

test('trip planner: SPIRE edge from Envoy Outbound (mint owner)', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const spireEdges = g.edges.filter(e => e.target === 'SPIRE Workload Agent');
    const sources = new Set(spireEdges.map(e => e.source));
    assert.ok(sources.has('acp-trip-planner-agent-proxy-outbound'), 'Envoy Outbound has SPIRE edge');
});

// ── RFC 8693 edge re-anchoring ────────────────────────────────────────────────

test('trip planner: PingFederate edge re-anchored to Envoy Inbound, tagged exchange', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const pfEdge = g.edges.find(e => e.target === 'acp-pingfederate');
    assert.ok(pfEdge, 'PingFederate edge present');
    assert.equal(pfEdge.source, 'acp-trip-planner-agent-proxy-inbound', 'anchored to Envoy Inbound');
    assert.equal(pfEdge.exchangeKind, 'exchange');
});

// ── Downstream A2A edge re-anchoring (the outbound-vs-inbound bug) ────────────

test('trip planner: downstream A2A edge anchored to Envoy Outbound, not Inbound', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    // The sidecar's authz-proxy call to the downstream agent must surface as an
    // edge FROM Envoy Outbound (the listener whose router targets authz_proxy),
    // never from Envoy Inbound — the originating span sits beneath outbound.
    const a2aEdge = g.edges.find(e => e.target === 'acp-weather-agent-envoy-inbound');
    assert.ok(a2aEdge, 'downstream A2A edge present');
    assert.equal(a2aEdge.source, 'acp-trip-planner-agent-proxy-outbound', 'anchored to Envoy Outbound');
    assert.notEqual(a2aEdge.source, 'acp-trip-planner-agent-proxy-inbound', 'NOT anchored to Envoy Inbound');
});

test('trip planner: no edge leaks from a suppressed sidecar node', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const leaks = g.edges.filter(e => e.source.includes('identity-sidecar') || e.target.includes('identity-sidecar'));
    assert.equal(leaks.length, 0, 'all sidecar edges re-anchored to an Envoy listener');
});

// ── PingAuthorize edge re-anchoring ──────────────────────────────────────────

test('inbound PAZ edge re-anchored to Envoy Inbound', () => {
    // Extend weatherTrace with a live PAZ sideband span (sidecar → PingAuthorize).
    const trace = weatherTrace();
    trace.processes.p_paz = { serviceName: 'acp-pingauthorize' };
    trace.spans.push(
        { spanID: 'paz1', processID: 'p_paz', operationName: 'POST /api/authz',
          startTime: 1000, duration: 2000,
          references: [{ refType: 'CHILD_OF', spanID: 's3' }], tags: [] }
    );
    const g = traceGraph.buildGraph(trace, { intraPod: true });
    const pazEdge = g.edges.find(e => e.target === 'acp-pingauthorize' || e.targetLabel === 'PingAuthorize');
    assert.ok(pazEdge, 'PingAuthorize edge present');
    assert.equal(pazEdge.source, 'acp-weather-agent-envoy-inbound', 'anchored to Envoy Inbound');
});

// ── JWKS edge ─────────────────────────────────────────────────────────────────

test('jwt_authn JWKS edge connects SPIRE OIDC Bridge from Envoy Inbound', () => {
    const g = traceGraph.buildGraph(weatherTrace(), { intraPod: true });
    const jwksEdge = g.edges.find(e => e.target === 'SPIRE OIDC Bridge');
    assert.ok(jwksEdge, 'SPIRE OIDC Bridge edge present');
    assert.equal(jwksEdge.source, 'acp-weather-agent-envoy-inbound');
    assert.equal(jwksEdge.exchangeKind, 'jwks');
});

// ── hideSpire opt: expanded "business-flow only" view ─────────────────────────
// With { hideSpire: true } the SPIRE nodes are never injected, so _expandIntraPod's
// JWKS / Workload-API edges short-circuit on the missing endpoints and drop out.

test('expanded hideSpire: no SPIRE node and no JWKS edge', () => {
    const shown = traceGraph.buildGraph(weatherTrace(), { intraPod: true });
    assert.ok(shown.edges.find(e => e.target === 'SPIRE OIDC Bridge'), 'JWKS edge shown by default');

    const g = traceGraph.buildGraph(weatherTrace(), { intraPod: true, hideSpire: true });
    assert.ok(!g.nodes.find(n => n.isSpire || /^SPIRE /.test(n.id)), 'no SPIRE node');
    assert.ok(!g.edges.find(e => /^SPIRE /.test(e.target) || /^SPIRE /.test(e.source)),
        'no edge touches a SPIRE node (JWKS + Workload API dropped)');
});

test('expanded hideSpire: Envoy listeners and business edges survive', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true, hideSpire: true });
    assert.ok(g.nodes.find(n => n.id === 'acp-trip-planner-agent-proxy-inbound'), 'Envoy Inbound kept');
    assert.ok(g.nodes.find(n => n.id === 'acp-trip-planner-agent-proxy-outbound'), 'Envoy Outbound kept');
});

// ── A2A registry discovery node + PingIDM source (expanded view only) ────────
// When the agent read its sidecar's registry in THIS trace (the
// a2a.discovery.sidecar span is present on the agent node), the expanded view
// surfaces a synthetic A2A Registry node (data-driven off that span) inside the
// agent's cluster, plus a static PingIDM "source of truth" node in the Ping
// cluster. Both are expanded-mode only.

// Trip planner trace carrying the discovery span on the agent node.
function tripPlannerDiscoveryTrace() {
    const t = tripPlannerTrace();
    t.spans.push(
        span('d1', 'p_ag', 'a2a.discovery.sidecar', 'i5', [
            { key: 'discovery.agent_count', value: 3 },
            { key: 'discovery.agents', value: 'weather, flights, hotels' },
            { key: 'http.status_code', value: 200 },
        ])
    );
    return t;
}

test('discovery: A2A Registry node injected in trip planner cluster, data-driven off span', () => {
    const g = traceGraph.buildGraph(tripPlannerDiscoveryTrace(), { intraPod: true });
    const reg = g.nodes.find(n => n.label === 'A2A Registry');
    assert.ok(reg, 'A2A Registry node present');
    assert.ok(reg.isSynthetic, 'registry node is synthetic');
    assert.ok(reg.isAgentRuntime, 'registry node is agent-runtime (purple)');
    assert.equal(reg.discoveryAgentCount, 3, 'agent count pulled from span');
    assert.equal(reg.discoveryAgents, 'weather, flights, hotels', 'agents pulled from span');
    assert.equal(reg.totalDurationMs, 5, 'duration pulled from span (5000us → 5ms)');
    assert.equal(reg.aggregateStatus, 'ok', 'status ok from 200 span');
    // Nested in the Trip Planner cluster via the cloned cfg.nodes.registry.
    const cfg = g.agentConfigs.find(c => c.clusterLabel === 'Trip Planner Agent');
    assert.equal(cfg.nodes.registry?.raw, reg.id, 'registry added to cloned cfg.nodes for layout nesting');
});

test('discovery: PingIDM source node injected into Ping cluster, static', () => {
    const g = traceGraph.buildGraph(tripPlannerDiscoveryTrace(), { intraPod: true });
    const idm = g.nodes.find(n => n.id === 'PingIDM');
    assert.ok(idm, 'PingIDM node present');
    assert.ok(idm.isPing, 'PingIDM lands in the Ping cluster');
    assert.ok(idm.isSynthetic, 'PingIDM is synthetic');
    assert.equal(idm.totalSpans, 0, 'PingIDM is a static annotation (rides no span)');
});

test('discovery: agent→Registry and PingIDM→Registry edges wired', () => {
    const g = traceGraph.buildGraph(tripPlannerDiscoveryTrace(), { intraPod: true });
    const reg = g.nodes.find(n => n.label === 'A2A Registry');
    const readEdge = g.edges.find(e => e.target === reg.id && e.source === 'acp-trip-planner-agent');
    assert.ok(readEdge, 'agent → A2A Registry edge present');
    assert.equal(readEdge.role, 'A2A Discovery');
    const idmEdge = g.edges.find(e => e.target === reg.id && e.source === 'PingIDM');
    assert.ok(idmEdge, 'PingIDM → A2A Registry edge present');
    assert.equal(idmEdge.role, 'Agent Inventory');
    assert.ok(idmEdge.isSynthetic, 'IDM edge is synthetic (dashed)');
});

test('discovery: no registry/PingIDM node when discovery span absent', () => {
    const g = traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    assert.ok(!g.nodes.find(n => n.label === 'A2A Registry'), 'no registry node without discovery span');
    assert.ok(!g.nodes.find(n => n.id === 'PingIDM'), 'no PingIDM node without discovery span');
});

test('discovery: nodes never appear in collapsed view', () => {
    const g = traceGraph.buildCollapsedGraph(tripPlannerDiscoveryTrace());
    assert.ok(!g.nodes.find(n => n.label === 'A2A Registry'), 'no registry node when collapsed');
    assert.ok(!g.nodes.find(n => n.id === 'PingIDM'), 'no PingIDM node when collapsed');
});

test('discovery: error status on registry node when discovery span errored', () => {
    const t = tripPlannerTrace();
    t.spans.push(
        span('d1', 'p_ag', 'a2a.discovery.sidecar', 'i5', [
            { key: 'discovery.agent_count', value: 0 },
            { key: 'http.status_code', value: 503 },
        ])
    );
    const g = traceGraph.buildGraph(t, { intraPod: true });
    const reg = g.nodes.find(n => n.label === 'A2A Registry');
    assert.ok(reg, 'registry node present');
    assert.equal(reg.aggregateStatus, 'error', 'registry node red on errored discovery');
});

// ── Collapsed view and mutation guard ────────────────────────────────────────

test('collapsed view is unaffected: no sidecar suppression leaks', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    assert.ok(!g.nodes.some(n => n.id.includes('::')), 'no split nodes');
});

test('expansion never mutates shared AGENT_CONFIGS', () => {
    const before = traceGraph.AGENT_CONFIGS.find(c => c.clusterLabel === 'Weather Agent').nodes.sidecar.raw;
    traceGraph.buildGraph(weatherTrace(), { intraPod: true });
    traceGraph.buildGraph(tripPlannerTrace(), { intraPod: true });
    const after = traceGraph.AGENT_CONFIGS.find(c => c.clusterLabel === 'Weather Agent').nodes.sidecar.raw;
    assert.equal(after, before);
    assert.equal(after, 'acp-weather-agent-identity-sidecar');
});
