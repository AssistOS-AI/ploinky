import assert from 'node:assert/strict';
import test from 'node:test';

import {
    coordinatorRouteMatches,
    isTaskReferencePath,
    readExecutionProviderDeclaration,
    validateExecutionProviderDeclaration,
} from '../../cli/server/executionProvider/declaration.mjs';
import {
    assertExecutionProviderPublication,
    assertExecutionProviderRootApplication,
    assertExecutionProviderRoute,
    EXECUTION_PROVIDER_INVALID,
} from '../../cli/server/executionProvider/publication.mjs';

const KEY = 'alpha';
const base = (extra = {}) => ({
    version: 1,
    port: 7300,
    taskReferences: { path: '/v1/task-refs' },
    terminals: { path: '/v1/terminal-control' },
    ...extra,
});
const coordinator = (extra = {}) => ({
    path: `/base-agent-additional-server/${KEY}/7000/api/coord/*`,
    callers: ['agent:fixtures/beta'],
    ...extra,
});
const check = (value, routeKey = KEY) => validateExecutionProviderDeclaration(value, { routeKey });
const refused = (value, label = JSON.stringify(value)) => {
    const result = check(value);
    assert.equal(result.ok, false, label);
    assert.equal(typeof result.reason, 'string');
};

test('a valid declaration is normalized and frozen', () => {
    const result = check(base({ coordinatorRoutes: [coordinator()] }));
    assert.equal(result.ok, true);
    assert.equal(Object.isFrozen(result.declaration), true);
    assert.equal(result.declaration.port, 7300);
    assert.equal(result.declaration.terminals.path, '/v1/terminal-control');
    assert.equal(result.declaration.coordinatorRoutes[0].port, 7000);
    assert.deepEqual(result.declaration.coordinatorRoutes[0].suffix, ['api', 'coord']);
    assert.equal(result.declaration.coordinatorRoutes[0].wildcard, true);
    // Either endpoint alone is enough.
    assert.equal(check({ version: 1, port: 1, terminals: { path: '/t' } }).ok, true);
    assert.equal(check({ version: 1, port: 65535, taskReferences: { path: '/t' } }).ok, true);
});

test('presence is the own property: null, arrays and empty objects are errors, not absence', () => {
    assert.deepEqual(readExecutionProviderDeclaration({}), { present: false });
    assert.deepEqual(readExecutionProviderDeclaration(null), { present: false });
    for (const value of [null, [], {}, 'x', 7, true, base({ extra: 1 }), Object.create({ version: 1 })]) {
        const read = readExecutionProviderDeclaration({ executionProvider: value }, { routeKey: KEY });
        assert.equal(read.present, true, JSON.stringify(value));
        assert.equal(read.valid, false, JSON.stringify(value));
    }
    assert.equal(readExecutionProviderDeclaration({ executionProvider: base() }, { routeKey: KEY }).valid, true);
});

test('version, port and key grammar', () => {
    for (const version of [undefined, 0, 2, '1', 1.5, null, true]) refused(base({ version }), `version ${version}`);
    for (const port of [undefined, 0, 65536, -1, 7300.5, '7300', null, Number.NaN, 1e6]) refused(base({ port }), `port ${port}`);
    refused({ version: 1, port: 7300 });
    refused({ version: 1, port: 7300, coordinatorRoutes: [coordinator()] });
    refused(base({ unknown: true }));
    refused(base({ taskReferences: { path: '/a', extra: 1 } }));
    refused(base({ taskReferences: {} }));
    refused(base({ taskReferences: '/a' }));
    refused(base({ terminals: null }));
});

test('endpoint path grammar', () => {
    const bad = ['', '/', 'v1/x', '/v1/x/', '/v1//x', '/v1/./x', '/v1/../x', '/v1/%41', '/v1/x?q=1', '/v1/x#f', '/v1\\x',
        '/v1/x y', '/v1/x\ty', '/v1/x\n', '/v1/\u0000', '/v1/\u0085x', '/v1/ x', '/v1/\u007fx', 7, null, {}];
    for (const path of bad) refused(base({ taskReferences: { path } }), JSON.stringify(path));
    // The 1024 byte bound counts UTF-8 bytes, including at a multibyte boundary.
    const ascii = `/${'a'.repeat(1023)}`;
    assert.equal(Buffer.byteLength(ascii), 1024);
    assert.equal(check(base({ taskReferences: { path: ascii } })).ok, true);
    refused(base({ taskReferences: { path: `${ascii}a` } }), '1025 bytes');
    const multibyte = `/${'a'.repeat(1021)}é`;
    assert.equal(Buffer.byteLength(multibyte), 1024);
    assert.equal(check(base({ taskReferences: { path: multibyte } })).ok, true);
    refused(base({ taskReferences: { path: `/${'a'.repeat(1022)}é` } }), '1025 bytes with a multibyte tail');
});

