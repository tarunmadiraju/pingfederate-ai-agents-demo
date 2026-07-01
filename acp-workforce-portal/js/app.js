/**
 * Main Application Module
 *
 * Coordinates the portal UI and chat interactions.
 * Authentication is handled entirely by PingAccess (BFF pattern).
 * User identity comes from GET /api/me (PA Header Identity Mapping).
 */

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);

// ─── User Avatar Menu ───────────────────────────────────────────────────────

function toggleUserMenu() {
    const menu = document.getElementById('user-menu');
    menu.classList.toggle('hidden');
}

// ─── Active Agent Selector ──────────────────────────────────────────────────
// The Workforce AI Agent handles all query types including travel planning.
// Selection persists in localStorage and is applied on page load.

const ACTIVE_AGENT_KEY = 'acme.activeAgent';

// FA icon class per agent key.
const AGENT_ICONS = {
    'workforce':    'fa-solid fa-robot',
    'trip-planner': 'fa-solid fa-plane'
};

/** Update the picker button icon and highlight the active option in the menu. */
function _syncAgentPickerUI(key) {
    const btn = document.getElementById('agent-picker-icon');
    if (btn) {
        btn.className = AGENT_ICONS[key] || 'fa-solid fa-robot';
    }
    document.querySelectorAll('.agent-picker-option').forEach(el => {
        const active = el.dataset.agent === key;
        el.classList.toggle('bg-indigo-50', active);
        el.classList.toggle('text-indigo-700', active);
        el.classList.toggle('font-medium', active);
    });
}

/** Toggle the agent picker dropdown open/closed. */
function toggleAgentPicker(e) {
    e.stopPropagation();
    const menu = document.getElementById('agent-picker-menu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}

/** Called when a menu option is clicked. */
function pickAgent(key) {
    setActiveAgent(key);
    const menu = document.getElementById('agent-picker-menu');
    if (menu) menu.classList.add('hidden');
}

/**
 * Switch the active agent. Routes future runAgent()/readResource() calls to
 * the selected backend, persists the choice, resets the chat thread, and
 * updates the header label.
 */
function setActiveAgent(key) {
    if (typeof CONFIG === 'undefined' || !CONFIG.agents || !CONFIG.agents[key]) {
        console.warn('[App] Unknown agent key:', key);
        return false;
    }
    if (typeof agentClient === 'undefined') {
        return false;
    }
    // Re-selecting the already-active agent is a no-op — no thread rotation,
    // no boundary divider. Only a genuine switch (or explicit /new) resets.
    if (agentClient.getCurrentAgent && agentClient.getCurrentAgent() === key) {
        return false;
    }
    if (!agentClient.setCurrentAgent(key)) {
        return false;
    }
    localStorage.setItem(ACTIVE_AGENT_KEY, key);

    const agentDef = CONFIG.agents[key];
    const titleEl = document.getElementById('agent-title');
    if (titleEl) titleEl.textContent = agentDef.label;

    _syncAgentPickerUI(key);

    if (typeof resetThreadForAgentSwitch === 'function') {
        resetThreadForAgentSwitch(agentDef.label);
    }

    pollAgentHealth();
    return true;
}

// ─── In-Chat CIBA Approvals Toggle ──────────────────────────────────────────

const CIBA_IN_CHAT_KEY = 'acme.cibaInChat';
let _cibaInChatEnabled = localStorage.getItem(CIBA_IN_CHAT_KEY) === 'true';

function isCibaInChatEnabled() {
    return _cibaInChatEnabled;
}

function toggleCibaInChat() {
    _cibaInChatEnabled = !_cibaInChatEnabled;
    localStorage.setItem(CIBA_IN_CHAT_KEY, _cibaInChatEnabled);
    _syncCibaToggleUI();
}

function _syncCibaToggleUI() {
    const toggle = document.getElementById('ciba-toggle');
    if (!toggle) return;
    const knob = toggle.querySelector('span');
    toggle.setAttribute('aria-checked', _cibaInChatEnabled);
    if (_cibaInChatEnabled) {
        toggle.classList.remove('bg-gray-300');
        toggle.classList.add('bg-indigo-600');
        knob.classList.remove('translate-x-0');
        knob.classList.add('translate-x-4');
    } else {
        toggle.classList.remove('bg-indigo-600');
        toggle.classList.add('bg-gray-300');
        knob.classList.remove('translate-x-4');
        knob.classList.add('translate-x-0');
    }
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
    const menu = document.getElementById('user-menu');
    const avatar = document.getElementById('user-avatar');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== avatar && !avatar.contains(e.target)) {
        menu.classList.add('hidden');
    }
});

