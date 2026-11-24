import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { runCacheCommand } from '../../cli/commands/cacheCommands.js';
import { CACHE_OPERATOR_HEADER, CACHE_OPERATOR_PATH, signCacheOperatorRequest } from '../../cli/commands/cacheOperatorAssertion.js';
import { handlePrivateCacheRequest } from '../../cli/server/privateRouter.js';
import { configureCachePurge } from '../../cli/server/cdn/cachePurgeConfig.js';
import { changeCacheHold } from '../../cli/server/cdn/cacheHold.js';
import { purgeCacheHost } from '../../cli/server/cdn/cachePurge.js';
import { readCacheSettings } from '../../cli/server/cdn/cacheSettingsStore.js';
import { createCloudflarePublicationApi } from '../../ploinky-box/cloudflared/cloudflareApi.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';

const previous = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
test.after(() => {
    if (previous === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previous;
});

const host = 'published.example.test';
const agent = 'repo/application';
const generation = { generation: `sha256:${'1'.repeat(64)}` };
const accepted = { host, outcome: 'accepted' };

function routePlan() {
    return {
        ok: true, listener: 'private', kind: 'private-operation', operation: 'cache', pathname: CACHE_OPERATOR_PATH,
        lease: { id: generation.generation, activationId: randomUUID(), snapshot: generation, commit: () => true },
        snapshot: generation,
    };
}

async function serve(plan, body, headers, operations = {}, overrides = {}) {
    const req = Object.assign(Readable.from([body]), {
        method: 'POST', url: CACHE_OPERATOR_PATH, socket: { remoteAddress: '127.0.0.1' },
        ploinkyListenerClass: 'private', headers: { ...headers }, ...overrides,
    });
    const res = {
        writeHead(status, values) { this.status = status; this.headers = values; },
        end(payload) { this.payload = payload; },
    };
    await handlePrivateCacheRequest({ req, res, plan, publicPort: 8080, ...operations });
    return res;
}

function transport(plan, operations) {
    return (options, respond) => {
        assert.equal(options.host, '127.0.0.1');
        assert.equal(options.port, 8081);
        assert.equal(options.path, CACHE_OPERATOR_PATH);
        assert.equal(options.method, 'POST');
        return Object.assign(new EventEmitter(), {
            async end(body) {
                const res = await serve(plan, body, options.headers, operations);
                respond(Object.assign(Readable.from([res.payload]), { statusCode: res.status }));
            },
        });
    };
}

test('one-shot cache clear exits 1 on a failed purge and 0 on an accepted purge', t => {
    const workspace = fs.mkdtempSync(path.join(process.cwd(), '.cache-cli-process-'));
    t.after(() => fs.rmSync(workspace, { recursive: true }));
    const root = path.resolve(import.meta.dirname, '../..');
    // Keep the real index, core dispatch and cache command. Replace workspace
    // initialization, lease discovery and the private socket at their import boundaries.
    const stubs = {
        '/cli/index.js': { '../agentlib/bootstrap.mjs': 'export const bootstrapAgentLibRuntime = async () => ({ owned: false });' },
        '/cli/main.js': {
            './commands/ploinkyboot.js': 'export const bootstrap = () => {};',
            './utils/config.js': 'export const HISTORY_FILE = "", initEnvironment = () => {}, logPloinkyDirectory = () => {}, setDebugMode = () => {};',
        },
        '/cli/commands/cacheCommands.js': {
            '../sandbox/edgeGeneration.js': `export const captureEdgeRoutingLease = () => (${JSON.stringify(routePlan().lease)});`,
            'node:http': `
                import { EventEmitter } from 'node:events';
                import { Readable } from 'node:stream';
                export default { request(options, respond) {
                    return Object.assign(new EventEmitter(), { end(body) {
                        const {host} = JSON.parse(body);
                        const purge = {host, outcome: process.env.TEST_CACHE_OUTCOME};
                        respond(Object.assign(Readable.from([Buffer.from(JSON.stringify({purge}))]), {statusCode: 200}));
                    } });
                } };
            `,
        },
    };
    const loader = `
        const stubs = ${JSON.stringify(stubs)};
        export function resolve(specifier, context, next) {
            const parent = Object.keys(stubs).find(key => context.parentURL?.endsWith(key));
            const stub = stubs[parent]?.[specifier];
            return stub ? {url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true} : next(specifier, context);
        }
    `;
    for (const [outcome, status, message] of [['failed', 1, 'Cache clear failed: failed.'], ['accepted', 0, 'Cache clear completed.']]) {
        const result = spawnSync(process.execPath, [
            '--experimental-loader', 'data:text/javascript,' + encodeURIComponent(loader),
            path.join(root, 'cli/index.js'), 'cache', 'clear', '--host', host,
        ], {
            cwd: workspace, encoding: 'utf8', timeout: 10_000,
            env: { ...process.env, PLOINKY_ROOT: root, PLOINKY_WORKSPACE_ROOT: workspace, TEST_CACHE_OUTCOME: outcome },
        });
        assert.ifError(result.error);
        assert.equal(result.status, status);
        assert.ok((status ? result.stderr : result.stdout).includes(message));
    }
});

test('outer forwarding and CLI use handles for configuration and private operator admission for clear, hold and release', async () => {
    const config = ['cache', 'purge-config', '--host', host, '--zone', 'a'.repeat(32), '--secret', 'publication/purge'];
    assert.deepEqual(routeOuterCommand(parseOuterArguments(config)).coreArgv, config);
    let configured;
    assert.equal(await runCacheCommand(config.slice(1), {
        configure: input => { configured = input; }, report() {},
    }), 0);
    assert.deepEqual(configured, { host, zoneId: 'a'.repeat(32), secretHandle: 'publication/purge' });
    await assert.rejects(runCacheCommand([...config.slice(1), '--unexpected'], { configure: assert.fail }), /Usage/);
    const seen = [];
    const plan = routePlan();
    const operations = {
        purge(input) {
            seen.push('clear');
            assert.equal(input.generation, generation);
            assert.equal(input.by, 'local:admin');
            assert.equal(input.host, host);
            assert.equal(input.assertCurrent(), true);
            return accepted;
        },
        changeHold(input) {
            seen.push(input.op);
            assert.equal(input.by, 'local:admin');
            assert.equal(input.agent, agent);
            assert.equal(input.publicPort, 8080);
            assert.equal(input.assertCurrent(), true);
            return { success: true, purges: [accepted] };
        },
    };
    for (const args of [['clear', '--host', host], ['hold', '--agent', agent], ['release', '--agent', agent]]) {
        const outer = ['cache', ...args];
        assert.deepEqual(routeOuterCommand(parseOuterArguments(outer)).coreArgv, outer);
        assert.equal(await runCacheCommand(args, { captureLease: () => plan.lease, request: transport(plan, operations), report() {} }), 0);
    }
    assert.deepEqual(seen, ['clear', 'hold', 'release']);
});

test('CLI reports an empty release and an immutable-only hold', async () => {
    const plan = routePlan();
    for (const [op, result, expected] of [
        ['release', { success: true, purges: [] }, /nothing to purge/i],
        ['hold', { success: true, purges: [accepted], probeSkipped: 'no_page_marks' }, /probe skipped.*no page marks/i],
    ]) {
        const messages = [];
        assert.equal(await runCacheCommand([op, '--agent', agent], {
            captureLease: () => plan.lease, request: transport(plan, { changeHold: () => result }),
            report: message => messages.push(message),
        }), 0);
        assert.match(messages.join(' '), expected);
    }
});

test('cache command fails on cooldown, failed purge, unconfirmed probe, empty hold purge set and stale lease', async () => {
    const plan = routePlan();
    const run = (args, operations) => runCacheCommand(args, { captureLease: () => plan.lease, request: transport(plan, operations), report: assert.fail });
    for (const outcome of ['cooldown', 'failed', 'unconfigured']) {
        await assert.rejects(run(['clear', '--host', host], { purge: () => ({ host, outcome }) }), new RegExp(outcome));
    }
    for (const result of [{ success: true, purges: [] }, { success: false, purges: [accepted] },
        { success: true, purges: [{ host, outcome: 'failed' }] }]) {
        await assert.rejects(run(['hold', '--agent', agent], { changeHold: () => result }), /Cache hold failed/);
    }
    plan.lease.commit = () => false;
    await assert.rejects(run(['release', '--agent', agent], { changeHold: assert.fail }), /did not confirm/);
});

test('private mutation refuses other listeners, bridge peers, agent credentials, replay and request or activation mismatch', async () => {
    const plan = routePlan();
    const body = Buffer.from(JSON.stringify({ op: 'clear', host }));
    let calls = 0;
    const operations = { purge: () => { calls++; return accepted; } };
    const signed = () => ({ [CACHE_OPERATOR_HEADER]: signCacheOperatorRequest(body, plan.lease) });
    const headers = signed();
    assert.equal((await serve(plan, body, headers, operations)).status, 200);
    assert.equal((await serve(plan, body, headers, operations)).status, 401);
    assert.equal((await serve(plan, body, { 'ploinky-agent-assertion': 'agent-token', cookie: 'ploinky_jwt=local' }, operations)).status, 401);
    assert.equal((await serve({ ...plan, listener: 'public' }, body, signed(), operations)).status, 403);
    assert.equal((await serve(plan, body, signed(), operations, { socket: { remoteAddress: '10.0.0.2' } })).status, 403);
    assert.equal((await serve(plan, body, signed(), operations, { url: `${CACHE_OPERATOR_PATH}?` })).status, 403);
    assert.equal((await serve(plan, Buffer.from('{"op":"release","agent":"repo/application"}'), signed(), operations)).status, 401);
    assert.equal((await serve(routePlan(), body, signed(), operations)).status, 401);
    assert.equal(calls, 1);
});

test('CLI operations reach the Cloudflare API and preserve a failed release hold', async t => {
    const dataDir = fs.mkdtempSync(path.join(process.cwd(), '.cache-cli-test-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true }));
    const page = '/base-agent-additional-server/application/8787/page';
    const active = {
        ...generation, publicationState: 'ready',
        compiled: { hosts: { [host]: { routeKey: 'application', rootApplication: { routeKey: 'application', port: 8787 } } } },
        routing: { routes: { application: { repo: 'repo', agent: 'application' } } },
        manifests: { application: { routerAccess: { httpRoutes: [{ path: page, cache: 'page', access: 'public' }] } } },
    };
    const plan = routePlan();
    plan.snapshot = plan.lease.snapshot = active;
    const zone = 'a'.repeat(32);
    const calls = [];
    let upstreamStatus = 200;
    let time = 0;
    const api = createCloudflarePublicationApi({ fetchImpl: async (url, opts) => {
        calls.push({ path: new URL(url).pathname, method: opts.method, body: JSON.parse(opts.body) });
        return new Response(JSON.stringify({ success: upstreamStatus === 200, result: { id: zone } }), { status: upstreamStatus });
    } });
    const purgeOptions = { dataDir, api, readToken: () => 'synthetic-test-token', now: () => time,
        reservations: new Map(), warn() {} };
    const purge = input => purgeCacheHost(input, purgeOptions);
    let probes = 0;
    const operations = {
        purge, changeHold: input => changeCacheHold(input, {
            dataDir, purge, withConfigLock: callback => callback(),
            planRequest: () => ({ ok: true, kind: 'agent-root', routeKey: 'application', canonicalPath: page,
                decision: { access: 'public' }, responsePolicy: { cacheClass: 'page' } }),
            probe: async target => {
                assert.deepEqual(target, { host, path: '/page', publicPort: 8080 });
                assert.equal(readCacheSettings({ dataDir }).held[agent].by, 'local:admin');
                probes++;
                return true;
            },
        }),
    };
    const run = args => runCacheCommand(args, {
        configure: input => configureCachePurge(input, { dataDir, loadActive: () => ({ generation: active }),
            hasHandle: handle => handle === 'publication/purge', withLock: fn => fn() }),
        captureLease: () => plan.lease, request: transport(plan, operations), report() {},
    });
    await run(['purge-config', '--host', host, '--zone', zone, '--secret', 'publication/purge']);
    await run(['clear', '--host', host]);
    await assert.rejects(run(['clear', '--host', host]), /cooldown/);
    time += 16_000;
    await run(['hold', '--agent', agent]);
    assert.equal(probes, 1);
    time += 16_000;
    upstreamStatus = 429;
    await assert.rejects(run(['release', '--agent', agent]), /failed/);
    assert.ok(readCacheSettings({ dataDir }).held[agent]);
    time += 16_000;
    upstreamStatus = 200;
    await run(['release', '--agent', agent]);
    assert.equal(readCacheSettings({ dataDir }).held[agent], undefined);
    assert.equal(calls.length, 4);
    for (const call of calls) {
        assert.deepEqual(call, { path: `/client/v4/zones/${zone}/purge_cache`, method: 'POST', body: { hosts: [host] } });
    }
});
