/**
 * Auth header extraction for AG-UI endpoints.
 *
 * Inbound requests pass through PingAccess → Envoy + Authn Sidecar, which
 * leaves the agent's actor JWT-SVID in `Authorization: Bearer ...` and the
 * user's subject token in `X-Subject-Token`.
 */

/**
 * Extract auth tokens from an Express request.
 * Returns null when the Authorization header is missing or malformed.
 *
 * @param {import('express').Request} req
 * @returns {{actorToken: string, subjectToken: string|null}|null}
 */
export function extractAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    return {
        actorToken: authHeader.slice(7),
        subjectToken: req.headers['x-subject-token'] || null
    };
}