// ─── Slash-Command Menu ─────────────────────────────────────────────────────

const SLASH_COMMANDS = [
    { command: '/mode keyword', description: 'Switch to keyword routing' },
    { command: '/mode llm',     description: 'Switch to LLM routing' },
    { command: '/mode status',  description: 'Show current routing mode' },
    { command: '/new',          description: 'Start a new session' },
    { command: '/reset',        description: 'Reset demo data' },
];

let _slashSelectedIndex = 0;
let _slashFiltered = [];

// ─── Chat Input History (Arrow Up / Down) ───────────────────────────────────
const _inputHistory = [];      // oldest → newest
let   _historyIndex  = -1;     // -1 = not browsing; 0..length-1 = position
let   _historyDraft  = '';     // stash whatever the user was typing before browsing

/**
 * Render the filtered command list into the slash menu.
 */
function renderSlashMenu(filter) {
    const menu      = document.getElementById('slash-menu');
    const container = document.getElementById('slash-menu-items');
    if (!menu || !container) return;

    // Filter commands that start with the typed text (always includes '/')
    _slashFiltered = SLASH_COMMANDS.filter(c =>
        c.command.toLowerCase().startsWith(filter.toLowerCase())
    );
    _slashSelectedIndex = 0;

    if (_slashFiltered.length === 0) {
        menu.classList.add('hidden');
        return;
    }

    container.innerHTML = _slashFiltered.map((c, i) => {
        const sel = i === _slashSelectedIndex
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:bg-slate-700';
        return `<div class="slash-item flex items-center px-4 py-2 cursor-pointer text-sm font-mono ${sel}" data-index="${i}">
            <span class="w-36 shrink-0 font-semibold">${c.command}</span>
            <span class="text-xs opacity-70">${c.description}</span>
        </div>`;
    }).join('');

    menu.classList.remove('hidden');
}

/**
 * Update the visual highlight on the currently selected row.
 */
function updateSlashSelection() {
    const items = document.querySelectorAll('#slash-menu-items .slash-item');
    items.forEach((el, i) => {
        if (i === _slashSelectedIndex) {
            el.classList.add('bg-indigo-600', 'text-white');
            el.classList.remove('text-slate-300', 'hover:bg-slate-700');
            el.scrollIntoView({ block: 'nearest' });
        } else {
            el.classList.remove('bg-indigo-600', 'text-white');
            el.classList.add('text-slate-300', 'hover:bg-slate-700');
        }
    });
}

/**
 * Accept the currently selected slash command — populate input and submit.
 */
function acceptSlashCommand() {
    const menu  = document.getElementById('slash-menu');
    const input = document.getElementById('chat-input');
    if (!_slashFiltered.length) return;

    const selected = _slashFiltered[_slashSelectedIndex];
    input.value = selected.command;
    menu.classList.add('hidden');

    // Submit the form so the command is sent immediately
    const form = document.getElementById('chat-form');
    form.dispatchEvent(new Event('submit'));
}

function hideSlashMenu() {
    const menu = document.getElementById('slash-menu');
    if (menu) menu.classList.add('hidden');
}

// Wire up input events after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('chat-input');
    if (!input) return;

    // Show / filter / hide the menu on every keystroke
    input.addEventListener('input', () => {
        const val = input.value;
        if (val.startsWith('/')) {
            renderSlashMenu(val);
        } else {
            hideSlashMenu();
        }
    });

    // Keyboard navigation inside the menu
    input.addEventListener('keydown', (e) => {
        const menu = document.getElementById('slash-menu');
        const slashMenuVisible = menu && !menu.classList.contains('hidden');

        // ── Slash-menu navigation (when visible) ──
        if (slashMenuVisible) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _slashSelectedIndex = Math.min(_slashSelectedIndex + 1, _slashFiltered.length - 1);
                updateSlashSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                _slashSelectedIndex = Math.max(_slashSelectedIndex - 1, 0);
                updateSlashSelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                acceptSlashCommand();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideSlashMenu();
            }
            return;
        }

        // ── Chat input history (ArrowUp / ArrowDown) ──
        if (_inputHistory.length === 0) return;

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (_historyIndex === -1) {
                // Entering history — stash current draft
                _historyDraft = input.value;
                _historyIndex = _inputHistory.length - 1;
            } else if (_historyIndex > 0) {
                _historyIndex--;
            }
            input.value = _inputHistory[_historyIndex];
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (_historyIndex === -1) return;
            if (_historyIndex < _inputHistory.length - 1) {
                _historyIndex++;
                input.value = _inputHistory[_historyIndex];
            } else {
                // Past the end — restore draft
                _historyIndex = -1;
                input.value = _historyDraft;
            }
        }
    });

    // Click to select a command row
    document.getElementById('slash-menu-items')?.addEventListener('click', (e) => {
        const row = e.target.closest('.slash-item');
        if (!row) return;
        _slashSelectedIndex = Number(row.dataset.index);
        acceptSlashCommand();
    });
});

