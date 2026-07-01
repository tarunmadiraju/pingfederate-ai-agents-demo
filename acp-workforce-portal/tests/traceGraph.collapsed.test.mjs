/**
 * traceGraph.collapsed.test.mjs — guards the COLLAPSED-mode SPIRE folding in
 * js/traceGraph.js (buildCollapsedGraph).
 *
 * traceGraph.js is a classic browser IIFE, so we load it into a vm context.
 *
 * Run: npm test   (uses Node's built-in test runner — no extra deps)
 *
 * Key invariants:
 *   - The three SPIRE control-plane nodes (SPIRE Server / Workload Agent /
 *     OIDC Bridge) collapse into a single '__collapsed_SPIFFE / SPIRE__' node,
 *     mirroring how each agent cluster collapses to one node.
 *   - That node is teal (isSpire), not purple (isAgentRuntime: false), is a
 *     collapsed cluster, synthetic, and always 'ok'.
 *   - Individual SPIRE nodes are absent in collapsed view.
 *   - Agent→SPIRE edges re-anchor to the collapsed SPIRE node (kept, since
 *     every agent really does depend on SPIRE); intra-SPIRE edges are dropped.
 *   - No SPIRE node is emitted when the trace contains no SPIRE nodes.
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

const SPIRE_COLLAPSED_ID = '__collapsed_SPIFFE / SPIRE__';
const SPIRE_NODE_IDS = ['SPIRE Server', 'SPIRE Workload Agent', 'SPIRE OIDC Bridge'];

function span(spanID, processID, op, parent, tags = []) {
    return {
        spanID, processID, operationName: op, startTime: 1000, duration: 5000,
        references: parent ? [{ refType: 'CHILD_OF', spanID: parent }] : [],
        tags,
    };
}

// ── Weather agent: inbound-only — injects SPIRE nodes via its sidecar ─────────
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
            span('s3', 'p_sc', 'spire.FetchJWTSVID', 's2', [{ key: 'spiffe.audience', value: 'https://pingfed.localhost' }]),
            span('s4', 'p_ag', 'handle', 's1', [{ key: 'http.status_code', value: 200 }]),
        ],
    };
}

// ── Two agents (weather + trip planner): both depend on SPIRE ─────────────────
function twoAgentTrace() {
    return {
        traceID: 'twoagent01',
        processes: {
            w_in: { serviceName: 'acp-weather-agent-envoy-inbound' },
            w_sc: { serviceName: 'acp-weather-agent-identity-sidecar' },
            w_ag: { serviceName: 'acp-weather-agent' },
            t_in: { serviceName: 'acp-trip-planner-agent-proxy-inbound' },
            t_sc: { serviceName: 'acp-trip-planner-agent-identity-sidecar' },
            t_ag: { serviceName: 'acp-trip-planner-agent' },
        },
        spans: [
            // Weather inbound + SPIRE fetch
            span('w1', 'w_in', 'ingress', null, [{ key: 'http.status_code', value: 200 }]),
            span('w2', 'w_sc', 'envoy.service.ext_proc.v3.ExternalProcessor/Process', 'w1'),
            span('w3', 'w_sc', 'spire.FetchJWTSVID', 'w2', [{ key: 'spiffe.audience', value: 'https://pingfed.localhost' }]),
            span('w4', 'w_ag', 'handle', 'w1', [{ key: 'http.status_code', value: 200 }]),
            // Trip planner inbound + SPIRE fetch (separate trace tree, same trace)
            span('t1', 't_in', 'ingress', null, [{ key: 'http.status_code', value: 200 }]),
            span('t2', 't_sc', 'envoy.service.ext_proc.v3.ExternalProcessor/Process', 't1'),
            span('t3', 't_sc', 'spire.FetchJWTSVID', 't2', [{ key: 'spiffe.audience', value: 'https://pingfed.localhost' }]),
            span('t4', 't_ag', 'run', 't1'),
        ],
    };
}

// ── Backend-only trace: no agents, no sidecar → no SPIRE nodes ────────────────
function noSpireTrace() {
    return {
        traceID: 'nospire001',
        processes: {
            p_gw:  { serviceName: 'acp-pinggateway' },
            p_mcp: { serviceName: 'acp-expense-mcp-server' },
        },
        spans: [
            span('g1', 'p_gw', 'proxy', null, [{ key: 'http.status_code', value: 200 }]),
            span('m1', 'p_mcp', 'tools/call', 'g1', [{ key: 'http.status_code', value: 200 }]),
        ],
    };
}

// ── Single collapsed SPIRE node ───────────────────────────────────────────────

test('collapsed: exactly one SPIRE node with id __collapsed_SPIFFE / SPIRE__', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    const spireNodes = g.nodes.filter(n => n.id === SPIRE_COLLAPSED_ID);
    assert.equal(spireNodes.length, 1, 'one collapsed SPIRE node');
    assert.equal(spireNodes[0].label, 'SPIFFE / SPIRE');
    assert.equal(spireNodes[0].icon, 'fa-fingerprint');
});

test('collapsed: SPIRE node is teal, synthetic, collapsed cluster, ok', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    const spire = g.nodes.find(n => n.id === SPIRE_COLLAPSED_ID);
    assert.equal(spire.isSpire, true, 'teal styling flag set');
    assert.equal(spire.isAgentRuntime, false, 'not purple agent-runtime');
    assert.equal(spire.isCollapsedCluster, true, 'rendered as a collapsed cluster node');
    assert.equal(spire.isSynthetic, true, 'marked synthetic (no telemetry)');
    assert.equal(spire.aggregateStatus, 'ok', 'always ok — no error signal');
});

test('collapsed: individual SPIRE nodes are absent', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    for (const id of SPIRE_NODE_IDS) {
        assert.ok(!g.nodes.find(n => n.id === id), `${id} folded away`);
    }
});

test('collapsed: rawServices lists the present SPIRE members', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    const spire = g.nodes.find(n => n.id === SPIRE_COLLAPSED_ID);
    assert.ok(spire.rawServices.includes('SPIRE Workload Agent'), 'membership recorded');
});

// ── Edge folding ──────────────────────────────────────────────────────────────

test('collapsed: agent→SPIRE edge re-anchors to the collapsed SPIRE node', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    const edgesToSpire = g.edges.filter(e => e.target === SPIRE_COLLAPSED_ID);
    assert.ok(edgesToSpire.length > 0, 'at least one edge targets the collapsed SPIRE node');
    // Source must be the collapsed agent cluster, not a raw SPIRE/agent component.
    for (const e of edgesToSpire) {
        assert.ok(e.source.startsWith('__collapsed_'), `source ${e.source} is a collapsed cluster`);
    }
});

test('collapsed: no edge references an individual SPIRE node id', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    for (const e of g.edges) {
        assert.ok(!SPIRE_NODE_IDS.includes(e.source), `edge source ${e.source} not a raw SPIRE id`);
        assert.ok(!SPIRE_NODE_IDS.includes(e.target), `edge target ${e.target} not a raw SPIRE id`);
    }
});

test('collapsed: no self-loop on the collapsed SPIRE node (intra-SPIRE edges dropped)', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    const selfLoop = g.edges.find(e => e.source === SPIRE_COLLAPSED_ID && e.target === SPIRE_COLLAPSED_ID);
    assert.ok(!selfLoop, 'intra-SPIRE edges (Workload Agent → Server) collapse away');
});

test('collapsed: rawServices covers all present SPIRE members', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace());
    const spire = g.nodes.find(n => n.id === SPIRE_COLLAPSED_ID);
    const present = SPIRE_NODE_IDS.filter(() => true); // all three injected when a sidecar agent exists
    assert.deepEqual([...spire.rawServices].sort(), present.sort(), 'all injected SPIRE members recorded');
});

// ── Multi-agent fan-in ────────────────────────────────────────────────────────

test('collapsed: two agents each yield a distinct edge into the single SPIRE node', () => {
    const g = traceGraph.buildCollapsedGraph(twoAgentTrace());
    const spireNodes = g.nodes.filter(n => n.id === SPIRE_COLLAPSED_ID);
    assert.equal(spireNodes.length, 1, 'still exactly one collapsed SPIRE node');

    const edgesToSpire = g.edges.filter(e => e.target === SPIRE_COLLAPSED_ID);
    const sources = new Set(edgesToSpire.map(e => e.source));
    assert.equal(sources.size, 2, 'one edge per collapsed agent cluster (no over-merge)');
    for (const e of edgesToSpire) {
        assert.ok(e.source.startsWith('__collapsed_'), `source ${e.source} is a collapsed cluster`);
        assert.ok(e.source !== SPIRE_COLLAPSED_ID, 'source is an agent, not SPIRE itself');
    }
});

// ── Absence case ──────────────────────────────────────────────────────────────

test('collapsed: no SPIRE node when the trace has none', () => {
    const g = traceGraph.buildCollapsedGraph(noSpireTrace());
    assert.ok(!g.nodes.find(n => n.id === SPIRE_COLLAPSED_ID), 'no collapsed SPIRE node');
    assert.ok(!g.nodes.find(n => n.isSpire), 'no SPIRE-flagged node at all');
});

// ── hideSpire opt: the "business-flow only" view ──────────────────────────────
// The Show/Hide SPIFFE-SPIRE toggle passes { hideSpire: true } into the builder.
// SPIRE is leaf-only (sidecar→Workload→Server), so suppressing the node injection
// drops every incident edge automatically — no business flow is severed.

test('collapsed hideSpire: no collapsed SPIRE node, default shows it', () => {
    const shown = traceGraph.buildCollapsedGraph(weatherTrace());
    assert.ok(shown.nodes.find(n => n.id === SPIRE_COLLAPSED_ID), 'shown by default');

    const hidden = traceGraph.buildCollapsedGraph(weatherTrace(), { hideSpire: true });
    assert.ok(!hidden.nodes.find(n => n.id === SPIRE_COLLAPSED_ID), 'collapsed SPIRE node gone');
    assert.ok(!hidden.nodes.find(n => n.isSpire), 'no SPIRE-flagged node at all');
});

test('collapsed hideSpire: no edge touches any SPIRE node', () => {
    const g = traceGraph.buildCollapsedGraph(weatherTrace(), { hideSpire: true });
    for (const e of g.edges) {
        assert.ok(e.source !== SPIRE_COLLAPSED_ID && e.target !== SPIRE_COLLAPSED_ID,
            'no edge references the collapsed SPIRE node');
        assert.ok(!SPIRE_NODE_IDS.includes(e.source) && !SPIRE_NODE_IDS.includes(e.target),
            'no edge references a raw SPIRE id');
    }
});

test('collapsed hideSpire: business nodes survive (agent cluster + MCP path intact)', () => {
    const g = traceGraph.buildCollapsedGraph(twoAgentTrace(), { hideSpire: true });
    const agentClusters = g.nodes.filter(n => n.isCollapsedCluster && n.isAgentRuntime);
    assert.equal(agentClusters.length, 2, 'both agent clusters remain after hiding SPIRE');
});
