/**
 * Unit tests for InterruptError sentinel.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InterruptError, isInterruptError } from '../src/agui/interruptError.js';

describe('InterruptError', () => {
    const sample = {
        descriptor: {
            interruptId: 'int-1',
            kind: 'gather-args',
            reason: 'mcp:elicitation:gather-args',
            message: 'pick one',
            responseSchema: { type: 'object', properties: {} },
            metadata: { mode: 'form' }
        },
        continuation: {
            routed: { toolName: 'search_flights', toolArgs: {}, serverKey: 'travel' },
            kind: 'gather-args',
            pendingToolResult: null
        }
    };

    it('subclasses Error and carries descriptor + continuation', () => {
        const err = new InterruptError(sample);
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'InterruptError');
        assert.match(err.message, /int-1/);
        assert.deepEqual(err.descriptor, sample.descriptor);
        assert.deepEqual(err.continuation, sample.continuation);
    });

    it('isInterruptError discriminates', () => {
        assert.equal(isInterruptError(new InterruptError(sample)), true);
        assert.equal(isInterruptError(new Error('plain')), false);
        assert.equal(isInterruptError(null), false);
        assert.equal(isInterruptError(undefined), false);
        assert.equal(isInterruptError({}), false);
    });

    it('isInterruptError requires both descriptor and continuation', () => {
        const halfway = new InterruptError(sample);
        delete halfway.continuation;
        assert.equal(isInterruptError(halfway), false);
    });
});
