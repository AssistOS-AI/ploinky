import { appendLog } from '../utils/logger.js';
import { sendPrivateError } from '../privateRouter.js';
import { AgentExecManager } from './agentExecManager.js';

// The private-listener handler of /api/edge/agent-exec. The route plan and the caller ACL
// (agentExecConsumersOf: the generation's manifests with routerAccess.agentExec) are already
// checked by authorizePrivateRoutePlan; this module only dispatches the action.
let manager = null;

export function agentExecManager() {
    manager ||= new AgentExecManager({ audit: (event, value) => appendLog(event, value) });
    return manager;
}

function sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
}

export async function handleAgentExecRequest({ req, res, routePlan, body, commitRoutePlan, execManager = agentExecManager() }) {
    const caller = req.privateAgentIdentity;
    const { action, execId, from } = routePlan.agentExec || {};
    try {
        if (action === 'start') {
            if (!commitRoutePlan(routePlan)) return sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
            return sendJson(res, 200, { ok: true, ...await execManager.start({ snapshot: routePlan.snapshot, caller, body }) });
        }
        if (action === 'stream') {
            return execManager.stream(execId, caller, from, res, { isAuthorized: () => routePlan.lease?.isCurrent?.() === true });
        }
        if (action === 'input') return sendJson(res, 200, execManager.input(execId, caller, body));
        if (action === 'kill') return sendJson(res, 200, execManager.kill(execId, caller));
        return sendJson(res, 404, { ok: false, error: 'AGENT_EXEC_REQUEST_INVALID' });
    } catch (error) {
        appendLog('agent_exec_rejected', { callerAgentId: caller?.agentId, action, code: error?.code || 'AGENT_EXEC_FAILED' });
        if (res.headersSent) return res.end();
        if (error?.status && error.status !== 401) {
            return sendJson(res, error.status, { ok: false, error: error.code || 'AGENT_EXEC_FAILED', message: error.message });
        }
        return sendPrivateError(res, error);
    }
}