test('endpoint paths must not be equal, ancestor or descendant, compared by segment', () => {
    const pair = (taskReferences, terminals) => check(base({ taskReferences: { path: taskReferences }, terminals: { path: terminals } }));
    assert.equal(pair('/v1', '/v1').ok, false);
    assert.equal(pair('/v1', '/v1/x').ok, false);
    assert.equal(pair('/v1/x', '/v1').ok, false);
    assert.equal(pair('/v1/task-refs', '/v1/task-refs/deep').ok, false);
    // Not segment ancestors, although one is a string prefix of the other.
    assert.equal(pair('/v1/task', '/v1/task-refs').ok, true);
    assert.equal(pair('/v1/task-refs', '/v1/task').ok, true);
    assert.equal(pair('/a', '/b').ok, true);
});

test('coordinator route grammar', () => {
    const withRoutes = (routes) => check(base({ coordinatorRoutes: routes }));
    assert.equal(withRoutes([coordinator(), coordinator({ path: `/base-agent-additional-server/${KEY}/7000/api/exact` })]).ok, true);
    for (const routes of [[], 'x', {}, null, Array.from({ length: 33 }, (_, i) => coordinator({ path: `/base-agent-additional-server/${KEY}/7000/p${i}` }))]) {
        assert.equal(withRoutes(routes).ok, false, JSON.stringify(routes).slice(0, 60));
    }
    assert.equal(withRoutes(Array.from({ length: 32 }, (_, i) => coordinator({ path: `/base-agent-additional-server/${KEY}/7000/p${i}` }))).ok, true);
    const badPaths = [
        `/base-agent-additional-server/${KEY}/7000`, `/base-agent-additional-server/${KEY}/7000/*`, '/api/coord',
        `/base-agent-additional-server/other/7000/api`, `/base-agent-additional-server/%61lpha/7000/api`,
        `/base-agent-additional-server/${KEY}/7000/api/%63oord`, `/base-agent-additional-server/${KEY}/7000/api?x=1`,
        `/base-agent-additional-server/${KEY}/7000/api/`, `/base-agent-additional-server/${KEY}/7000/api/../x`,
        `/base-agent-additional-server/${KEY}/7000/api\\x`, `/base-agent-additional-server/${KEY}/7000/a*b`,
        `/base-agent-additional-server/${KEY}/7000/*/x`, `/base-agent-additional-server/${KEY}/07000/api`,
        `/base-agent-additional-server/${KEY}/70000/api`,
        // The private provider port is never a coordinator port.
        `/base-agent-additional-server/${KEY}/7300/api`,
        // Path parameters are ignored when matching, so a declared ';' could never match.
        `/base-agent-additional-server/${KEY}/7000/api;v1/coord`, `/base-agent-additional-server/${KEY}/7000/api/coord;x/*`,
    ];
    for (const path of badPaths) assert.equal(withRoutes([coordinator({ path })]).ok, false, path);
    assert.equal(withRoutes([coordinator({ path: 5 })]).ok, false);
    assert.equal(withRoutes([{ path: coordinator().path }]).ok, false);
    assert.equal(withRoutes([coordinator({ extra: 1 })]).ok, false);
    // A route key is needed to validate the selector path.
    assert.equal(validateExecutionProviderDeclaration(base({ coordinatorRoutes: [coordinator()] })).ok, false);
});

test('coordinator callers are canonical, unique principals', () => {
    const callers = (value) => check(base({ coordinatorRoutes: [coordinator({ callers: value })] })).ok;
    assert.equal(callers(['agent:fixtures/beta', 'agent:fixtures/gamma']), true);
    assert.equal(callers(Array.from({ length: 16 }, (_, i) => `agent:fixtures/a${i}`)), true);
    assert.equal(callers(Array.from({ length: 17 }, (_, i) => `agent:fixtures/a${i}`)), false);
    for (const value of [[], 'agent:fixtures/beta', ['agent:fixtures/beta', 'agent:fixtures/beta'], ['agent:*'], ['agent:fixtures/*'],
        ['fixtures/beta'], ['agent:beta'], ['agent:fixtures/beta/x'], ['agent: fixtures/beta'], ['agent:fixtures/..'],
        ['agent:fixtures/beta '], [null], [{}], ['AGENT:fixtures/beta']]) {
        assert.equal(callers(value), false, JSON.stringify(value));
    }
});