// ─── End Slash-Command Menu ─────────────────────────────────────────────────

/**
 * Initialize the application
 */
async function initApp() {
    console.log('Initializing Workforce Portal...');

    // Apply the previously selected agent (if any) before any health poll
    // or chat interaction routes through agentClient. Falls through to the
    // CONFIG.defaultAgent baked into agentClient when nothing is stored.
    const storedAgent = localStorage.getItem(ACTIVE_AGENT_KEY);
    const activeKey = (storedAgent && CONFIG.agents && CONFIG.agents[storedAgent])
        ? storedAgent : CONFIG.defaultAgent;
    agentClient.setCurrentAgent(activeKey);
    const titleEl = document.getElementById('agent-title');
    if (titleEl) titleEl.textContent = CONFIG.agents[activeKey].label;
    _syncAgentPickerUI(activeKey);

    // Close the picker dropdown when clicking outside it.
    document.addEventListener('click', (e) => {
        const container = document.getElementById('agent-picker-container');
        const menu = document.getElementById('agent-picker-menu');
        if (menu && container && !container.contains(e.target)) {
            menu.classList.add('hidden');
        }
    });

    // Show initial thread ID in chat header
    if (typeof getThreadId === 'function') {
        updateSessionStatus('initialized', getThreadId());
    }

    // Click-to-copy the full thread id from the header chip.
    const sessionEl = document.getElementById('session-status-display');
    if (sessionEl) {
        sessionEl.addEventListener('click', () => {
            const id = sessionEl.dataset.threadId;
            if (!id) return;
            if (!navigator.clipboard) {
                console.warn('[App] Clipboard API unavailable — cannot copy thread id');
                return;
            }
            navigator.clipboard.writeText(id).then(() => {
                const prev = sessionEl.textContent;
                sessionEl.textContent = 'Copied!';
                setTimeout(() => { sessionEl.textContent = prev; }, 1200);
            }).catch(err => console.warn('[App] Copy failed:', err));
        });
    }

    // Health endpoint is an anonymous PA resource — safe to poll regardless
    // of session state without generating OIDC nonce cookies.
    pollAgentHealth();
    setInterval(pollAgentHealth, 15000);

    // Fetch user identity from PA headers via /api/me
    const user = await fetchCurrentUser();

    if (user) {
        console.log('Authenticated as:', user.name || user.sub);
        // Seed end-user identity baggage so it propagates (as W3C `baggage`) to
        // every backend span. user.id carries the cleartext email for demo
        // legibility (see otel.js setIdentityBaggage for the production caveat).
        if (typeof otel !== 'undefined' && otel.setIdentityBaggage) {
            otel.setIdentityBaggage({ 'user.id': user.email || user.sub });
        }
        showDashboard(user);
    } else {
        // PA should have redirected to PF login before we reach here.
        // If /api/me returns 401, PA's session may have expired.
        console.warn('Not authenticated — PA session may have expired');
        showUnauthenticated();
    }
}

/**
 * Show the authenticated dashboard
 */
