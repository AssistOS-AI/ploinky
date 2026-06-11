export class PolicyCommand {
    constructor(deps = {}) {
        this._deps = deps;
    }

    get name() {
        throw new Error('PolicyCommand subclasses must define a name');
    }

    async authorize(_ctx) {
        return { ok: true };
    }

    async execute(_ctx) {
        throw new Error('PolicyCommand subclasses must implement execute');
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

export default PolicyCommand;