test('coordinator scopes may not repeat or overlap', () => {
    const route = (suffix) => coordinator({ path: `/base-agent-additional-server/${KEY}/7000${suffix}` });
    const ok = (...suffixes) => check(base({ coordinatorRoutes: suffixes.map(route) })).ok;
    assert.equal(ok('/x/*', '/y/*'), true);
    assert.equal(ok('/x', '/x/y'), true);
    assert.equal(ok('/x', '/xy/*'), true);
    assert.equal(ok('/x', '/x'), false);
    assert.equal(ok('/x/*', '/x'), false);
    assert.equal(ok('/x/*', '/x/y'), false);
    assert.equal(ok('/x/y', '/x/*'), false);
    assert.equal(ok('/x/*', '/x/y/*'), false);
});

test('coordinator matching sees decoded, dot-segment and double-slash spellings and fails closed on bad encoding', () => {
    const { declaration } = check(base({ coordinatorRoutes: [coordinator(), coordinator({ path: `/base-agent-additional-server/${KEY}/7000/exact` })] }));
    const hit = (suffixPath, port = 7000) => coordinatorRouteMatches(declaration, { port, suffixPath });
    for (const path of ['/api/coord', '/api/coord/', '/api/coord/deep/er', '/api/%63oord/x', '/api/%2563oord', '//api//coord/x',
        '/api/./coord', '/other/../api/coord/x', '/exact', '/exact/', '/api/coord?x=1', '/api/%E0%A4%A']) {
        assert.equal(hit(path), true, path);
    }
    for (const path of ['/api', '/api/coordx', '/exact/deeper', '/', '/other']) assert.equal(hit(path), false, path);
    assert.equal(hit('/api/coord', 7001), false);
    assert.equal(hit('/api/coord', null), true);
    assert.equal(coordinatorRouteMatches(check(base()).declaration, { port: 7000, suffixPath: '/api/coord' }), false);
});

test('a declaration that bypassed validation with a ";" segment is still matched on the folded segment (defence)', () => {
    const declaration = { coordinatorRoutes: [{ port: 7000, suffix: ['api;v1', 'Coord'], wildcard: false }] };
    for (const path of ['/api/coord', '/API;x/COORD', '/api;v1/coord;y']) {
        assert.equal(coordinatorRouteMatches(declaration, { port: 7000, suffixPath: path }), true, path);
    }
});

test('the task-reference mount has exact mount semantics including encoded aliases', () => {
    for (const path of ['/task-refs', '/task-refs/', '/task-refs/abc', '/task-refs/a/b', '/%74ask-refs', '/task%2Drefs/x',
        '/task-refs%2Fabc', '/task%2Drefs%2Fabc', '/%2574ask-refs/x', '//task-refs/x', '/./task-refs', '/x/../task-refs/y']) {
        assert.equal(isTaskReferencePath(path), true, path);
    }
    for (const path of ['/', '/task-refs-extra', '/task-refs-extra/x', '/task-refs%2Dextra', '/task-ref', '/x/task-refs', '/Task-Refs', '/mcp']) {
        assert.equal(isTaskReferencePath(path), false, path);
    }
});

// ---- publication ----

const refusal = (options, pattern) => assert.throws(
    () => assertExecutionProviderPublication({ routeKey: KEY, ...options }),
    (error) => error.code === EXECUTION_PROVIDER_INVALID && pattern.test(error.message),
);
const provider = (extra = {}) => ({ executionProvider: base(), ...extra });

test('publication ignores a manifest without a declaration and returns the normalized declaration otherwise', () => {
    assert.equal(assertExecutionProviderPublication({ manifest: {}, routeKey: KEY }), null);
    assert.equal(assertExecutionProviderPublication({ manifest: { profiles: { default: { openPorts: ['7300'] } } }, routeKey: KEY }), null);
    assert.equal(assertExecutionProviderPublication({ manifest: provider(), routeKey: KEY }).port, 7300);
});