function showDashboard(user) {
    const welcomeBanner = document.getElementById('welcome-banner');
    const dashboard = document.getElementById('dashboard');
    const userInfo = document.getElementById('user-info');
    const userName = document.getElementById('user-name');
    const userAvatar = document.getElementById('user-avatar');

    if (welcomeBanner) welcomeBanner.classList.add('hidden');
    if (dashboard) dashboard.classList.remove('hidden');
    if (userInfo) {
        userInfo.classList.remove('hidden');
        userInfo.classList.add('flex');
    }

    if (userName) userName.textContent = user.name || user.sub;
    if (userAvatar) {
        const displayName = user.name || user.sub || '?';
        const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase();
        userAvatar.textContent = initials;
    }

    // Populate user menu header
    const menuName = document.getElementById('menu-user-name');
    const menuEmail = document.getElementById('menu-user-email');
    if (menuName) menuName.textContent = user.name || user.sub;
    if (menuEmail) menuEmail.textContent = user.email || user.sub;

    // Sync CIBA in-chat toggle to saved preference
    _syncCibaToggleUI();

    // Initialize token panel (exchanged tokens only — user tokens are in PA)
    updateTokenPanel();

    setInterval(pollCibaRequests, 3000);
}

/**
 * Show unauthenticated state
 * Normally PA would redirect before this, but handle gracefully.
 */
function showUnauthenticated() {
    const welcomeBanner = document.getElementById('welcome-banner');
    const dashboard = document.getElementById('dashboard');

    if (welcomeBanner) welcomeBanner.classList.remove('hidden');
    if (dashboard) dashboard.classList.add('hidden');
}

/**
 * Handle chat form submission
 */
async function sendMessage(event) {
    event.preventDefault();

    const input = document.getElementById('chat-input');
    const message = input.value.trim();

    if (!message) return;

    // Push to input history and reset browsing state
    _inputHistory.push(message);
    _historyIndex = -1;
    _historyDraft = '';

    // Clear input
    input.value = '';

    // Add user message to chat
    addUserMessage(message);

    // Show typing indicator
    addTypingIndicator();

    try {
        // Send message to agent via AG-UI SSE transport.
        // Returns { _agui: true, traceId, finalState } on completion.
        // Streaming callbacks (in chat.js) update the UI incrementally.
        const result = await sendChatMessage(message);

        // Extract tokens from finalState results
        const results = (result && result.finalState && Array.isArray(result.finalState.results))
            ? result.finalState.results : [];
        for (const r of results) {
            if (r.data && r.data.toolResult && r.data.toolResult._exchangedToken) {
                addToken(r.data.toolResult._exchangedToken, TOKEN_TYPES.EXCHANGE);
                updateTokenPanel();
            }
            if (r.data && r.data.toolResult && r.data.toolResult._cibaToken) {
                addToken(r.data.toolResult._cibaToken, TOKEN_TYPES.CIBA);
                updateTokenPanel();
            }
        }

        const traceId = (result && result.traceId) ? result.traceId : null;

        // Typing indicator removed by callbacks; ensure it's gone
        removeTypingIndicator();

        if (traceId && typeof telemetry !== 'undefined') {
            telemetry.fetchTrace(traceId);
        }

    } catch (error) {
        console.error('Chat error:', error);
        removeTypingIndicator();
        addAssistantMessage(error.message, true);
    }
}

/**
 * Send a suggestion message
 */
function sendSuggestion(message) {
    const input = document.getElementById('chat-input');
    input.value = message;

    const form = document.getElementById('chat-form');
    form.dispatchEvent(new Event('submit'));
}

/**
 * Update MCP session status display in chat header.
 * @param {'not_initialized'|'initializing'|'initialized'} state
 * @param {string|null} sessionId - MCP session ID (only when state is 'initialized')
 */
function updateSessionStatus(state, sessionId) {
    const el = document.getElementById('session-status-display');
    if (!el) return;

    switch (state) {
        case 'initializing':
            el.textContent = 'Initializing session...';
            el.title = '';
            break;
        case 'initialized':
            if (sessionId) {
                // Full thread id, click-to-copy. Title carries the bare id so a
                // hover still reveals it even when ellipsized on narrow widths.
                el.textContent = 'Thread: ' + sessionId;
                el.title = 'Click to copy · ' + sessionId;
                el.dataset.threadId = sessionId;
                el.classList.add('cursor-pointer');
            } else {
                el.textContent = '';
                el.title = '';
                delete el.dataset.threadId;
            }
            break;
        default:
            el.textContent = 'Session not initialized';
            el.title = '';
            break;
    }
}

/**
 * Poll agent health and update status LED
 */
async function pollAgentHealth() {
    const isOnline = await checkAgentHealth();
    updateAgentStatusLed(isOnline);
}

/**
 * Toggle OAuth token panel visibility
 */
