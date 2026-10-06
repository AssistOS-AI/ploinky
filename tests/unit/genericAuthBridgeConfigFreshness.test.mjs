import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-freshness-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const agentsFile = path.join(workspace, '.ploinky', 'agents.json');
const providerDir = path.join(workspace, '.ploinky', 'repos', 'fixture', 'identity');
fs.mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
fs.writeFileSync(path.join(providerDir, 'manifest.json'), JSON.stringify({ ssoProvider: true }));
fs.writeFileSync(path.join(providerDir, 'runtime', 'index.mjs'), `
export function resolveProviderConfig({ workspaceConfig, providerConfig }) {
    providerConfig.nested.items.push('provider');
    workspaceConfig.sso.providerConfig.nested.items.push('workspace');
    return { mutations: providerConfig.nested.items.length };
}
export function createProvider({ getConfig }) {
    return {
        async sso_begin_login() {
            const config = await getConfig();
            return { authorizationUrl: 'https://identity.test/' + config.mutations, providerState: 'fixture' };
        },
        async sso_handle_callback() {
            return { user: { id: 'fixture-user' }, providerSession: { expiresAt: Date.now() + 60000 } };
        },
        async sso_validate_session({ providerSession }) {
            const config = await getConfig();
            return { user: { id: 'fixture-user', mutations: config.mutations }, providerSession };
        }
    };
}
`);

const workspaceModuleUrl = new URL('../../cli/utils/workspace.js', import.meta.url);
const workspaceApi = await import(workspaceModuleUrl.href);
const { createGenericAuthBridge } = await import('../../cli/server/auth/genericAuthBridge.js');

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

function config(enabled = true) {
    return { sso: { enabled, providerAgent: 'fixture/identity', providerConfig: { nested: { items: [] } } } };
}

test('same-process setConfig disables SSO on the next call', () => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge();
    assert.equal(bridge.isConfigured(), true);
    workspaceApi.setConfig(config(false));
    assert.equal(bridge.isConfigured(), false);
});

