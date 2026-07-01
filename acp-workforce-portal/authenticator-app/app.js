/**
 * Acme Corp Authenticator App
 *
 * Polls /ciba/pending for CIBA consent requests and renders
 * approval cards matching the Workforce Portal's design language.
 * Uses PA session cookie (credentials: 'same-origin') for auth.
 * PA handles OIDC authentication — no unauth screen needed.
 */

(function () {
    'use strict';

    // ─── Config ──────────────────────────────────────────────────────────────
    const POLL_INTERVAL_MS = 3000;
    const ENDPOINTS = {
        pending: '/authenticator-app/ciba/pending',
        resolved: '/authenticator-app/ciba/resolved',
        action: '/authenticator-app/ciba/action',
        me: '/authenticator-app/me',
    };

    // ─── State ───────────────────────────────────────────────────────────────
    let currentUser = null;
    let knownCibaRequestIds = new Set();
    let pollTimer = null;
    let audioCtx = null;

    // ─── DOM refs ────────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    // ─── Init ────────────────────────────────────────────────────────────────
    async function init() {
        // Identify the user via PA session (PA handles auth — user is always authenticated)
        try {
            const res = await fetch(ENDPOINTS.me, { credentials: 'same-origin' });
            if (res.ok) {
                currentUser = await res.json();
            }
        } catch {
            // PA session not yet ready — proceed anyway, polling will use credentials
        }
        showApp();
    }

    function showApp() {
        $('screen-loading').classList.add('hidden');
        $('screen-app').classList.remove('hidden');

        if (currentUser) {
            const initials = (currentUser.name || currentUser.sub || '?')
                .split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
            $('user-avatar').textContent = initials;
            $('user-avatar-wrapper').classList.remove('hidden');
            $('menu-user-name').textContent = currentUser.name || currentUser.sub;
            $('menu-user-email').textContent = currentUser.email || currentUser.sub;
        }

        startPolling();
    }

    // ─── Polling ─────────────────────────────────────────────────────────────
    function startPolling() {
        pollCibaRequests();
        pollTimer = setInterval(pollCibaRequests, POLL_INTERVAL_MS);
    }

    async function pollCibaRequests() {
        try {
            const [pendingRes, resolvedRes] = await Promise.all([
                fetch(ENDPOINTS.pending, { credentials: 'same-origin' }),
                fetch(ENDPOINTS.resolved, { credentials: 'same-origin' }),
            ]);

            if (pendingRes.status === 401) {
                clearInterval(pollTimer);
                window.location.href = '/authenticator-app/login';
                return;
            }
            if (!pendingRes.ok) return;

            const pending = await pendingRes.json();
            const resolved = resolvedRes.ok ? await resolvedRes.json() : [];

            const filterForUser = (list) => currentUser
                ? list.filter(r => r.user_hint === currentUser.sub || r.user_hint === currentUser.email)
                : list;

            renderCibaRequests(filterForUser(pending), filterForUser(resolved));
            updateStatusIndicator(true);
        } catch {
            updateStatusIndicator(false);
        }
    }

    // ─── Rendering ───────────────────────────────────────────────────────────

    function renderCibaRequests(pending, resolved) {
        const container = $('requests-container');
        const empty = $('empty-state');
        const badge = $('request-count');

        const pendingIds  = new Set(pending.map(r => r.id));
        const resolvedIds = new Set(resolved.map(r => r.id));
        const allIds      = new Set([...pendingIds, ...resolvedIds]);

        // Remove resolved cards that have aged off the server TTL
        container.querySelectorAll('.consent-card').forEach(el => {
            if (!allIds.has(el.dataset.requestId)) {
                el.classList.add('animate-slide-out');
                setTimeout(() => el.remove(), 300);
            }
        });

        // Update pending cards that are now resolved or expired
        container.querySelectorAll('.consent-card[data-resolved="false"]').forEach(el => {
            const req = resolved.find(r => r.id === el.dataset.requestId);
            if (req) updateCibaConsentCard(el, req);
        });

        // Add new pending cards at the top (with chime)
        for (const req of [...pending].reverse()) {
            if (knownCibaRequestIds.has(req.id)) continue;
            knownCibaRequestIds.add(req.id);
            container.prepend(buildCibaConsentCard(req));
            playChime();
        }

        // Add new resolved cards at the bottom (no chime — already acted on)
        for (const req of resolved) {
            if (knownCibaRequestIds.has(req.id)) continue;
            knownCibaRequestIds.add(req.id);
            container.appendChild(buildCibaResolvedCard(req));
        }

        // Remove stale IDs from tracking set
        for (const id of knownCibaRequestIds) {
            if (!allIds.has(id)) knownCibaRequestIds.delete(id);
        }

        const hasPending = pending.length > 0;
        empty.classList.toggle('hidden', hasPending || resolved.length > 0);
        badge.classList.toggle('hidden', !hasPending);
        if (hasPending) badge.textContent = pending.length;
    }

    function updateCibaConsentCard(cardEl, req) {
        cardEl.dataset.resolved = 'true';

        const isExpired  = req.status === 'EXPIRED';
        const isApproved = req.status === 'APPROVED';

        const bgClass    = isExpired ? 'bg-gray-50 border-gray-200'   : isApproved ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200';
        const iconClass  = isExpired ? 'fa-clock text-gray-400'       : isApproved ? 'fa-check-circle text-green-500' : 'fa-times-circle text-red-500';
        const label      = isExpired ? 'Request Expired'              : isApproved ? 'Access Granted' : 'Access Denied';
        const labelColor = isExpired ? 'text-gray-700'                : isApproved ? 'text-green-700' : 'text-red-700';
        const verb       = isApproved ? 'Approved' : 'Denied';
        const attribution = isExpired ? 'No response before timeout'
            : req.source === 'portal' ? `${verb} in chat` : `${verb} from Authenticator App`;

        const detailsHtml = buildAuthzDetailsHtml(req.authorization_details, true) || (req.binding_message ? `
            <div class="bg-white border border-gray-100 rounded-xl p-4 mb-0">
                <div class="flex items-center mb-2">
                    <i class="fa-solid fa-comment-dots text-gray-400 mr-2"></i>
                    <span class="text-sm text-gray-400">Request</span>
                </div>
                <p class="text-gray-500 font-medium">${escapeHtml(req.binding_message)}</p>
            </div>` : '');

        cardEl.innerHTML = `
            <div class="${bgClass} border rounded-2xl p-5 mx-4 mb-4">
                <div class="flex items-center space-x-3 mb-3">
                    <i class="fa-solid ${iconClass} text-xl flex-shrink-0"></i>
                    <div>
                        <span class="font-semibold ${labelColor} block">${label}</span>
                        <span class="text-xs text-gray-400">${attribution}</span>
                    </div>
                </div>
                ${detailsHtml}
            </div>
        `;
    }

    function buildCibaResolvedCard(req) {
        const card = document.createElement('div');
        card.className = 'consent-card animate-slide-in';
        card.dataset.requestId = req.id;
        card.dataset.resolved = 'true';
        updateCibaConsentCard(card, req);
        return card;
    }

    function buildCibaConsentCard(request) {
        const card = document.createElement('div');
        card.className = 'consent-card animate-slide-in';
        card.dataset.requestId = request.id;
        card.dataset.resolved = 'false';
        card.dataset.authzDetails = JSON.stringify(request.authorization_details || null);
        card.dataset.bindingMessage = request.binding_message || '';

        const authzHtml = buildAuthzDetailsHtml(request.authorization_details);
        const bindingHtml = !authzHtml ? `
            <div class="bg-white border border-amber-100 rounded-xl p-4 mb-4">
                <div class="flex items-center mb-2">
                    <i class="fa-solid fa-comment-dots text-amber-500 mr-2"></i>
                    <span class="text-sm text-gray-500">Request</span>
                </div>
                <p class="text-gray-800 font-medium">${escapeHtml(request.binding_message || 'Authorization requested')}</p>
            </div>` : '';

        card.innerHTML = `
            <div class="bg-amber-50 border border-amber-200 rounded-2xl p-5 shadow-sm mx-4 mb-4">
                <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center">
                        <div class="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center mr-3">
                            <i class="fa-solid fa-shield-halved text-amber-600"></i>
                        </div>
                        <div>
                            <span class="font-semibold text-gray-800 block text-[15px]">Agent Authorization</span>
                            <span class="text-xs text-gray-500">Just now</span>
                        </div>
                    </div>
                    <span class="bg-cyan-100 text-cyan-700 px-2.5 py-1 rounded-full text-xs font-semibold">CIBA</span>
                </div>
                <p class="text-gray-600 text-sm mb-3">
                    An AI agent is requesting permission to act on your behalf:
                </p>
                ${authzHtml || bindingHtml}
                <div class="flex space-x-3">
                    <button data-action="APPROVED" data-request-id="${request.id}"
                        class="consent-btn flex-1 bg-green-600 active:bg-green-700 text-white font-semibold py-3.5 rounded-xl transition-all flex items-center justify-center text-[15px]">
                        <i class="fa-solid fa-check mr-2"></i>Allow
                    </button>
                    <button data-action="DENIED" data-request-id="${request.id}"
                        class="consent-btn flex-1 bg-red-500 active:bg-red-600 text-white font-semibold py-3.5 rounded-xl transition-all flex items-center justify-center text-[15px]">
                        <i class="fa-solid fa-xmark mr-2"></i>Deny
                    </button>
                </div>
            </div>
        `;

        // Event delegation for buttons
        card.querySelectorAll('.consent-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                handleCibaConsent(btn.dataset.requestId, btn.dataset.action);
            });
        });

        return card;
    }

    function buildAuthzDetailsHtml(authorizationDetails, muted = false) {
        if (!authorizationDetails || !Array.isArray(authorizationDetails) || authorizationDetails.length === 0) {
            return '';
        }

        return authorizationDetails.map(detail => {
            const toolName = detail.identifier || detail.type || 'Unknown tool';
            const locations = detail.locations || [];
            const args = detail.arguments || {};
            const argEntries = Object.entries(args);

            const boxBorder  = muted ? 'border-gray-100' : 'border-amber-100';
            const iconColor  = muted ? 'text-gray-400'   : 'text-indigo-500';
            const nameColor  = muted ? 'text-gray-500'   : 'text-gray-800';

            let html = `
                <div class="bg-white border ${boxBorder} rounded-xl p-4 mb-4">
                    <div class="flex items-center mb-2">
                        <i class="fa-solid fa-wrench ${iconColor} mr-2"></i>
                        <span class="font-mono text-sm font-semibold ${nameColor}">${escapeHtml(toolName)}</span>
                    </div>`;

            if (locations.length > 0) {
                const target = locations.map(l => {
                    try { return new URL(l).hostname; } catch { return l; }
                }).join(', ');
                html += `
                    <div class="flex items-center text-xs text-gray-500 mb-2 ml-7">
                        <i class="fa-solid fa-server mr-1.5"></i>
                        <span>${escapeHtml(target)}</span>
                    </div>`;
            }

            if (argEntries.length > 0) {
                html += `<div class="ml-7 mt-2 bg-gray-50 rounded-lg border border-gray-100 divide-y divide-gray-100 overflow-hidden">`;
                for (const [key, value] of argEntries) {
                    const displayValue = typeof value === 'number' ? value.toLocaleString() : String(value);
                    html += `
                        <div class="flex justify-between gap-4 px-3 py-2 text-sm">
                            <span class="text-gray-500 shrink-0">${escapeHtml(key)}</span>
                            <span class="text-gray-800 font-medium text-right">${escapeHtml(displayValue)}</span>
                        </div>`;
                }
                html += `</div>`;
            }

            html += `</div>`;
            return html;
        }).join('');
    }

    // ─── Actions ─────────────────────────────────────────────────────────────

    async function handleCibaConsent(authReqId, action) {
        const card = document.querySelector(`[data-request-id="${authReqId}"]`);
        if (!card) return;

        // Disable buttons immediately
        card.querySelectorAll('.consent-btn').forEach(btn => {
            btn.disabled = true;
            btn.classList.add('opacity-50');
        });

        try {
            const res = await fetch(ENDPOINTS.action, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auth_req_id: authReqId, action, source: 'authenticator' }),
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const isApproved = action === 'APPROVED';
            const authzDetails = (() => { try { return JSON.parse(card.dataset.authzDetails); } catch { return null; } })();
            updateCibaConsentCard(card, {
                status: action,
                source: 'authenticator',
                authorization_details: authzDetails,
                binding_message: card.dataset.bindingMessage || '',
            });

            showToast(isApproved ? 'Access Granted' : 'Access Denied', isApproved ? 'green' : 'red');
        } catch (err) {
            console.error('[Authenticator] Action failed:', err);
            // Re-enable buttons on failure
            card.querySelectorAll('.consent-btn').forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('opacity-50');
            });
            showToast('Action failed — try again', 'red');
        }
    }

    // ─── Toast ───────────────────────────────────────────────────────────────

    function showToast(message, color) {
        const toast = document.createElement('div');
        const bgMap = { green: 'bg-green-600', red: 'bg-red-500' };
        toast.className = `fixed bottom-24 inset-x-0 mx-auto w-max ${bgMap[color] || 'bg-gray-800'} text-white px-5 py-3 rounded-full text-sm font-medium shadow-lg z-50 animate-slide-in`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('animate-slide-out');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    // ─── Audio chime ─────────────────────────────────────────────────────────

    function playChime() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.frequency.value = 880;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
            osc.start(audioCtx.currentTime);
            osc.stop(audioCtx.currentTime + 0.3);
        } catch {
            // AudioContext not available or not unlocked — ignore
        }
    }

    // ─── Status indicator ────────────────────────────────────────────────────

    function updateStatusIndicator(connected) {
        const dot = $('status-dot');
        const label = $('status-label');
        if (!dot || !label) return;
        if (connected) {
            dot.className = 'w-2 h-2 rounded-full bg-green-500';
            label.textContent = 'Connected';
        } else {
            dot.className = 'w-2 h-2 rounded-full bg-red-500';
            label.textContent = 'Disconnected';
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── User menu ───────────────────────────────────────────────────────────

    window.toggleUserMenu = function () {
        const menu = $('user-menu');
        menu.classList.toggle('hidden');
    };

    document.addEventListener('click', (e) => {
        const menu = $('user-menu');
        const avatar = $('user-avatar');
        if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== avatar && !avatar.contains(e.target)) {
            menu.classList.add('hidden');
        }
    });

    // ─── Unlock audio on first touch (iOS requirement) ───────────────────────
    document.addEventListener('touchstart', function unlock() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        document.removeEventListener('touchstart', unlock);
    }, { once: true });

    // ─── Boot ────────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