function toggleTokenPanel() {
    const content = document.getElementById('token-panel-content');
    const chevron = document.getElementById('token-panel-chevron');

    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        chevron.style.transform = 'rotate(90deg)';
    } else {
        content.classList.add('hidden');
        chevron.style.transform = 'rotate(0deg)';
    }
}

function toggleTelemetryPanel() {
    const content = document.getElementById('telemetry-panel-content');
    const chevron = document.getElementById('telemetry-panel-chevron');

    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        chevron.style.transform = 'rotate(90deg)';
    } else {
        content.classList.add('hidden');
        chevron.style.transform = 'rotate(0deg)';
    }
}

/**
 * Toggle the right developer sidebar between expanded and collapsed (icon rail).
 */
function toggleRightSidebar() {
    const sidebar = document.getElementById('right-sidebar');
    const rail = document.getElementById('sidebar-collapsed-rail');
    const expanded = document.getElementById('sidebar-expanded-content');
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.contains('sidebar-collapsed');
    if (isCollapsed) {
        sidebar.classList.remove('sidebar-collapsed');
        rail.classList.add('hidden');
        rail.classList.remove('flex');
        expanded.classList.remove('hidden');
    } else {
        sidebar.classList.add('sidebar-collapsed');
        expanded.classList.add('hidden');
        rail.classList.remove('hidden');
        rail.classList.add('flex');
    }
}

function toggleTryAskingPanel() {
    const content = document.getElementById('try-asking-content');
    const chevron = document.getElementById('try-asking-chevron');

    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        chevron.style.transform = 'rotate(180deg)';
    } else {
        content.classList.add('hidden');
        chevron.style.transform = 'rotate(0deg)';
    }
}

/**
 * Expand the OAuth token panel if it's collapsed
 */
function expandTokenPanel() {
    const sidebar = document.getElementById('right-sidebar');
    if (sidebar && sidebar.classList.contains('sidebar-collapsed')) {
        toggleRightSidebar();
    }
    const content = document.getElementById('token-panel-content');
    const chevron = document.getElementById('token-panel-chevron');
    if (content && content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        if (chevron) chevron.style.transform = 'rotate(90deg)';
    }
}

/**
 * Expand the telemetry panel if it's collapsed
 */
function expandTelemetryPanel() {
    const sidebar = document.getElementById('right-sidebar');
    if (sidebar && sidebar.classList.contains('sidebar-collapsed')) {
        toggleRightSidebar();
    }
    const content = document.getElementById('telemetry-panel-content');
    const chevron = document.getElementById('telemetry-panel-chevron');
    if (content && content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        if (chevron) chevron.style.transform = 'rotate(90deg)';
    }
}

/**
 * Decode a JWT token part (header or payload)
 */
function decodeJwtPart(part) {
    try {
        const decoded = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(decoded);
    } catch (e) {
        console.error('Failed to decode JWT part:', e);
        return null;
    }
}

/**
 * Track which tokens have been shown (for pulse animation)
 */
let shownTokenIds = new Set();

/**
 * Render a single token card for the stack
 * @param {string} token - JWT token
 * @param {string} type - 'transaction', 'ciba', or 'access'
 * @param {boolean} isNew - Show pulse animation
 * @param {number} index - Token index for raw view
 */
