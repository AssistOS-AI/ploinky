import {
    SubjectIdentityKeyError,
    buildSubjectIdentityKey,
    getSubjectIdentityPublicKey,
} from './subjectIdentityKey.js';

const PUBLIC_USER_API_KEY_PREFIX = 'sk-soul-';

function encodePublicUserApiKey(rawApiKey) {
    return `${PUBLIC_USER_API_KEY_PREFIX}${Buffer.from(rawApiKey, 'utf8').toString('base64url')}`;
}

// Subject-identity user API-key builder.
//
// Pure orchestration over the Task 1 signing primitive: given the authenticated
// session user, an (optional) requested target userId, and whether the caller is
// an admin, it resolves the *authoritative* userId, mints `user:<id>|<signature>`
// and returns the matching public key. This isolates the privilege decision from
// the HTTP layer so it can be unit-tested without standing up the router.
//
// Privilege model (no horizontal escalation):
//   - A non-admin may only ever mint their OWN key. Any `requestedUserId` they
//     supply is ignored; the key is derived from the session user's id.
//   - An admin may mint for another user by supplying `requestedUserId`. When an
//     admin omits it, they get their own key.
// The userId is fed through the primitive's `user:<userId>` validator, so an
// invalid id (slash, pipe, whitespace, empty) raises a typed SubjectIdentityKeyError
// (code INVALID_SUBJECT) which the route maps to a 400 instead of a crash.

// Derive a non-empty user identifier from a session-user object. The router
// populates `req.user` as `{ id, username, email, roles }` (see
// routerHandlers.js buildPlainAuthInfo); prefer the stable `id`, then fall back
// to username/email so a session without an explicit id can still self-mint.
function resolveSessionUserId(sessionUser) {
    if (!sessionUser || typeof sessionUser !== 'object') {
        return '';
    }
    const candidates = [sessionUser.id, sessionUser.username, sessionUser.email];
    for (const candidate of candidates) {
        const value = String(candidate ?? '').trim();
        if (value) {
            return value;
        }
    }
    return '';
}

// Build the `{ subjectId, apiKey, publicKey }` result for a user-key request.
// `requestedUserId` is only honored when `isAdmin` is true; otherwise the
// session user's own id is always used. Throws SubjectIdentityKeyError on any
// invalid/missing identifier so callers can map it to a 400.
function buildUserApiKeyResult({ sessionUser, requestedUserId = null, isAdmin = false } = {}) {
    const ownUserId = resolveSessionUserId(sessionUser);
    if (!ownUserId) {
        throw new SubjectIdentityKeyError(
            'INVALID_SUBJECT',
            'Cannot mint a user identity key without an authenticated user id.',
        );
    }

    let targetUserId = ownUserId;
    if (isAdmin) {
        const requested = String(requestedUserId ?? '').trim();
        if (requested) {
            targetUserId = requested;
        }
    }

    const subjectId = `user:${targetUserId}`;
    // classifySubject inside buildSubjectIdentityKey throws INVALID_SUBJECT for a
    // userId that does not match the [A-Za-z0-9._:-]+ segment alphabet.
    const rawApiKey = buildSubjectIdentityKey(subjectId);
    const apiKey = encodePublicUserApiKey(rawApiKey);
    const publicKey = getSubjectIdentityPublicKey();
    return { subjectId, apiKey, publicKey };
}

export {
    buildUserApiKeyResult,
    resolveSessionUserId,
};