test('a child-process setConfig disables SSO on the next call without local invalidation', () => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge();
    assert.equal(bridge.isConfigured(), true);
    execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { setConfig } = await import(process.argv[1]);
        setConfig(JSON.parse(process.argv[2]));
    `, workspaceModuleUrl.href, JSON.stringify(config(false))], {
        cwd: workspace,
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace },
        stdio: 'pipe',
        timeout: 30000,
    });
    assert.equal(bridge.isConfigured(), false);
});

test('a direct same-size rename changes SSO on the next call without local invalidation', () => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge();
    assert.equal(bridge.isConfigured(), true);
    const original = fs.readFileSync(agentsFile, 'utf8');
    const replacement = original.replace('"enabled": true', '"enabled": null');
    assert.notEqual(replacement, original);
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
    fs.writeFileSync(`${agentsFile}.next`, replacement);
    fs.renameSync(`${agentsFile}.next`, agentsFile);
    assert.equal(bridge.isConfigured(), false);
});

test('an in-place size-changing write disables SSO on the next call without local invalidation', () => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge();
    assert.equal(bridge.isConfigured(), true);
    const originalSize = fs.statSync(agentsFile).size;
    fs.writeFileSync(agentsFile, JSON.stringify({ _config: config(false) }));
    assert.notEqual(fs.statSync(agentsFile).size, originalSize);
    assert.equal(bridge.isConfigured(), false);
});

test('1000 unchanged isConfigured calls read agents.json once and never mkdir', (t) => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge();
    const read = fs.readFileSync;
    const mkdir = fs.mkdirSync;
    let reads = 0;
    let mkdirs = 0;
    t.mock.method(fs, 'readFileSync', (...args) => { reads += 1; return read(...args); });
    t.mock.method(fs, 'mkdirSync', (...args) => { mkdirs += 1; return mkdir(...args); });
    for (let index = 0; index < 1000; index += 1) assert.equal(bridge.isConfigured(), true);
    assert.equal(reads, 1);
    assert.equal(mkdirs, 0);
});

test('saveAgents invalidates even when a filesystem reports the previous stamp', (t) => {
    workspaceApi.setConfig(config());
    const oldStamp = fs.statSync(agentsFile, { bigint: true });
    const bridge = createGenericAuthBridge();
    assert.equal(bridge.isConfigured(), true);
    const stat = fs.statSync;
    t.mock.method(fs, 'statSync', (file, ...args) => file === agentsFile ? oldStamp : stat(file, ...args));
    workspaceApi.setConfig(config(false));
    assert.equal(bridge.isConfigured(), false);
});

test('providers can mutate nested configuration during beginLogin and remote validation', async () => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge({ ssoValidationIntervalMs: 0 });
    assert.equal(bridge.isConfigured(), true);
    const snapshot = workspaceApi.getConfigSnapshot();
    assert.equal(Object.isFrozen(snapshot.sso.providerConfig.nested.items), true);
    const login = await bridge.beginLogin({ baseUrl: 'http://localhost:8080' });
    assert.equal(login.redirectUrl, 'https://identity.test/2');
    const callback = await bridge.handleCallback({
        code: 'fixture-code', state: login.state, browserBinding: login.browserBinding,
        baseUrl: 'http://localhost:8080',
    });
    const validated = await bridge.validateSession(callback.sessionId, { forceRemote: true });
    assert.ok(validated);
    assert.equal(validated.user.mutations, 2);
    assert.deepEqual(snapshot.sso.providerConfig.nested.items, []);
    assert.deepEqual(workspaceApi.getConfig().sso.providerConfig.nested.items, []);
});

test('snapshot parity with loadAgents for empty, null, missing, corrupt and ENOTDIR input', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-parity-'));
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => {
        process.env.PLOINKY_WORKSPACE_ROOT = workspace;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const file = path.join(root, '.ploinky', 'agents.json');
    const compare = () => {
        let expected;
        let expectedError;
        try { expected = workspaceApi.loadAgents(); } catch (error) { expectedError = error; }
        if (expectedError) {
            assert.throws(() => workspaceApi.readAgentsSnapshot(), (error) => {
                assert.equal(error.constructor, expectedError.constructor);
                assert.equal(error.code, expectedError.code);
                assert.equal(error.message, expectedError.message);
                return true;
            });
        } else {
            const actual = workspaceApi.readAgentsSnapshot();
            assert.deepEqual(actual, expected);
            assert.equal(Object.isFrozen(actual), true);
        }
    };
    assert.deepEqual(workspaceApi.readAgentsSnapshot(), {});
    assert.equal(fs.statSync(path.dirname(file)).isDirectory(), true);
    compare();
    for (const contents of ['', '{}', 'null', '{']) {
        fs.writeFileSync(`${file}.next`, contents);
        fs.renameSync(`${file}.next`, file);
        compare();
    }
    fs.unlinkSync(file);
    compare();
    fs.rmdirSync(path.dirname(file));
    fs.writeFileSync(path.dirname(file), 'not a directory');
    compare();
});

test('corrupt registry falls back to disabled SSO and a corrected file recovers immediately', () => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge();
    assert.equal(bridge.isConfigured(), true);
    fs.writeFileSync(agentsFile, '{');
    assert.equal(bridge.isConfigured(), false);
    fs.writeFileSync(agentsFile, JSON.stringify({ _config: config() }));
    assert.equal(bridge.isConfigured(), true);
});

test('1000 scheduled requests across an atomic rename see only the complete old or new configuration', async () => {
    workspaceApi.setConfig(config());
    const bridge = createGenericAuthBridge();
    const outcomes = await Promise.all(Array.from({ length: 1000 }, (_, index) => new Promise((resolve, reject) => {
        setImmediate(() => {
            try {
                if (index === 500) {
                    fs.writeFileSync(`${agentsFile}.next`, JSON.stringify({ _config: config(false) }));
                    fs.renameSync(`${agentsFile}.next`, agentsFile);
                }
                resolve(bridge.isConfigured());
            } catch (error) { reject(error); }
        });
    })));
    assert.deepEqual(outcomes, [...Array(500).fill(true), ...Array(500).fill(false)]);
});
