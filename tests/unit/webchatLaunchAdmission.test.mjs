import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-launch-'));
const projectDir = path.join(workspaceRoot, 'project folder');
const explorerRoot = path.join(workspaceRoot, 'agents', 'explorer');
const codexRoot = path.join(workspaceRoot, 'agents', 'codex');
fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(explorerRoot, { recursive: true });
fs.mkdirSync(codexRoot, { recursive: true });
for (const agentRoot of [explorerRoot, codexRoot]) {
    fs.writeFileSync(path.join(agentRoot, 'manifest.json'), JSON.stringify({
        cli: 'node /code/scripts/interactive-cli.mjs',
    }));
    fs.writeFileSync(path.join(agentRoot, 'mcp-config.json'), JSON.stringify({
        providerSandbox: { provider: 'opencode', readiness: true },
    }));
}
fs.writeFileSync(path.join(workspaceRoot, '.ploinky', 'routing.json'), JSON.stringify({
    static: { agent: 'explorer', hostPath: explorerRoot },
    routes: {
        explorer: { hostPath: explorerRoot },
        codex: { hostPath: codexRoot },
    },
}));
process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;

const [{ handleWebChat }, { DIRECT_CLI_PATH }] = await Promise.all([
    import(`../../cli/server/handlers/webchat/index.js?launch-admission=${Date.now()}`),
    import('../../cli/utils/directCli.js'),
]);

function makeRequest(url) {
    const req = Readable.from([]);
    req.url = url;
    req.method = 'GET';
    req.headers = { host: '127.0.0.1' };
    req.socket = {};
    req.user = { id: 'local:test', username: 'test', roles: ['user'] };
    return req;
}

function makeResponse() {
    const headers = new Map();
    return {
        statusCode: 0,
        body: '',
        getHeader(name) { return headers.get(String(name).toLowerCase()); },
        setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
        writeHead(status, values = {}) {
            this.statusCode = status;
            for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
        },
        write(chunk) { this.body += String(chunk || ''); return true; },
        end(chunk = '') { this.body += String(chunk || ''); this.ended = true; },
    };
}

function createHarness() {
    const commands = [];
    let createCount = 0;
    const tty = {
        pid: 12345,
        onOutput() {},
        onClose() {},
        isAlive() { return true; },
        write() { return true; },
        dispose() {},
        kill() {},
    };
    const appConfig = {
        agentName: 'explorer',
        getFactoryForCommands(nextCommands) {
            commands.push(nextCommands);
            return {
                agentName: nextCommands.agentName,
                runtime: 'local',
                ttyFactory: {
                    create() {
                        createCount += 1;
                        return tty;
                    },
                },
            };
        },
    };
    return {
        appConfig,
        commands,
        get createCount() { return createCount; },
    };
}

async function launch(url, harness) {
    const req = makeRequest(url);
    const res = makeResponse();
    const appState = { sessions: new Map(), runtimes: new Map() };
    await handleWebChat(req, res, harness.appConfig, appState);
    return { req, res, appState };
}

test.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

test('invalid WebChat launch input fails before factory resolution or process creation', async () => {
    for (const [suffix, expectedCode] of [
        ['', 'PLOINKY_WORKDIR_REQUIRED'],
        ['&workspace-dir=.', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'],
        ['&workspace-dir=missing', 'PLOINKY_WORKDIR_INVALID'],
    ]) {
        const harness = createHarness();
        const { res } = await launch(`/webchat/stream?tabId=t1${suffix}`, harness);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(JSON.parse(res.body), { ok: false, error: expectedCode });
        assert.equal(harness.commands.length, 0);
        assert.equal(harness.createCount, 0);
    }
});

test('factory admission exceptions are sanitized before process creation', async () => {
    const harness = createHarness();
    harness.appConfig.getFactoryForCommands = () => {
        const error = new Error('/private/workspace and provider argv must not leak');
        error.code = 'PLOINKY_WEBCHAT_DIRECT_CLI_UNAVAILABLE';
        error.status = 503;
        throw error;
    };
    const { res } = await launch(
        '/webchat/stream?tabId=t1&workspace-dir=project%20folder',
        harness,
    );
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), {
        ok: false,
        error: 'PLOINKY_WEBCHAT_DIRECT_CLI_UNAVAILABLE',
    });
    assert.doesNotMatch(res.body, /private|provider argv/);
    assert.equal(harness.createCount, 0);
});

