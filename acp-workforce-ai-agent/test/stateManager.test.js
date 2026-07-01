/**
 * Unit tests for AguiStateManager — RFC 6902 patch generation and internal
 * state mutation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AguiStateManager } from '../src/agui/stateManager.js';

describe('AguiStateManager', () => {
    let sm;

    beforeEach(() => {
        sm = new AguiStateManager();
    });

    it('initializes with empty results and null error', () => {
        const snap = sm.snapshot();
        assert.deepEqual(snap.results, []);
        assert.equal(snap.error, null);
    });

    it('appendResult emits an "add" patch on /results/- and updates state', () => {
        const patches = sm.appendResult('run-1', 'expense_list', { count: 3, expenses: [{}] });
        assert.equal(patches.length, 1);
        assert.equal(patches[0].op, 'add');
        assert.equal(patches[0].path, '/results/-');
        assert.equal(patches[0].value.runId, 'run-1');
        assert.equal(patches[0].value.view, 'expense_list');
        assert.equal(patches[0].value.data.count, 3);

        const snap = sm.snapshot();
        assert.equal(snap.results.length, 1);
        assert.equal(snap.results[0].view, 'expense_list');
    });

    it('appendResult appends multiple results in order', () => {
        sm.appendResult('r1', 'expense_list', {});
        sm.appendResult('r2', 'flight_results', {});
        const snap = sm.snapshot();
        assert.equal(snap.results.length, 2);
        assert.equal(snap.results[0].runId, 'r1');
        assert.equal(snap.results[1].runId, 'r2');
    });

    it('setError stores the error and emits a replace patch with extra fields', () => {
        const patches = sm.setError('authorization_error', 'No scope', { status: 403, scope: 'read:financial_reports', toolName: 'get_financial_report' });
        assert.equal(patches[0].op, 'replace');
        assert.equal(patches[0].path, '/error');
        assert.equal(patches[0].value.type, 'authorization_error');
        assert.equal(patches[0].value.status, 403);
        assert.equal(patches[0].value.scope, 'read:financial_reports');

        const snap = sm.snapshot();
        assert.equal(snap.error.type, 'authorization_error');
        assert.equal(snap.error.message, 'No scope');
    });

    it('clearError resets to null and emits a replace patch', () => {
        sm.setError('authorization_error', 'msg');
        const patches = sm.clearError();
        assert.equal(patches[0].op, 'replace');
        assert.equal(patches[0].path, '/error');
        assert.equal(patches[0].value, null);
        assert.equal(sm.snapshot().error, null);
    });

    it('snapshot returns deep copies (mutating it does not affect state)', () => {
        sm.appendResult('r1', 'expense_list', { count: 1 });
        const snap = sm.snapshot();
        snap.results.push({ runId: 'phantom' });
        snap.results[0].data.count = 999;
        const snap2 = sm.snapshot();
        assert.equal(snap2.results.length, 1);
        assert.equal(snap2.results[0].data.count, 1);
    });

    it('hydrates from initialState', () => {
        const initial = {
            results: [{ runId: 'old', view: 'expense_list', data: {} }],
            error: null
        };
        const sm2 = new AguiStateManager(initial);
        const snap = sm2.snapshot();
        assert.equal(snap.results.length, 1);
        assert.equal(snap.results[0].runId, 'old');
    });
});
