/**
 * traceProjector.reasoning.test.mjs — guards the unified Agent Reasoning
 * projected span (projectAgentReasoning) shared by the Workforce AI Agent and
 * the Trip Planner.
 *
 * Run: npm test   (Node's built-in test runner — no extra deps)
 *
 * Both agents emit one OTel span named `agent.reasoning` carrying the shared
 * attribute schema: reasoning.mode / reasoning.model / reasoning.candidates /
 * reasoning.chosen / reasoning.fallback(+_reason). One builder renders all four
 * selector cases:
 *   1. Workforce · keyword     — mode keyword, candidates = tool catalog, rule
 *   2. Workforce · llm         — mode llm, model, candidates, chosen (1 tool)
 *   3. Trip Planner · llm      — mode llm, chosen subset with (N of M) count
 *   4. Trip Planner · fallback — llm degraded to keyword → status:error
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

function wrap(serviceName, tags) {
    return {
        data: [{
            traceID: 'reas00000000000000000000000000000',
            processes: { p1: { serviceName } },
            spans: [span('s1', 'p1', 'agent.reasoning', tags)],
        }],
    };
}

function tag(key, value) {
    return { key, value };
}

// OTel string-array attributes are stored by Jaeger as a JSON-encoded string
// (no array tag type), so reasoning.candidates / reasoning.chosen arrive on the
// wire as e.g. '["list_expenses","submit_expense"]'. Mirror that here so the
// tests guard the real projector input, not an idealized JS array.
function listTag(key, arr) {
    return { key, value: JSON.stringify(arr) };
}

test('Workforce · keyword — renders mode, candidates and matched rule', () => {
    const out = project(wrap('acp-workforce-ai-agent', [
        tag('reasoning.mode', 'keyword'),
        listTag('reasoning.candidates', ['list_expenses', 'submit_expense', 'search_flights']),
        listTag('reasoning.chosen', ['search_flights']),
        tag('reasoning.rule', 'flight_search'),
    ]));
    const r = out.spans.find(s => s.id === 'agent_reasoning');
    assert.ok(r, 'reasoning span should be projected');
    assert.equal(r.title, 'Agent Reasoning');
    assert.equal(r.icon, 'brain');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.summary, [
        'Keyword routing',
        'considered: list_expenses, submit_expense, search_flights',
        'chose: search_flights (1 of 3)',
        'rule: flight_search',
    ]);
    assert.equal(out.outcome, 'ok');
});

test('Workforce · llm — renders model and chosen tool', () => {
    const out = project(wrap('acp-workforce-ai-agent', [
        tag('reasoning.mode', 'llm'),
        tag('reasoning.model', 'qwen2.5'),
        listTag('reasoning.candidates', ['list_expenses', 'submit_expense', 'search_flights']),
        listTag('reasoning.chosen', ['search_flights']),
    ]));
    const r = out.spans.find(s => s.id === 'agent_reasoning');
    assert.ok(r);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.summary, [
        'LLM routing · model: qwen2.5',
        'considered: list_expenses, submit_expense, search_flights',
        'chose: search_flights (1 of 3)',
    ]);
});

test('Trip Planner · llm — renders chosen subset with (N of M) count', () => {
    const out = project(wrap('acp-trip-planner-agent', [
        tag('reasoning.mode', 'llm'),
        tag('reasoning.model', 'llama3.2'),
        listTag('reasoning.candidates', ['weather', 'flights', 'hotels']),
        listTag('reasoning.chosen', ['weather', 'hotels']),
    ]));
    const r = out.spans.find(s => s.id === 'agent_reasoning');
    assert.ok(r);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.summary, [
        'LLM routing · model: llama3.2',
        'considered: weather, flights, hotels',
        'chose: weather, hotels (2 of 3)',
    ]);
});

test('Trip Planner · fallback — degrade is rendered as an error span', () => {
    const out = project(wrap('acp-trip-planner-agent', [
        tag('reasoning.mode', 'keyword'),
        listTag('reasoning.candidates', ['weather', 'flights', 'hotels']),
        listTag('reasoning.chosen', ['weather', 'hotels', 'flights']),
        tag('reasoning.fallback', true),
        tag('reasoning.fallback_reason', 'ollama_unreachable'),
    ]));
    const r = out.spans.find(s => s.id === 'agent_reasoning');
    assert.ok(r);
    assert.equal(r.status, 'error');
    assert.equal(r.summary[0], '⚠ requested LLM — fell back to keyword (ollama_unreachable)');
    assert.deepEqual(r.summary, [
        '⚠ requested LLM — fell back to keyword (ollama_unreachable)',
        'considered: weather, flights, hotels',
        'chose: weather, hotels, flights (3 of 3)',
    ]);
    // Fallback deliberately escalates the whole-trace outcome.
    assert.equal(out.outcome, 'error');
});

test('tolerates list attributes that arrive as a real JS array (defensive)', () => {
    const out = project(wrap('acp-workforce-ai-agent', [
        tag('reasoning.mode', 'keyword'),
        // Not JSON-encoded — a raw array, as a future exporter might deliver.
        tag('reasoning.candidates', ['list_expenses', 'submit_expense']),
        tag('reasoning.chosen', ['list_expenses']),
        tag('reasoning.rule', 'draft'),
    ]));
    const r = out.spans.find(s => s.id === 'agent_reasoning');
    assert.ok(r);
    assert.deepEqual(r.summary, [
        'Keyword routing',
        'considered: list_expenses, submit_expense',
        'chose: list_expenses (1 of 2)',
        'rule: draft',
    ]);
});

// ---------------------------------------------------------------------------
// Trip Planner Orchestration — router label must mirror agent.reasoning's mode,
// not a hardcoded string. (Regression: the card said "keyword router" even in
// LLM mode because the label was a constant.)
// ---------------------------------------------------------------------------

function tripPlannerTrace(reasoningTags) {
    const spans = [
        span('s1', 'p1', 'POST /api/trip-planner/run', [
            tag('http.status_code', '200'),
        ]),
    ];
    if (reasoningTags) spans.push(span('s2', 'p1', 'agent.reasoning', reasoningTags));
    return {
        data: [{
            traceID: 'reas00000000000000000000000000000',
            processes: { p1: { serviceName: 'acp-trip-planner-agent' } },
            spans,
        }],
    };
}

test('Orchestration — reports "LLM router" when reasoning.mode is llm', () => {
    const out = project(tripPlannerTrace([
        tag('reasoning.mode', 'llm'),
        tag('reasoning.model', 'qwen2.5:3b'),
        listTag('reasoning.candidates', ['weather', 'flights', 'hotels']),
        listTag('reasoning.chosen', ['flights', 'hotels', 'weather']),
    ]));
    const o = out.spans.find(s => s.id === 'trip_planner_orchestration');
    assert.ok(o, 'orchestration span should be projected');
    assert.equal(o.summary, 'AG-UI run · LLM router → A2A delegation');
});

test('Orchestration — reports "keyword router" when reasoning.mode is keyword', () => {
    const out = project(tripPlannerTrace([
        tag('reasoning.mode', 'keyword'),
        listTag('reasoning.candidates', ['weather', 'flights', 'hotels']),
        listTag('reasoning.chosen', ['weather']),
    ]));
    const o = out.spans.find(s => s.id === 'trip_planner_orchestration');
    assert.equal(o.summary, 'AG-UI run · keyword router → A2A delegation');
});

test('Orchestration — a silent llm→keyword fallback reports "keyword router"', () => {
    const out = project(tripPlannerTrace([
        tag('reasoning.mode', 'keyword'),
        tag('reasoning.fallback', true),
        tag('reasoning.fallback_reason', 'ollama_unreachable'),
        listTag('reasoning.candidates', ['weather', 'flights', 'hotels']),
        listTag('reasoning.chosen', ['weather', 'flights', 'hotels']),
    ]));
    const o = out.spans.find(s => s.id === 'trip_planner_orchestration');
    assert.equal(o.summary, 'AG-UI run · keyword router → A2A delegation');
});

test('Orchestration — falls back to generic "router" when no reasoning span', () => {
    const out = project(tripPlannerTrace(null));
    const o = out.spans.find(s => s.id === 'trip_planner_orchestration');
    assert.equal(o.summary, 'AG-UI run · router → A2A delegation');
});

test('a trace without an agent.reasoning span yields no reasoning card', () => {
    const out = project({
        data: [{
            traceID: 'reas00000000000000000000000000000',
            processes: { p1: { serviceName: 'acp-trip-planner-agent' } },
            spans: [span('s1', 'p1', 'a2a.discovery.sidecar', [])],
        }],
    });
    assert.equal(out.spans.filter(s => s.id === 'agent_reasoning').length, 0);
});
