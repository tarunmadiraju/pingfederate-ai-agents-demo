/**
 * Telemetry Panel — per-trace projected-span display
 *
 * After each chat-tool invocation the portal calls /workforce-portal/trace/<id>
 * to fetch the projected spans JSON.  Each rendered card represents one OTel
 * trace; the projection inside it is a curated set of spans drawn from across
 * the request flow.  This module owns the right-rail Telemetry panel, the
 * status chip under the assistant message, and the span detail modal.
 */

const telemetry = (() => {

    const FETCH_MAX_ATTEMPTS = 5;
    const FETCH_RETRY_DELAY_MS = 3000;

    // ── Active-polls counter ───────────────────────────────────────────────────
    // Tracks concurrent in-flight fetchTrace calls. Drives the header badge.

    let _activePolls = 0;

    function _incrementPolls() {
        _activePolls++;
        _renderPollsBadge();
    }

    function _decrementPolls() {
        _activePolls = Math.max(0, _activePolls - 1);
        _renderPollsBadge();
    }

    function _renderPollsBadge() {
        const badge = document.getElementById('telemetry-polling-badge');
        if (!badge) return;
        if (_activePolls > 0) {
            const label = badge.querySelector('span:last-child');
            if (label) label.textContent = `${_activePolls} tracing…`;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    // ── Placeholder cards ──────────────────────────────────────────────────────

    function _insertPlaceholderCard(traceId) {
        const stack = document.getElementById('telemetry-stack');
        if (!stack) return;

        // Remove empty-state message on first card
        const empty = stack.querySelector('.telemetry-empty');
        if (empty) empty.remove();

        const card = document.createElement('div');
        card.className = 'bg-slate-700 rounded-lg p-3 mb-2';
        card.dataset.traceId = traceId;
        card.innerHTML = _buildPlaceholderInnerHtml(traceId, 1);
        stack.insertBefore(card, stack.firstChild);

        // Increment badges
        const badge = document.getElementById('telemetry-trace-count-badge');
        if (badge) badge.textContent = parseInt(badge.textContent || '0', 10) + 1;
        const railBadge = document.getElementById('telemetry-trace-count-badge-rail');
        if (railBadge) railBadge.textContent = parseInt(railBadge.textContent || '0', 10) + 1;

        // Auto-expand the telemetry panel only when the sidebar is already open.
        // If the sidebar is collapsed the user intentionally hid it — don't reopen.
        const sidebar = document.getElementById('right-sidebar');
        const sidebarCollapsed = sidebar && sidebar.classList.contains('sidebar-collapsed');
        if (!sidebarCollapsed) {
            const content = document.getElementById('telemetry-panel-content');
            if (content && content.classList.contains('hidden')) {
                toggleTelemetryPanel();
            }
        }
    }

    function _buildPlaceholderInnerHtml(traceId, attempt) {
        const shortId = traceId ? traceId.slice(0, 8) + '…' : '…';
        const remaining = FETCH_MAX_ATTEMPTS - attempt;
        return `
            <div class="flex items-center justify-between text-xs">
                <span class="text-slate-400">
                    <span class="inline-block w-2 h-2 rounded-full bg-indigo-400 animate-pulse mr-1.5"></span>
                    ${_escapeHtml(shortId)}
                </span>
                <span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-600 text-amber-400 text-xs">
                    <i class="fa-solid fa-rotate fa-spin" style="font-size:9px"></i>
                    <span>${remaining} left</span>
                </span>
            </div>`;
    }

    function _updatePlaceholderAttempt(traceId, attempt) {
        const card = document.querySelector(`#telemetry-stack [data-trace-id="${traceId}"]`);
        if (!card) return;
        // Only update if still a placeholder (no .telemetry-settled marker)
        if (card.dataset.settled) return;
        card.innerHTML = _buildPlaceholderInnerHtml(traceId, attempt);
    }

    /**
     * Fetch the projected trace from the portal server and update the UI.
     *
     * Retries up to FETCH_MAX_ATTEMPTS times to absorb two distinct lag sources:
     *   1. Jaeger ingestion lag (2–5 s after export)
     *   2. OTel BatchSpanProcessor flush delay (up to 2 s)
     *
     * Strategy: keep retrying even after finding spans, until the count
     * stabilizes across two consecutive identical results. This ensures
     * spans from downstream services (which arrive after the agent's spans)
     * are not missed because the retry stopped too early.
     *
     * @param {string} traceId  32-char lowercase hex traceId
     */
    async function fetchTrace(traceId) {
        if (!traceId) return;

        _incrementPolls();
        _insertPlaceholderCard(traceId);

        let bestSpanCount = -1;

        for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
            _updatePlaceholderAttempt(traceId, attempt);

            try {
                const res = await fetch(`/workforce-portal/trace/${traceId}`, {
                    credentials: 'same-origin',
                });

                if (!res.ok) {
                    if (attempt === FETCH_MAX_ATTEMPTS && bestSpanCount < 0) {
                        _updateChipError(traceId);
                    }
                    await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
                    continue;
                }

                const projection = await res.json();
                const spanCount = (projection.spans || []).length;

                if (spanCount > bestSpanCount) {
                    if (spanCount > 0) {
                        _upsertTraceCard(projection);
                    }
                    bestSpanCount = spanCount;
                }

                if (bestSpanCount > 0) {
                    _updateCardPollingBadge(traceId, FETCH_MAX_ATTEMPTS - attempt);
                }

            } catch (err) {
                console.warn(`[Telemetry] fetchTrace attempt ${attempt} failed:`, err.message);
                if (attempt === FETCH_MAX_ATTEMPTS && bestSpanCount < 0) {
                    _updateChipError(traceId);
                }
            }

            await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
        }

        _updateCardPollingBadge(traceId, 0);
        _decrementPolls();
    }

    /**
     * Build the inner HTML for a settled trace card.
     */
    function _buildCardInnerHtml(projection) {
        const spanCount = (projection.spans || []).length;
        const durationSec = projection.traceDurationMs
            ? (projection.traceDurationMs / 1000).toFixed(1)
            : '?';
        const outcomeColor = projection.outcome === 'error' ? 'text-red-400' : 'text-emerald-400';
        const spansHtml = spanCount === 0
            ? '<p class="text-slate-500 text-xs px-3 pb-3">No spans captured for this trace.</p>'
            : (projection.spans || []).map((span, i, arr) => _renderSpanRow(span, i === arr.length - 1)).join('');

        return `
            <div class="flex items-center justify-between mb-2">
                <span class="text-slate-300 text-xs font-semibold">
                    <i class="fa-solid fa-shield-halved mr-1 ${outcomeColor}"></i>
                    ${spanCount} span${spanCount !== 1 ? 's' : ''} &middot; ${durationSec}s
                </span>
                <span class="inline-flex items-center gap-2">
                    <span data-polling-badge class="hidden inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-600 text-amber-400 text-xs">
                        <i class="fa-solid fa-rotate fa-spin" style="font-size:9px"></i>
                        <span>0 left</span>
                    </span>
                    <a href="${projection.deepLink}" target="_blank" rel="noopener noreferrer"
                       class="text-slate-500 hover:text-slate-300 text-xs" title="Open in Jaeger">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </a>
                    <a href="/workforce-portal/graph?trace=${projection.traceId}" target="_blank" rel="noopener noreferrer"
                       title="View service graph" class="text-slate-500 hover:text-slate-300 text-xs ml-2">
                        <i class="fa-solid fa-circle-nodes"></i>
                    </a>
                </span>
            </div>
            <div class="space-y-0">${spansHtml}</div>
        `;
    }

    /**
     * Create or update a trace card in the Telemetry stack.
     * Placeholder cards (inserted at fetchTrace start) are upgraded in-place.
     * New cards (via renderTraceCard) are prepended.
     */
    function _upsertTraceCard(projection) {
        const stack = document.getElementById('telemetry-stack');
        if (!stack) return;

        const innerHtml = _buildCardInnerHtml(projection);

        const existing = document.querySelector(`#telemetry-stack [data-trace-id="${projection.traceId}"]`);
        if (existing) {
            existing.innerHTML = innerHtml;
            existing.dataset.settled = '1';
            return;
        }

        // No placeholder — insert fresh (e.g. via renderTraceCard public API)
        const card = document.createElement('div');
        card.className = 'bg-slate-700 rounded-lg p-3 mb-2';
        card.dataset.traceId = projection.traceId;
        card.dataset.settled = '1';
        card.innerHTML = innerHtml;
        stack.insertBefore(card, stack.firstChild);
        // Badge/sidebar handled by _insertPlaceholderCard for the normal flow.
        // This path (no placeholder) is rare; increment badge here too.
        const badge = document.getElementById('telemetry-trace-count-badge');
        if (badge) badge.textContent = parseInt(badge.textContent || '0', 10) + 1;
        const railBadge = document.getElementById('telemetry-trace-count-badge-rail');
        if (railBadge) railBadge.textContent = parseInt(railBadge.textContent || '0', 10) + 1;
    }

    function _updateCardPollingBadge(traceId, remaining) {
        const card = document.querySelector(`#telemetry-stack [data-trace-id="${traceId}"]`);
        if (!card) return;
        const badge = card.querySelector('[data-polling-badge]');
        if (!badge) return;
        if (remaining > 0) {
            badge.querySelector('span').textContent = `${remaining} left`;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    /**
     * Public alias for _upsertTraceCard — kept so external callers can render
     * a trace card without going through the fetch path.
     */
    function renderTraceCard(projection) {
        _upsertTraceCard(projection);
    }

    /**
     * Render one projected-span row with timeline connector.
     * isLast controls whether the vertical line extends below the dot.
     */
    function _renderSpanRow(span, isLast) {
        const iconMap = {
            brain: 'fa-brain',
            'id-card': 'fa-id-card',
            key: 'fa-key',
            shield: 'fa-shield-halved',
            bolt: 'fa-bolt',
            database: 'fa-database',
            bell: 'fa-bell',
            person: 'fa-user',
            action: 'fa-bolt',
            route: 'fa-route',
            compass: 'fa-compass',
        };
        const iconClass = iconMap[span.icon] || 'fa-circle-dot';
        const statusColor = span.status === 'error' ? 'text-red-400' : 'text-emerald-400';
        const spanJson = escapeAttrJson(span);
        const durationMs = typeof span.durationMs === 'number' ? `${span.durationMs}ms` : '';
        const sourceLine = span.source
            ? `<span class="block text-blue-400 text-xs mt-0.5 break-all">◆ ${_escapeHtml(span.source)}</span>`
            : '';
        const summaryLines = Array.isArray(span.summary) ? span.summary : [span.summary];
        const summaryHtml = summaryLines
            .filter(Boolean)
            .map(line => `<span class="block text-slate-400 mt-0.5 break-all">${_escapeHtml(line)}</span>`)
            .join('');

        // Timeline: left column holds the vertical line + dot
        const lineClass = isLast ? 'invisible' : 'bg-slate-500';
        return `
            <div class="flex items-stretch">
                <div class="flex flex-col items-center mr-2 flex-shrink-0" style="width:12px">
                    <div class="w-2 h-2 rounded-full bg-slate-400 flex-shrink-0 mt-1.5"></div>
                    <div class="w-px flex-1 mt-0.5 ${lineClass}"></div>
                </div>
                <button class="flex-1 text-left bg-slate-600 hover:bg-slate-500 rounded px-2 py-1.5 text-xs transition-colors mb-1"
                        onclick='telemetry.showSpanDetail(${spanJson})'>
                    <span class="flex items-center justify-between">
                        <span class="inline-flex items-center space-x-1.5 min-w-0">
                            <i class="fa-solid ${iconClass} ${statusColor}"></i>
                            <span class="text-slate-200 font-medium">${_escapeHtml(span.title)}</span>
                        </span>
                        <span class="text-slate-400 text-[10px] flex-shrink-0 ml-2">${durationMs}</span>
                    </span>
                    ${summaryHtml}
                    ${sourceLine}
                </button>
            </div>`;
    }

    function updateChip(traceId, projection) {
        // Chat chips are removed — this is a no-op kept for API compatibility.
    }

    function _updateChipError(traceId) {
        // Chat chips are removed — placeholder card handles the error state visually.
        const card = document.querySelector(`#telemetry-stack [data-trace-id="${traceId}"]`);
        if (!card || card.dataset.settled) return;
        card.innerHTML = `
            <div class="flex items-center justify-between text-xs">
                <span class="text-red-400">
                    <i class="fa-solid fa-circle-xmark mr-1.5"></i>trace not available
                </span>
                <span class="text-slate-500">${_escapeHtml(traceId.slice(0, 8))}…</span>
            </div>`;
    }

    /**
     * Open the span detail modal.
     */
    function showSpanDetail(span) {
        if (typeof span === 'string') {
            try { span = JSON.parse(span); } catch { return; }
        }

        const modal = document.getElementById('span-modal');
        if (!modal) return;

        const titleEl = modal.querySelector('#span-modal-title');
        const summaryEl = document.getElementById('span-modal-summary');
        const detailsEl = document.getElementById('span-modal-details');
        const idsEl = document.getElementById('span-modal-ids');

        if (titleEl) titleEl.textContent = span.title || 'Span Detail';
        if (summaryEl) summaryEl.textContent = Array.isArray(span.summary) ? span.summary.join('\n') : (span.summary || '');
        if (detailsEl) detailsEl.textContent = JSON.stringify(span.details || {}, null, 2);
        if (idsEl) {
            if (span.traceID && span.ids?.length) {
                idsEl.innerHTML = span.ids.map(id => {
                    const href = `https://jaeger.localhost/trace/${span.traceID}?uiFind=${id}`;
                    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline">${_escapeHtml(id)}</a>`;
                }).join('\n');
            } else {
                idsEl.textContent = (span.ids || []).join('\n');
            }
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    /** Close the span detail modal. */
    function closeSpanModal() {
        const modal = document.getElementById('span-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text || '');
        return div.innerHTML;
    }

    function escapeAttrJson(obj) {
        return JSON.stringify(obj).replace(/'/g, '&#39;');
    }

    return { fetchTrace, renderTraceCard, updateChip, showSpanDetail, closeSpanModal };
})();
