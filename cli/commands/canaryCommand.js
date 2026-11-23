import { LocalRouterClient } from '../utils/webttyCliClient.mjs';

async function localAdminClient() {
    const { resolvePersistedRouterPort } = await import('../sandbox/routerPort.js');
    const { mintSessionJwt } = await import('../server/auth/localService.js');
    return new LocalRouterClient({
        port: resolvePersistedRouterPort(),
        mintSessionToken: sid => mintSessionJwt({
            id: 'local:admin', username: 'admin', name: 'Local CLI', email: '', roles: ['user', 'admin'],
        }, 1, { channel: 'cli', sid }),
    });
}

const usage = 'Usage: ploinky canary start <repo/agent> --commit <sha> [--share N] [--test-accounts id,...] [--admission <json>] | set <repo/agent> --share N | resume <repo/agent> | abort <repo/agent> | status [<repo/agent>] [--json]';

function parse(args) {
    const [action, ...rest] = args;
    if (!['start', 'set', 'resume', 'abort', 'status'].includes(action)) throw new Error(usage);
    const agentRef = rest[0] && !rest[0].startsWith('--') ? rest.shift() : undefined;
    if (agentRef && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(agentRef)
        || !agentRef && action !== 'status') throw new Error(usage);
    const request = { action, agentRef };
    while (rest.length) {
        const flag = rest.shift();
        if (flag === '--json' && action === 'status' && !request.json) request.json = true;
        else if (flag === '--commit' && action === 'start' && !request.commit) {
            request.commit = rest.shift();
            if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.commit)) throw new Error(usage);
        } else if (flag === '--admission' && action === 'start' && !request.admissionEvidence) {
            // The public host CLI passes argv into the Box. These non-secret
            // operator assertions do not require forwarding the host environment.
            const value = rest.shift();
            if (!value || Buffer.byteLength(value) > 8192) throw new Error(usage);
            try { request.admissionEvidence = JSON.parse(value); }
            catch { throw new Error('Invalid canary admission JSON'); }
            if (!request.admissionEvidence || typeof request.admissionEvidence !== 'object'
                || Array.isArray(request.admissionEvidence)) throw new Error(usage);
        } else if (flag === '--share' && ['start', 'set'].includes(action) && request.share === undefined) {
            const value = rest.shift();
            if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 100) throw new Error(usage);
            request.share = Number(value);
        } else if (flag === '--test-accounts' && action === 'start' && !request.testAccounts) {
            request.testAccounts = (rest.shift() || '').split(',');
            if (request.testAccounts.some(id => !id.trim() || id.startsWith('--') || id !== id.trim())
                || new Set(request.testAccounts).size !== request.testAccounts.length) throw new Error(usage);
        } else throw new Error(usage);
    }
    if (action === 'start' && !request.commit || action === 'set' && request.share === undefined) throw new Error(usage);
    return request;
}

function receiptStatus(r) {
    return { lastStep: r.step, lastCompletedStep: r.lastCompletedStep ?? 0, intent: r.intent, failurePhase: r.failurePhase };
}

function statusRows(status, receipts) {
    const rollouts = status.rollouts.map(row => {
        const receipt = receipts.find(r => r.routeKey === row.routeKey && r.rolloutId === row.rolloutId);
        return receipt ? { ...row, receipt: receiptStatus(receipt) } : row;
    });
    for (const r of receipts) {
        if (r.terminal && !rollouts.some(row => row.routeKey === r.routeKey)) {
            rollouts.push({ routeKey: r.routeKey, rolloutId: r.rolloutId, commit: r.canaryCommit,
                state: 'terminal', outcome: r.terminal.outcome, promotable: false, receipt: receiptStatus(r) });
        }
    }
    return { ...status, rollouts };
}

function writeStatus(status, scoped, json, output) {
    if (json) {
        output.write(JSON.stringify(scoped ? status.rollouts[0] || { state: 'none' } : status) + '\n');
        return;
    }
    if (!status.rollouts.length) output.write('No active canary rollouts.\n');
    for (const row of status.rollouts) {
        if (row.state === 'terminal') {
            output.write(`${row.routeKey}  ${row.rolloutId}  ${row.outcome}\n`);
            continue;
        }
        const reason = row.lastTripReason ? `, last trip ${row.lastTripReason}` : '';
        output.write(`${row.routeKey}  ${row.rolloutId}  ${row.state}  ${row.share}%  `
            + `${row.requestsServed} served, ${row.promotable ? 'eligible' : 'ineligible'} for promotion${reason}\n`);
    }
    for (const row of status.baselines) {
        output.write(`${row.routeKey}  old copy  ${row.window.requests} requests, `
            + `${row.window.backendFailures} backend failures in the last 10 minutes\n`);
    }
}

export async function runCanaryCommand(args, { client, output = process.stdout } = {}) {
    const request = parse(args);
    const { PLOINKY_WORKSPACE_ROOT: workspaceRoot } = await import('../utils/config.js');
    const { withHeldOrAcquiredWorkspaceMutationLease: withLease } = await import('../utils/runtime/maintenanceLocks.js');
    const canary = await import('../sandbox/canary/start.mjs');
    const status = async () => {
        const router = client ?? await localAdminClient();
        const result = await router.json('GET', '/api/router/canary/status');
        if (!Array.isArray(result?.rollouts) || !Array.isArray(result?.baselines)) {
            throw new Error('Router returned an invalid canary status response');
        }
        return result;
    };
    const run = async () => {
        await canary.reconcileCanaryCommands(workspaceRoot);
        const inputs = { ...request, workspaceRoot };
        switch (request.action) {
            case 'start': {
                const id = await canary.startCanary(inputs);
                output.write(id + '\n');
                return;
            }
            case 'set':
            case 'resume':
                return canary.changeCanary({ ...inputs, status });
            case 'abort':
                return canary.abortCanary(inputs);
            case 'status': {
                let receipts = canary.canaryReceipts(workspaceRoot);
                let current = await status();
                if (request.agentRef) {
                    const { generation } = (await import('../sandbox/edgeGeneration.js')).loadActiveEdgeRoutingGeneration({ workspaceRoot });
                    const routes = Object.entries(generation.routing.routes)
                        .filter(([, r]) => r.repo + '/' + r.agent === request.agentRef);
                    receipts = receipts.filter(r => r.repoName + '/' + r.agentName === request.agentRef);
                    current = { ...current,
                        rollouts: current.rollouts.filter(row => routes.some(([key, r]) =>
                            key === row.routeKey && r.canary?.rolloutId === row.rolloutId)),
                        baselines: current.baselines.filter(row => routes.some(([key]) => key === row.routeKey)),
                    };
                    if (routes.some(([key, route]) => route.canary &&
                        !current.rollouts.some(row => key === row.routeKey && row.rolloutId === route.canary.rolloutId))) {
                        throw new Error('Router has not observed the published canary rollout');
                    }
                }
                const result = statusRows(current, receipts);
                if (request.agentRef && result.rollouts.length > 1) throw new Error('ambiguous canary status for ' + request.agentRef);
                writeStatus(result, Boolean(request.agentRef), request.json, output);
            }
        }
    };
    return withLease({ operation: 'canary-' + request.action }, run);
}