test('default and overridden agents use identical structured direct-CLI grammar', async () => {
    for (const [agentQuery, expectedAgent] of [
        ['', 'explorer'],
        ['&agent=codex', 'codex'],
    ]) {
        const harness = createHarness();
        const { res } = await launch(
            `/webchat/stream?tabId=t1&workspace-dir=project%20folder&model=value%20with%20spaces${agentQuery}`,
            harness,
        );
        assert.equal(res.statusCode, 200);
        assert.equal(harness.commands.length, 1);
        assert.equal(harness.createCount, 1);
        const [commands] = harness.commands;
        assert.equal(commands.executable, DIRECT_CLI_PATH);
        assert.deepEqual(commands.argv, [
            'cli',
            expectedAgent,
            '--workdir',
            'project folder',
            '--',
            '--dir=/workspace/project folder',
            '--model=value with spaces',
        ]);
        assert.equal(commands.cwd, fs.realpathSync(workspaceRoot));
        assert.equal(Object.hasOwn(commands, 'container'), false);
    }
});

test('static and overridden provider manifest drift fails before WebChat factory creation', async (t) => {
    for (const [agentRoot, suffix] of [
        [explorerRoot, ''],
        [codexRoot, '&agent=codex'],
    ]) {
        const manifestPath = path.join(agentRoot, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ cli: '/bin/sh -lc "printf provider-bypass"' }));
        t.after(() => fs.writeFileSync(manifestPath, JSON.stringify({
            cli: 'node /code/scripts/interactive-cli.mjs',
        })));
        const harness = createHarness();
        const { res } = await launch(
            `/webchat/stream?tabId=t1&workspace-dir=project%20folder${suffix}`,
            harness,
        );
        assert.equal(res.statusCode, 409);
        assert.deepEqual(JSON.parse(res.body), {
            ok: false,
            error: 'PLOINKY_PROVIDER_CLI_INVALID',
        });
        assert.equal(harness.commands.length, 0);
        assert.equal(harness.createCount, 0);
    }
});

test('WebChat rechecks provider capability after canonical preflight before dynamic drift', async (t) => {
    const manifestPath = path.join(explorerRoot, 'manifest.json');
    t.after(() => fs.writeFileSync(manifestPath, JSON.stringify({
        cli: 'node /code/scripts/interactive-cli.mjs',
    })));
    const acceptedHarness = createHarness();
    const accepted = await launch(
        '/webchat/stream?tabId=t1&workspace-dir=project%20folder',
        acceptedHarness,
    );
    assert.equal(accepted.res.statusCode, 200);
    assert.equal(acceptedHarness.createCount, 1);

    fs.writeFileSync(manifestPath, JSON.stringify({ cli: '/bin/sh -lc "printf provider-bypass"' }));
    const rejectedHarness = createHarness();
    const rejected = await launch(
        '/webchat/stream?tabId=t2&workspace-dir=project%20folder',
        rejectedHarness,
    );
    assert.equal(rejected.res.statusCode, 409);
    assert.deepEqual(JSON.parse(rejected.res.body), {
        ok: false,
        error: 'PLOINKY_PROVIDER_CLI_INVALID',
    });
    assert.equal(rejectedHarness.commands.length, 0);
    assert.equal(rejectedHarness.createCount, 0);
});

test('WebChat rejects provider endpoint evidence after sibling capability removal', async (t) => {
    const manifestPath = path.join(explorerRoot, 'manifest.json');
    const configPath = path.join(explorerRoot, 'mcp-config.json');
    t.after(() => {
        fs.writeFileSync(manifestPath, JSON.stringify({ cli: 'node /code/scripts/interactive-cli.mjs' }));
        fs.writeFileSync(configPath, JSON.stringify({
            providerSandbox: { provider: 'opencode', readiness: true },
        }));
    });
    fs.writeFileSync(configPath, '{}');
    fs.writeFileSync(manifestPath, JSON.stringify({
        cli: '/bin/sh -lc "printf provider-bypass"',
        endpoints: {
            models: {
                providerExecution: {
                    provider: 'opencode', mode: 'operation', module: '/code/x.mjs', export: 'run',
                },
            },
        },
    }));
    const harness = createHarness();
    const { res } = await launch(
        '/webchat/stream?tabId=t3&workspace-dir=project%20folder',
        harness,
    );
    assert.equal(res.statusCode, 409);
    assert.deepEqual(JSON.parse(res.body), {
        ok: false,
        error: 'PLOINKY_PROVIDER_CONFIG_INVALID',
    });
    assert.equal(harness.commands.length, 0);
    assert.equal(harness.createCount, 0);
});
