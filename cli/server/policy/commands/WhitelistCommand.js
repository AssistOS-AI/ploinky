/**
 * WhitelistCommand — abstract base for the `POST /whitelist/command` Command bus
 * (DS014). Each concrete command is one class registered by `name`; the invoker
 * calls `authorize(ctx)` then `execute(ctx)`.
 *
 * CommandContext: `{ command, body, user, isAdmin, caller }`.
 * CommandResult:  `{ ok, status, data?, error?{code,message}, audit?{...} }`.
 * A result carries `audit` only when the decision should be recorded (mutations
 * and denials); successful reads omit it. The invoker writes one audit line.
 */
export class WhitelistCommand {
    constructor(deps = {}) {
        this._deps = deps;
    }

    get name() {
        throw new Error('WhitelistCommand subclasses must define a name');
    }

    async authorize(_ctx) {
        return { ok: true };
    }

    async execute(_ctx) {
        throw new Error('WhitelistCommand subclasses must implement execute');
    }

    _ok(status, data, audit) {
        return { ok: true, status, data, audit };
    }

    _fail(status, code, message, audit) {
        return { ok: false, status, error: { code, message }, audit };
    }

    _actorId(ctx) {
        return ctx?.user?.id ? `user:${ctx.user.id}` : 'user:unknown';
    }
}

export default WhitelistCommand;
