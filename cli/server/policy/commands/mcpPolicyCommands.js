import { PolicyCommand } from './PolicyCommand.js';

/**
 * The three `mcp.policy.*` commands (DS016) — admin-only. They share the
 * MCP-tool-policy responsibility, so they live together. Each takes the
 * `repository` via DI.
 */

const ACCESS_VALUES = ['authenticated', 'internal', 'admin'];

class McpPolicyCommand extends PolicyCommand {
    constructor({ repository }) {
        super();
        this._repo = repository;
    }

    // All mcp.policy.* commands require an admin user.
    async authorize(ctx) {
        if (!ctx.isAdmin) {
            return this._fail(403, 'ADMIN_REQUIRED', 'Admin access is required.', {});
        }
        return { ok: true };
    }
}

export class McpPolicySetCommand extends McpPolicyCommand {
    get name() { return 'mcp.policy.set'; }

    async execute(ctx) {
        const agent = String(ctx.body?.agent || '').trim();
        const tool = String(ctx.body?.tool || '').trim();
        const access = String(ctx.body?.access || '').trim();
        if (!agent || !tool) {
            return this._fail(400, 'INVALID_PATH', 'agent and tool are required.', { agent, tool });
        }
        if (!ACCESS_VALUES.includes(access)) {
            return this._fail(400, 'UNKNOWN_COMMAND', 'Invalid access class.', { agent, tool, access });
        }
        const actorId = this._actorId(ctx);
        try {
            this._repo.mutate((state) => {
                const now = new Date().toISOString();
                const existing = state.mcpTools.find((entry) => entry.agent === agent && entry.tool === tool);
                if (existing) {
                    existing.access = access;
                    existing.source = 'admin';
                    existing.enabled = true;
                    existing.updatedAt = now;
                    existing.updatedBy = actorId;
                } else {
                    state.mcpTools.push({
                        agent, tool, access, source: 'admin', enabled: true,
                        createdAt: now, createdBy: actorId, updatedAt: now, updatedBy: actorId,
                    });
                }
                return state;
            });
            return this._ok(200, { agent, tool, access }, { agent, tool, access });
        } catch {
            return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Failed to persist policy.', { agent, tool });
        }
    }
}

export class McpPolicyGetCommand extends McpPolicyCommand {
    get name() { return 'mcp.policy.get'; }

    async execute(ctx) {
        const entry = this._repo.getMcpToolEntry(String(ctx.body?.agent || '').trim(), String(ctx.body?.tool || '').trim());
        if (entry && entry.corrupt) return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Policy is unavailable.', {});
        if (!entry) return this._fail(404, 'POLICY_ENTRY_NOT_FOUND', 'No policy for this agent+tool.', {});
        return this._ok(200, { entry });
    }
}

export class McpPolicyListCommand extends McpPolicyCommand {
    get name() { return 'mcp.policy.list'; }

    async execute(_ctx) {
        const { entries, corrupt } = this._repo.listMcpTools();
        if (corrupt) return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Policy is unavailable.', {});
        return this._ok(200, { mcpTools: entries });
    }
}
