/**
 * traceProjector.discovery.test.mjs — guards the A2A Agent Discovery projected
 * span added to lib/traceProjector.js (projectAgentDiscovery).
 *
 * Run: npm test   (Node's built-in test runner — no extra deps)
 *
 * Key invariants:
 *   - A trace with an a2a.discovery.sidecar span on acp-trip-planner-agent
 *     yields exactly one projected span id 'a2a_agent_discovery'.
 *   - Its summary carries the registry headline, the static IDM-source line,
 *     and the comma-spaced agent list.
 *   - status is 'ok' for a 200/success fetch and 'error' for a non-200 or an
 *     unavailable/empty result.
 *   - A trace without the sidecar-fetch span yields no discovery span (the
 *     prefetch/per-agent discovery spans must NOT be projected).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../lib/traceProjector.js';

function span(spanID, processID, op, tags = []) {
    return {
        spanID, processID, operationName: op, startTime: 1000, duration: 12000,
        references: [], tags,
    };
}

function wrap(spans) {
    return {
        data: [{
            traceID: 'disc00000000000000000000000000000',
            processes: { p_tp: { serviceName: 'acp-trip-planner-agent' } },
            spans,
        }],
    };
}

function discoverySpan(extraTags = []) {
    return span('s1', 'p_tp', 'a2a.discovery.sidecar', [
        { key: 'discovery.source', value: 'sidecar' },
        { key: 'discovery.url', value: 'http://localhost:15002/a2a-agents' },
        { key: 'http.status_code', value: 200 },
        { key: 'discovery.result', value: 'success' },
        { key: 'discovery.agent_count', value: 3 },
        { key: 'discovery.agents', value: 'flights,hotels,weather' },
        ...extraTags,
    ]);
}

test('projects an A2A Agent Discovery span from a2a.discovery.sidecar', () => {
    const out = project(wrap([discoverySpan()]));
    const disc = out.spans.find(s => s.id === 'a2a_agent_discovery');
    assert.ok(disc, 'discovery span should be projected');
    assert.equal(disc.title, 'A2A Agent Discovery');
    assert.equal(disc.icon, 'compass');
    assert.equal(disc.status, 'ok');
    assert.equal(disc.durationMs, 12);
    assert.deepEqual(disc.summary, [
        'Sidecar registry · 3 agents',
        'source: IDM-backed registry',
        'agents: flights, hotels, weather',
    ]);
    assert.equal(disc.source, 'acp-trip-planner-agent / a2a.discovery.sidecar');
});

test('marks discovery as error on non-200 status', () => {
    const out = project(wrap([discoverySpan([
        { key: 'http.status_code', value: 503 },
        { key: 'discovery.result', value: 'unavailable' },
    ])]));
    const disc = out.spans.find(s => s.id === 'a2a_agent_discovery');
    assert.ok(disc);
    assert.equal(disc.status, 'error');
    // result is folded into the headline when not "success"
    assert.match(disc.summary[0], /unavailable/);
    assert.equal(out.outcome, 'error');
});

test('marks discovery as error when registry resolves empty', () => {
    const out = project(wrap([discoverySpan([
        { key: 'discovery.result', value: 'empty' },
        { key: 'discovery.agent_count', value: 0 },
    ])]));
    const disc = out.spans.find(s => s.id === 'a2a_agent_discovery');
    assert.ok(disc);
    assert.equal(disc.status, 'error');
    assert.equal(disc.summary[0], 'Sidecar registry · empty · 0 agents');
});

test('does not project prefetch / per-agent discovery spans', () => {
    const out = project(wrap([
        span('s1', 'p_tp', 'a2a.discovery.prefetch', [
            { key: 'discovery.resolution_source', value: 'sidecar' },
            { key: 'discovery.agent_count', value: 3 },
        ]),
        span('s2', 'p_tp', 'a2a.discovery', [
            { key: 'discovery.agent', value: 'weather' },
            { key: 'discovery.resolution_source', value: 'cache' },
        ]),
    ]));
    assert.equal(out.spans.filter(s => s.id === 'a2a_agent_discovery').length, 0);
});