function renderTokenCard(token, type = 'transaction', isNew = false, index = 0) {
    const parts = token.split('.');
    if (parts.length !== 3) return '';

    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);
    if (!header || !payload) return '';

    const typ = header.typ || 'JWT';
    const cardClass = isNew ? 'token-card-new' : '';
    const borderColor = type === 'ciba' ? 'border-cyan-500'
        : type === 'delegated' ? 'border-green-500'
        : 'border-purple-500';

    // Type badge varies by token type
    const typeLabelBadge = type === 'ciba'
        ? '<span class="bg-cyan-600 text-white px-2 py-0.5 rounded text-xs font-medium ml-1">CIBA</span>'
        : type === 'delegated'
        ? '<span class="bg-green-600 text-white px-2 py-0.5 rounded text-xs font-medium ml-1">Access Token</span>'
            + '<span class="bg-blue-600 text-white px-2 py-0.5 rounded text-xs font-medium ml-1">Authz code + PKCE</span>'
        : '<span class="bg-orange-500 text-white px-2 py-0.5 rounded text-xs font-medium ml-1">TOKEN EXCHANGE</span>';

    const rarBadge = Array.isArray(payload.authorization_details) && payload.authorization_details.length > 0
        ? '<span class="bg-emerald-600 text-white px-2 py-0.5 rounded text-xs font-medium ml-1">RAR</span>'
        : '';

    const typeBadge = type === 'delegated'
        ? typeLabelBadge
        : `<span class="bg-purple-600 text-white px-2 py-0.5 rounded text-xs font-medium">${typ}</span>
                     ${typeLabelBadge}${rarBadge}`;

    // Scopes rendering
    let scopesHtml = '';
    if (payload.scope) {
        const scopes = payload.scope.split(' ');
        scopesHtml = scopes.map(scope =>
            `<span class="bg-purple-900 text-purple-200 px-2 py-0.5 rounded text-xs">${scope}</span>`
        ).join(' ');
    }

    // Expiry
    let expiryHtml = '';
    if (payload.exp) {
        const expiryDate = new Date(payload.exp * 1000);
        const diffMins = Math.round((expiryDate - new Date()) / 60000);
        expiryHtml = diffMins > 0
            ? `<span class="text-green-400">${expiryDate.toLocaleTimeString()} (${diffMins} min)</span>`
            : `<span class="text-red-400">Expired</span>`;
    }

    // Actor info
    let actorHtml = '';
    if (payload.act) {
        const actorSub = (typeof payload.act === 'object' && payload.act.sub)
            ? payload.act.sub
            : (typeof payload.act === 'string' ? payload.act : JSON.stringify(payload.act));
        actorHtml = `
            <div class="flex text-xs">
                <span class="text-slate-400 shrink-0 w-[70px]">Actor:</span>
                <span class="text-orange-400 font-mono break-all text-right flex-1">${actorSub}</span>
            </div>`;
    }

    // Transaction ID
    let txnHtml = '';
    if (payload.txn) {
        txnHtml = `
            <div class="flex text-xs">
                <span class="text-slate-400 shrink-0 w-[70px]">Txn ID:</span>
                <span class="text-slate-300 font-mono break-all text-right flex-1">${payload.txn}</span>
            </div>`;
    }

    return `
        <div class="bg-slate-700 rounded-lg p-3 border-l-4 ${borderColor} ${cardClass}">
            <div class="flex justify-between items-center mb-2">
                <div>${typeBadge}</div>
                <button onclick="showRawToken(${index})" class="text-slate-400 hover:text-white text-xs">
                    <i class="fa-solid fa-code mr-1"></i>View Raw
                </button>
            </div>
            <div class="space-y-1">
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Subject:</span>
                    <span class="text-slate-300 font-mono break-all text-right flex-1">${payload.sub || '-'}</span>
                </div>
                ${actorHtml}
                ${txnHtml}
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Issuer:</span>
                    <span class="text-slate-300 font-mono break-all text-right flex-1">${payload.iss || '-'}</span>
                </div>
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Audience:</span>
                    <span class="text-slate-300 font-mono break-all text-right flex-1">${Array.isArray(payload.aud) ? payload.aud.join(', ') : payload.aud || '-'}</span>
                </div>
                ${payload.client_id ? `
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Client ID:</span>
                    <span class="text-slate-300 font-mono break-all text-right flex-1">${payload.client_id}</span>
                </div>` : ''}
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Expires:</span>
                    <span class="text-right flex-1">${expiryHtml}</span>
                </div>
                ${scopesHtml ? `
                <div class="mt-2">
                    <span class="text-slate-400 text-xs">Scopes:</span>
                    <div class="flex flex-wrap gap-1 mt-1">${scopesHtml}</div>
                </div>` : ''}
            </div>
        </div>`;
}

/**
 * Render the PingAccess OIDC session card
 */
