/**
 * Caller — value object classifying the principal behind a request as
 * `user` / `guest` / `agent` / `none`, with an `isAdmin` flag (DS015/DS016).
 * A guest is never admin. The `fromRequest` factory is the single place caller
 * identity is derived for MCP-policy decisions.
 */
export class Caller {
    constructor({ kind, id = '', roles = [], isAdmin = false, delegatedUser = null, delegatedTool = '', sourceAgentId = '' }) {
        this.kind = kind;
        this.id = id;
        this.roles = roles;
        this.isAdmin = isAdmin;
        this.delegatedUser = delegatedUser;
        this.delegatedTool = delegatedTool;
        this.sourceAgentId = sourceAgentId;
    }

    static fromRequest(req) {
        const delegated = req?.delegatedAgentVerified;
        if (delegated && typeof delegated === 'object' && delegated.callerPrincipal) {
            return new Caller({
                kind: 'agent',
                id: String(delegated.callerPrincipal),
                delegatedUser: delegated.userDelegation?.user || null,
                delegatedTool: String(delegated.userDelegation?.delegation?.tool || ''),
                sourceAgentId: String(delegated.userDelegation?.delegation?.sourceAgentId || delegated.callerPrincipal || ''),
            });
        }
        if (req?.user && typeof req.user === 'object') {
            const roles = Array.isArray(req.user.roles)
                ? req.user.roles.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean)
                : [];
            const username = String(req.user.username || '').trim().toLowerCase();
            const id = String(req.user.id || '').trim().toLowerCase();
            const isGuest = roles.includes('guest');
            const isAdmin = !isGuest && (roles.includes('admin') || username === 'admin' || id === 'local:admin');
            return new Caller({ kind: isGuest ? 'guest' : 'user', id: String(req.user.id || ''), roles, isAdmin });
        }
        return new Caller({ kind: 'none' });
    }
}

export default Caller;
