/**
 * Unit tests for the AG-UI interrupt continuation store.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    save,
    claim,
    evictExpired,
    size,
    _reset,
    INTERRUPT_TTL_MS
} from '../src/agui/interruptStore.js';

describe('interruptStore', () => {
    beforeEach(() => {
        _reset();
    });

    it('saves and claims a continuation in one shot', () => {
        save('int-1', {
            threadId: 't1',
            routed: { toolName: 'list_expenses', toolArgs: {}, serverKey: 'expense' },
            kind: 'gather-args'
        });
        assert.equal(size(), 1);

        const ctx = claim('int-1');
        assert.equal(ctx.threadId, 't1');
        assert.equal(ctx.routed.toolName, 'list_expenses');
        assert.equal(ctx.kind, 'gather-args');
        assert.equal(typeof ctx.expiresAt, 'number');
        assert.equal(size(), 0, 'claim removes the entry');
    });

    it('returns null for unknown ids', () => {
        assert.equal(claim('missing'), null);
    });

    it('claim is single-use', () => {
        save('int-2', { threadId: 't', routed: {}, kind: 'url' });
        assert.notEqual(claim('int-2'), null);
        assert.equal(claim('int-2'), null);
    });

    it('claim returns null and removes entry when expired', () => {
        save('int-3', {
            threadId: 't',
            routed: {},
            kind: 'confirm-destructive',
            expiresAt: Date.now() - 1
        });
        assert.equal(size(), 1);
        assert.equal(claim('int-3'), null);
        assert.equal(size(), 0);
    });

    it('applies default TTL when expiresAt is omitted', () => {
        const before = Date.now();
        save('int-4', { threadId: 't', routed: {}, kind: 'gather-args' });
        const ctx = claim('int-4');
        assert.ok(ctx.expiresAt >= before + INTERRUPT_TTL_MS - 50);
        assert.ok(ctx.expiresAt <= Date.now() + INTERRUPT_TTL_MS);
    });

    it('evictExpired clears only past-due entries', () => {
        save('alive', { threadId: 't', routed: {}, kind: 'url', expiresAt: Date.now() + 60_000 });
        save('dead-1', { threadId: 't', routed: {}, kind: 'url', expiresAt: Date.now() - 1 });
        save('dead-2', { threadId: 't', routed: {}, kind: 'url', expiresAt: Date.now() - 1000 });
        const evicted = evictExpired();
        assert.equal(evicted, 2);
        assert.equal(size(), 1);
        assert.notEqual(claim('alive'), null);
    });

    it('rejects empty/non-string ids', () => {
        assert.throws(() => save('', { threadId: 't', routed: {}, kind: 'url' }));
        assert.throws(() => save(null, { threadId: 't', routed: {}, kind: 'url' }));
    });

    it('rejects missing ctx', () => {
        assert.throws(() => save('int-x', null));
    });

    it('overwrites prior entry for the same id (last writer wins)', () => {
        save('dup', { threadId: 't1', routed: {}, kind: 'gather-args' });
        save('dup', { threadId: 't2', routed: {}, kind: 'url' });
        assert.equal(size(), 1);
        const ctx = claim('dup');
        assert.equal(ctx.threadId, 't2');
        assert.equal(ctx.kind, 'url');
    });

    it('claim with mismatched threadId returns null and keeps the entry', () => {
        save('bound', {
            threadId: 'thread-A',
            routed: { toolName: 'list_expenses', toolArgs: {}, serverKey: 'expense' },
            kind: 'url'
        });
        // Wrong thread — refused, entry preserved.
        assert.equal(claim('bound', { threadId: 'thread-B' }), null);
        assert.equal(size(), 1, 'mismatched thread must NOT consume the entry');

        // Correct thread — succeeds and consumes.
        const ctx = claim('bound', { threadId: 'thread-A' });
        assert.equal(ctx.threadId, 'thread-A');
        assert.equal(size(), 0);
    });

    it('claim without threadId option still works (backward compatible)', () => {
        save('legacy', { threadId: 'thread-X', routed: {}, kind: 'url' });
        const ctx = claim('legacy');
        assert.equal(ctx.threadId, 'thread-X');
    });
});