function renderSessionCard() {
    const user = getCurrentUser();
    const loginTime = getSessionEstablishedAt();
    if (!user) return '';

    const loginStr = loginTime ? loginTime.toLocaleTimeString() : '-';

    return `
        <div class="bg-slate-700 rounded-lg p-3 border-l-4 border-green-500">
            <div class="flex justify-between items-center mb-2">
                <div>
                    <span class="bg-green-600 text-white px-2 py-0.5 rounded text-xs font-medium">OIDC</span>
                    <span class="bg-blue-600 text-white px-2 py-0.5 rounded text-xs font-medium ml-1">Authz code + PKCE<span>
                </div>
            </div>
            <div class="space-y-1">
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">User:</span>
                    <span class="text-slate-300 font-mono break-all text-right flex-1">${user.sub || '-'}</span>
                </div>
                ${user.name ? `
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Name:</span>
                    <span class="text-slate-300 text-right flex-1">${user.name}</span>
                </div>` : ''}
                ${user.email ? `
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Email:</span>
                    <span class="text-slate-300 font-mono text-right flex-1">${user.email}</span>
                </div>` : ''}
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Auth Method:</span>
                    <span class="text-slate-300 text-right flex-1">AuthCode + PKCE</span>
                </div>
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Auth Server:</span>
                    <span class="text-slate-300 text-right flex-1">PingFederate</span>
                </div>
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Session:</span>
                    <span class="text-slate-300 text-right flex-1">PingAccess <span class="text-slate-500">🍪(HttpOnly, Secure)</span></span>
                </div>
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Tokens:</span>
                    <span class="text-slate-300 text-right flex-1">Server-side only</span>
                </div>
                <div class="flex text-xs">
                    <span class="text-slate-400 shrink-0 w-[70px]">Login:</span>
                    <span class="text-green-400 text-right flex-1">${loginStr}</span>
                </div>
            </div>
        </div>`;
}

/**
 * Update the token panel — shows PA session card + all tokens (transaction + CIBA)
 */
function updateTokenPanel() {
    const tokens = getAllTokens();
    const user = getCurrentUser();

    // Count: 1 for session (if logged in) + number of txn tokens
    const count = (user ? 1 : 0) + tokens.length;

    // Update token count badge (expanded + collapsed rail)
    const countBadge = document.getElementById('token-count-badge');
    if (countBadge) countBadge.textContent = count;
    const railBadge = document.getElementById('token-count-badge-rail');
    if (railBadge) railBadge.textContent = count;

    const stackContainer = document.getElementById('token-stack');
    if (!stackContainer) return;

    let stackHtml = '';

    // Tokens on top (newest first)
    tokens.forEach((entry, index) => {
        // Use token hash as ID for animation tracking
        const tokenId = entry.token.substring(0, 50);
        const isNew = !shownTokenIds.has(tokenId);
        stackHtml += renderTokenCard(entry.token, entry.type || 'transaction', isNew, index);
        shownTokenIds.add(tokenId);
    });

    // PA session card below
    stackHtml += renderSessionCard();

    stackContainer.innerHTML = stackHtml || `
        <div class="text-center py-4 text-sm text-slate-500">
            <p>No tokens yet</p>
        </div>`;
}

/**
 * Show raw token modal
 * @param {number} index - Token index in the stack
 */
let _selectedTokenIndex = 0;

function showRawToken(index = 0) {
    const tokens = getAllTokens();
    if (index >= tokens.length) return;
    
    const token = tokens[index].token;
    _selectedTokenIndex = index;

    const parts = token.split('.');
    if (parts.length !== 3) return;

    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);

    const titleEl = document.querySelector('#token-modal h3');
    if (titleEl) {
        const source = tokens[index].type === 'ciba' ? 'CIBA Token'
            : tokens[index].type === 'delegated' ? 'Access Token'
            : 'Exchanged Token';
        titleEl.innerHTML = `<i class="fa-solid fa-key mr-2"></i>${source} (JWT)`;
    }

    // Restore section labels for JWT context
    const s1 = document.getElementById('modal-section-1-label');
    const s2 = document.getElementById('modal-section-2-label');
    const s3 = document.getElementById('modal-section-3-label');
    if (s1) s1.textContent = 'Header';
    if (s2) s2.textContent = 'Payload';
    if (s3) s3.textContent = 'Raw Token';

    document.getElementById('modal-token-header').textContent = JSON.stringify(header, null, 2);
    document.getElementById('modal-token-payload').textContent = JSON.stringify(payload, null, 2);
    document.getElementById('modal-token-raw').value = token;

    const modal = document.getElementById('token-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

/**
 * Close raw token modal
 */
function closeTokenModal() {
    const modal = document.getElementById('token-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

/**
 * Copy token to clipboard
 */
async function copyToken() {
    const tokens = getAllTokens();
    if (_selectedTokenIndex >= tokens.length) return;
    
    const token = tokens[_selectedTokenIndex].token;

    try {
        await navigator.clipboard.writeText(token);

        const btn = event.target.closest('button');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i>Copied!';
        btn.classList.add('text-green-600');

        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.classList.remove('text-green-600');
        }, 2000);
    } catch (e) {
        console.error('Failed to copy token:', e);
    }
}