test('publication refuses an invalid declaration and the reserved task-refs route key', () => {
    refusal({ manifest: { executionProvider: null } }, /plain object/);
    refusal({ manifest: { executionProvider: { version: 1, port: 7300 } } }, /at least one/);
    refusal({ manifest: {}, routeKey: 'task-refs' }, /reserved/);
});

test('publication refuses the provider port on either side of any openPorts mapping in any profile, TCP or UDP, ranges included', () => {
    const profiles = (openPorts, name = 'default') => provider({ profiles: { default: {}, [name]: { openPorts } } });
    for (const spec of ['7300', '7300:7000', '8800:7300', '127.0.0.1:8800:7300', '7300/udp', '7298-7302', '8800-8805:7298-7303',
        '0.0.0.0:7300:7300', '9000:7300/udp']) {
        refusal({ manifest: profiles([spec], 'qa') }, /openPorts/);
        refusal({ manifest: profiles(spec, 'qa') }, /openPorts/);
    }
    // The effective profile of the launch is inspected as well.
    refusal({ manifest: provider(), profileConfig: { openPorts: ['7300'] } }, /effective/);
    // A neighbouring range does not conflict.
    assert.ok(assertExecutionProviderPublication({ manifest: profiles(['7301', '7000-7299', '7301-7400/udp', '8800:7000']), routeKey: KEY }));
    // An unreadable spec of a provider fails closed.
    refusal({ manifest: profiles(['not a port']) }, /cannot be read/);
});

test('publication refuses the provider port in actual launch and registry mappings', () => {
    refusal({ manifest: provider(), portMappings: [{ hostPort: 8800, containerPort: 7300, protocol: 'tcp' }] }, /mapping/);
    refusal({ manifest: provider(), portMappings: () => [{ hostPort: 7300, containerPort: 7000, protocol: 'udp' }] }, /mapping/);
    refusal({ manifest: provider(), registryPorts: [{ hostPort: 43100, containerPort: 7300 }] }, /mapping/);
    refusal({ manifest: provider(), registryPorts: [{ hostPort: 7300, containerPort: 7000 }] }, /mapping/);
    assert.ok(assertExecutionProviderPublication({
        manifest: provider(),
        routeKey: KEY,
        portMappings: [{ hostPort: 0, containerPort: 0 }, { hostPort: 8800, containerPort: 7000 }],
        registryPorts: [{ hostPort: 43100, containerPort: 7000 }],
    }));
});

test('publication refuses the implicit AgentServer PORT, resolved or static, except for start-only agents', () => {
    refusal({ manifest: provider(), agentServerPort: 7300 }, /AgentServer port/);
    refusal({ manifest: provider(), agentServerPort: () => 7300 }, /AgentServer port/);
    refusal({ manifest: provider({ env: { PORT: '7300' } }) }, /env\.PORT/);
    refusal({ manifest: provider({ profiles: { default: { env: ['PORT=7300'] } } }) }, /env\.PORT/);
    refusal({ manifest: provider({ profiles: { default: { env: { PORT: { value: 7300 } } } } }) }, /env\.PORT/);
    refusal({ manifest: provider({ profiles: { default: {} } }), profileConfig: { env: { PORT: 7300 } } }, /env\.PORT/);
    assert.ok(assertExecutionProviderPublication({ manifest: provider(), routeKey: KEY, agentServerPort: 7000 }));
    // A start-only agent has no implicit AgentServer to collide with.
    assert.ok(assertExecutionProviderPublication({
        manifest: provider({ start: 'node server.js' }), routeKey: KEY, agentServerPort: 7300,
    }));
});

