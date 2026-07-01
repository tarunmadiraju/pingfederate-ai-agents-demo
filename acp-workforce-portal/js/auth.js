/**
 * Authentication Module (PingAccess Pattern)
 *
 * PingAccess handles the entire OIDC lifecycle:
 *   - Authorization code + PKCE exchange with PingFederate
 *   - Token storage (server-side, never exposed to browser)
 *   - Session cookie (HttpOnly, Secure, Encrypted)
 *   - Token injection into proxied API requests
 *
 * This module's only job is fetching user identity from /workforce-portal/me,
 * which returns PA-injected identity headers as JSON.
 */

let _currentUser = null;
let _sessionEstablishedAt = null;

/**
 * Fetch current user from PA identity headers via /api/me
 * Returns { sub, name, email } or null if not authenticated.
 */
async function fetchCurrentUser() {
    try {
        const response = await fetch(CONFIG.identity.meEndpoint, {
            credentials: 'same-origin'  // Send PA session cookie
        });

        if (!response.ok) {
            _currentUser = null;
            _sessionEstablishedAt = null;
            return null;
        }

        _currentUser = await response.json();
        _sessionEstablishedAt = new Date();
        return _currentUser;
    } catch (e) {
        console.error('Failed to fetch user identity:', e);
        _currentUser = null;
        _sessionEstablishedAt = null;
        return null;
    }
}

/**
 * Get the timestamp when the PingAccess session was established
 */
function getSessionEstablishedAt() {
    return _sessionEstablishedAt;
}

/**
 * Check if user is authenticated
 */
function isAuthenticated() {
    return _currentUser !== null;
}

/**
 * Get current user info
 */
function getCurrentUser() {
    return _currentUser;
}

/**
 * Logout — redirect to the appropriate PA logout virtual resource.
 * PA clears the session cookie and redirects to the app-specific landing page.
 * SLO is disabled — no PingFederate round-trip.
 */
function logout() {
    if (window.location.pathname.startsWith('/authenticator-app')) {
        window.location.href = '/authenticator-app/logout';
    } else {
        window.location.href = '/workforce-portal/logout';
    }
}

/**
 * Token Stack - Generic storage for different OAuth token types.
 * 
 * Token types:
 * - 'transaction': Delegation tokens from RFC 8693 token exchange (sidecar)
 * - 'ciba': Access tokens from CIBA step-up authentication
 * - 'access': Standard OAuth access tokens
 * 
 * Each entry: { token, type, expiresAt, addedAt }
 */
let _tokenStack = [];

/**
 * Token type constants
 */
const TOKEN_TYPES = {
    EXCHANGE: 'exchange',
    CIBA: 'ciba',
    ACCESS: 'access',
    DELEGATED: 'delegated'
};

/**
 * Add a token to the stack.
 * @param {string} token - The JWT token
 * @param {string} type - Token type: 'transaction', 'ciba', 'access'
 * @param {number} expiresIn - Token lifetime in seconds
 */
function addToken(token, type, expiresIn) {
    // Check if this exact token already exists (avoid duplicates)
    const existing = _tokenStack.find(t => t.token === token);
    if (existing) {
        console.log(`Token already exists (type: ${existing.type}), skipping duplicate`);
        return;
    }

    // Derive expiry: explicit expiresIn > JWT exp claim > 120s default
    let expiresAt;
    if (expiresIn) {
        expiresAt = Date.now() + (expiresIn * 1000);
    } else {
        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            expiresAt = payload.exp ? payload.exp * 1000 : Date.now() + 120000;
        } catch {
            expiresAt = Date.now() + 120000;
        }
    }

    _tokenStack.unshift({
        token,
        type,
        expiresAt,
        addedAt: Date.now()
    });
    console.log(`Token added (type: ${type}), total in stack: ${_tokenStack.length}`);
}

/**
 * Get all valid (non-expired) tokens from the stack
 * @param {string} [type] - Optional filter by token type
 */
function getTokens(type = null) {
    const now = Date.now();
    // Filter out expired tokens
    _tokenStack = _tokenStack.filter(t => t.expiresAt > now);
    
    if (type) {
        return _tokenStack.filter(t => t.type === type);
    }
    return _tokenStack;
}

/**
 * Get all exchanged tokens (convenience method)
 */
function getExchangedTokens() {
    return getTokens(TOKEN_TYPES.EXCHANGE);
}

/**
 * Get all CIBA tokens (convenience method)
 */
function getCibaTokens() {
    return getTokens(TOKEN_TYPES.CIBA);
}

/**
 * Get all tokens for display (all types)
 */
function getAllTokens() {
    return getTokens();
}



/**
 * Get the most recent exchanged token (for backward compatibility)
 */
function getExchangedToken() {
    const tokens = getExchangedTokens();
    return tokens.length > 0 ? tokens[0].token : null;
}

function clearTokenStack() {
    _tokenStack = [];
}
