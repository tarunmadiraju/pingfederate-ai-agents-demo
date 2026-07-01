/**
 * Unit tests for AguiEventEmitter SSE framing.
 *
 * Uses a fake Express Response that captures every `write()` call so we
 * can inspect the SSE-encoded payloads without spinning up a real socket.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AguiEventEmitter } from '../src/agui/eventEmitter.js';

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.writes = [];
        this.headersSent = false;
        this.writableEnded = false;
        this.destroyed = false;
        this.flushed = false;
    }
    setHeader(key, value) { this.headers[key] = value; }
    flushHeaders() { this.flushed = true; this.headersSent = true; }
    write(chunk) { this.writes.push(chunk); return true; }
    end() { this.writableEnded = true; }
}

/**
 * Strip a single SSE frame's trailing terminator and return the parsed JSON.
 * Each frame must be exactly `data: <json>\n\n`.
 */
function decodeFrame(frame) {
    assert.equal(frame.endsWith('\n\n'), true, `frame must end with \\n\\n: ${JSON.stringify(frame)}`);
    const trimmed = frame.slice(0, -2);
    assert.equal(trimmed.startsWith('data: '), true, `frame must start with "data: ": ${JSON.stringify(frame)}`);
    return JSON.parse(trimmed.slice('data: '.length));
}

describe('AguiEventEmitter', () => {
    let res;
    let emitter;

    beforeEach(() => {
        res = new FakeResponse();
        emitter = new AguiEventEmitter(res);
    });

    it('writes SSE headers on first emission', () => {
        emitter.emitRunStarted('thread-1', 'run-1');
        assert.equal(res.headers['Content-Type'], 'text/event-stream');
        assert.equal(res.headers['Cache-Control'], 'no-cache');
        assert.equal(res.headers['Connection'], 'keep-alive');
        assert.equal(res.headers['X-Accel-Buffering'], 'no');
        assert.equal(res.flushed, true);
    });

    it('frames RUN_STARTED as a single SSE data line', () => {
        emitter.emitRunStarted('thread-1', 'run-1');
        assert.equal(res.writes.length, 1);
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'RUN_STARTED');
        assert.equal(evt.threadId, 'thread-1');
        assert.equal(evt.runId, 'run-1');
    });

    it('frames TEXT_MESSAGE_CONTENT with messageId + delta', () => {
        emitter.emitTextMessageContent('msg-7', 'hello world');
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'TEXT_MESSAGE_CONTENT');
        assert.equal(evt.messageId, 'msg-7');
        assert.equal(evt.delta, 'hello world');
    });

    it('frames TOOL_CALL_RESULT with role=tool and stringified content', () => {
        emitter.emitToolCallResult('msg-9', 'tc-1', JSON.stringify({ count: 3 }));
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'TOOL_CALL_RESULT');
        assert.equal(evt.messageId, 'msg-9');
        assert.equal(evt.toolCallId, 'tc-1');
        assert.equal(evt.role, 'tool');
        assert.equal(JSON.parse(evt.content).count, 3);
    });

    it('frames STATE_SNAPSHOT with full snapshot', () => {
        emitter.emitStateSnapshot({ results: [], error: null });
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'STATE_SNAPSHOT');
        assert.deepEqual(evt.snapshot.results, []);
        assert.equal(evt.snapshot.error, null);
    });

    it('frames STATE_DELTA with the array of patches', () => {
        const patches = [{ op: 'add', path: '/results/-', value: { runId: 'r1' } }];
        emitter.emitStateDelta(patches);
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'STATE_DELTA');
        assert.deepEqual(evt.delta, patches);
    });

    it('frames CUSTOM with name + value', () => {
        emitter.emitCustom('elicitation.declined', { toolName: 'book_flight', action: 'cancel' });
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'CUSTOM');
        assert.equal(evt.name, 'elicitation.declined');
        assert.equal(evt.value.toolName, 'book_flight');
        assert.equal(evt.value.action, 'cancel');
    });

    it('writes multiple events as separate SSE frames', () => {
        emitter.emitRunStarted('t', 'r');
        emitter.emitStepStarted('routing');
        emitter.emitStepFinished('routing');
        emitter.emitRunFinished('t', 'r');
        assert.equal(res.writes.length, 4);
        assert.equal(decodeFrame(res.writes[0]).type, 'RUN_STARTED');
        assert.equal(decodeFrame(res.writes[1]).type, 'STEP_STARTED');
        assert.equal(decodeFrame(res.writes[2]).type, 'STEP_FINISHED');
        assert.equal(decodeFrame(res.writes[3]).type, 'RUN_FINISHED');
    });

    it('emitRunFinished accepts legacy positional result arg', () => {
        emitter.emitRunFinished('t', 'r', { final: true });
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'RUN_FINISHED');
        assert.deepEqual(evt.result, { final: true });
        assert.equal(evt.outcome, undefined);
    });

    it('emitRunFinished accepts options object with outcome (Interrupts)', () => {
        const outcome = {
            type: 'interrupt',
            interrupts: [
                { id: 'int-1', reason: 'gather-args', responseSchema: { type: 'object' } }
            ]
        };
        emitter.emitRunFinished('t', 'r', { outcome });
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'RUN_FINISHED');
        assert.deepEqual(evt.outcome, outcome);
        assert.equal(evt.result, undefined);
    });

    it('emitRunFinished accepts options object with both result and outcome', () => {
        emitter.emitRunFinished('t', 'r', { result: { ok: true }, outcome: { type: 'interrupt', interrupts: [] } });
        const evt = decodeFrame(res.writes[0]);
        assert.deepEqual(evt.result, { ok: true });
        assert.deepEqual(evt.outcome, { type: 'interrupt', interrupts: [] });
    });

    it('emitRunFinished omits both fields when called with no third arg', () => {
        emitter.emitRunFinished('t', 'r');
        const evt = decodeFrame(res.writes[0]);
        assert.equal(evt.type, 'RUN_FINISHED');
        assert.equal(evt.result, undefined);
        assert.equal(evt.outcome, undefined);
    });

    it('end() stops the keep-alive timer and is idempotent', () => {
        emitter.emitRunStarted('t', 'r');
        emitter.end();
        assert.equal(res.writableEnded, true);
        // Second call must not throw.
        emitter.end();
    });
});