test('publication refuses any routerAccess.httpRoutes declaration selecting the port, disabled ones included', () => {
    const route = (path, extra = {}) => provider({ routerAccess: { httpRoutes: [{ path, access: 'public', ...extra }] } });
    const selecting = [
        `/base-agent-additional-server/${KEY}/7300/*`, `/base-agent-additional-server/${KEY}/7300/x`, `/base-agent-additional-server/${KEY}/7300`,
        `/base-agent-additional-server/${KEY}/7300/`, `/base-agent-additional-server/${KEY}/*`, '/base-agent-additional-server/*',
        `  /base-agent-additional-server/${KEY}/7300/*  `, `base-agent-additional-server/${KEY}/7300/*`,
    ];
    for (const path of selecting) {
        refusal({ manifest: route(path) }, /selects the provider port/);
        refusal({ manifest: route(path, { enabled: false }) }, /selects the provider port/);
    }
    refusal({ manifest: provider({ routerAccess: { httpRoutes: { [`/base-agent-additional-server/${KEY}/7300/*`]: 'public' } } }) }, /selects/);
    refusal({ manifest: provider({ routerAccess: { httpRoutes: { [`/base-agent-additional-server/${KEY}/7300/*`]: { access: 'public', enabled: false } } } }) }, /selects/);
    for (const path of [`/base-agent-additional-server/${KEY}/7000/*`, `/base-agent-additional-server/${KEY}/73000/*`, '/public/*',
        `/base-agent-additional-server/other/7300/*`]) {
        assert.ok(assertExecutionProviderPublication({ manifest: route(path), routeKey: KEY }), path);
    }
});

test('ports 8080 and 8081 are reserved only in effective host network mode', () => {
    for (const port of [8080, 8081]) {
        const manifest = { executionProvider: { version: 1, port, terminals: { path: '/t' } } };
        refusal({ manifest, networkMode: 'host' }, /reserved by the Router/);
        assert.ok(assertExecutionProviderPublication({ manifest, routeKey: KEY, networkMode: 'bridge' }));
        assert.ok(assertExecutionProviderPublication({ manifest, routeKey: KEY }));
    }
});

test('coordinator routes must name the routed root port', () => {
    const manifest = provider({ executionProvider: base({ coordinatorRoutes: [coordinator()] }) });
    assert.ok(assertExecutionProviderPublication({ manifest, routeKey: KEY }));
    assert.ok(assertExecutionProviderPublication({ manifest, routeKey: KEY, agentServerPort: 7000 }));
    refusal({ manifest, agentServerPort: 8000 }, /routed root port 8000/);
    refusal({ manifest: provider({ executionProvider: base({ coordinatorRoutes: [coordinator({ path: `/base-agent-additional-server/${KEY}/7001/x` })] }) }) }, /routed root port 7000/);
    // A secret-backed PORT cannot be resolved statically and is checked at launch.
    assert.ok(assertExecutionProviderPublication({
        manifest: { ...manifest, env: [{ name: 'PORT', varName: 'PORT_SECRET' }] }, routeKey: KEY,
    }));
});

test('compile-time route and root-application checks use the actual registry mapping', () => {
    const manifest = provider({ executionProvider: base({ coordinatorRoutes: [coordinator()] }) });
    const record = (ports, extra = {}) => ({ profile: 'default', config: { ports }, ...extra });
    const run = (route, rec, man = manifest) => assertExecutionProviderRoute({ routeKey: KEY, route, manifest: man, record: rec });
    assert.ok(run({ hostPort: 43101 }, record([{ containerPort: 7000, hostPort: 43101 }])));
    // No target yet (dynamic port not resolved): publication still compiles.
    assert.ok(run({ hostPort: 0 }, record([{ containerPort: 7000, hostPort: 0 }])));
    assert.throws(() => run({ hostPort: 43101 }, record([{ containerPort: 7300, hostPort: 43101 }])), (e) => e.code === EXECUTION_PROVIDER_INVALID);
    assert.throws(() => run({ hostPort: 43101 }, record([{ containerPort: 7001, hostPort: 43101 }])), /routed root port 7001/);
    // Host network: the route's own target is the root.
    const hostManifest = { ...manifest, network: { mode: 'host' } };
    assert.throws(() => run({ hostPort: 7300 }, record([]), hostManifest), /routed root target is the provider port|AgentServer port is the provider port/);
    assert.ok(run({ hostPort: 7000 }, record([]), hostManifest));
    assert.throws(() => assertExecutionProviderRootApplication({
        hostname: 'h.test', rootApplication: { agent: 'fixtures/alpha', port: 7300 }, routeKey: KEY, manifest,
    }), /rootApplication maps the provider port 7300/);
    assert.doesNotThrow(() => assertExecutionProviderRootApplication({
        hostname: 'h.test', rootApplication: { agent: 'fixtures/alpha', port: 8787 }, routeKey: KEY, manifest,
    }));
    assert.doesNotThrow(() => assertExecutionProviderRootApplication({
        hostname: 'h.test', rootApplication: { agent: 'fixtures/alpha', port: 7300 }, routeKey: KEY, manifest: {},
    }));
});
