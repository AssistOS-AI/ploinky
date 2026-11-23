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

export async function runCanaryCommand(args, { client, output = process.stdout } = {}) {
    const [subcommand, format] = args;
    if (subcommand !== 'status' || args.length > 2 || (format !== undefined && format !== '--json')) {
        throw new Error('Usage: ploinky canary status [--json]');
    }
    const router = client ?? await localAdminClient();
    const status = await router.json('GET', '/api/router/canary/status');
    if (!Array.isArray(status?.rollouts) || !Array.isArray(status?.baselines)) {
        throw new Error('Router returned an invalid canary status response');
    }
    if (format === '--json') {
        output.write(JSON.stringify(status) + '\n');
        return;
    }
    if (!status.rollouts.length) output.write('No active canary rollouts.\n');
    for (const row of status.rollouts) {
        const reason = row.lastTripReason ? `, last trip ${row.lastTripReason}` : '';
        output.write(`${row.routeKey}  ${row.rolloutId}  ${row.state}  ${row.share}%  `
            + `${row.requestsServed} served, ${row.promotable ? 'eligible' : 'ineligible'} for promotion${reason}\n`);
    }
    for (const row of status.baselines) {
        output.write(`${row.routeKey}  old copy  ${row.window.requests} requests, `
            + `${row.window.backendFailures} backend failures in the last 10 minutes\n`);
    }
}
