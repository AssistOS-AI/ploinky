/**
 * ShareAuthorizer (abstract) + HttpShareAuthorizer (concrete) — deny-by-default
 * bridge for normal-user public sharing (DS014).
 *
 * The full publish UX is deferred (plan Phase 8). Until it has a captured,
 * owner-attested root dial contract, this bridge remains closed and opens no
 * mutable-routing or unguarded AgentServer connection.
 *
 * Both classes live here (rather than a separate `ShareAuthorizer.js`) because a
 * case-insensitive filesystem cannot hold both that and the legacy
 * `shareAuthorizer.js` during the refactor.
 */

export class ShareAuthorizer {
    // Returns Promise<{ allowed: boolean, reason: string }>. Deny by default.
    async authorize(_ctx) {
        return { allowed: false, reason: 'not_implemented' };
    }
}

export class HttpShareAuthorizer extends ShareAuthorizer {}

export default HttpShareAuthorizer;
