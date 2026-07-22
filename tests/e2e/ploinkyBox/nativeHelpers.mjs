import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEngineProcessEnvironment, createProcessRunner } from '../../../ploinky-box/process.mjs';
import { resolveWorkspaceIdentity } from '../../../ploinky-box/identity.mjs';
import { createMutationLockManager } from '../../../ploinky-box/locks.mjs';
import { createBoxSupervisor } from '../../../ploinky-box/supervisor.mjs';

export function requirePodmanCandidate(t, env = process.env) {
    if (env.PLOINKY_BOX_REQUIRE_PODMAN !== '1') {
        t.skip('set PLOINKY_BOX_REQUIRE_PODMAN=1 for the rootless-Podman candidate gate');
        return null;
    }
    assert.match(process.platform, /^(?:darwin|linux)$/,
        'authoritative Box tests require Linux or macOS Podman Machine');
    const digest = String(env.PLOINKY_BOX_CANDIDATE_DIGEST || '');
    assert.match(digest, /^sha256:[a-f0-9]{64}$/,
        'PLOINKY_BOX_CANDIDATE_DIGEST must be one immutable candidate digest');
    return `docker.io/assistos/ploinky-box@${digest}`;
}

export function createPodmanHarness(t, candidateReference, {
    reconcile,
} = {}) {
    const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-podman-'));
    const root = fs.realpathSync(createdRoot);
    const workspace = path.join(root, 'workspace');
    const child = path.join(workspace, 'child');
    const lockHome = path.join(root, 'lock-home');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(lockHome);
    const environmentInput = {
        ...process.env,
        HOME: lockHome,
    };
    if (process.platform === 'darwin') {
        environmentInput.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME
            || path.join(os.homedir(), '.config');
    }
    const engineEnvironment = buildEngineProcessEnvironment(environmentInput);
    const runner = createProcessRunner({ env: engineEnvironment });
    const info = runner.query('podman', ['info', '--format', 'json']);
    assert.equal(info.ok, true, `rootless Podman is required: ${info.stderr}`);
    const parsedInfo = JSON.parse(info.stdout);
    assert.equal(parsedInfo.host?.security?.rootless ?? parsedInfo.Host?.Security?.Rootless, true);
    let launchDirectory = workspace;
    const resolveIdentity = () => resolveWorkspaceIdentity({
        env: {},
        cwd: () => launchDirectory,
    });
    const output = { bytes: '', write(chunk) { this.bytes += String(chunk); } };
    const supervisorOptions = {
        runner,
        lockManager: createMutationLockManager({ homeDirectory: lockHome }),
        resolveIdentity,
        platform: process.platform,
        env: {},
        stdout: output,
        stderr: output,
    };
    if (reconcile) supervisorOptions.reconcile = reconcile;
    const supervisor = createBoxSupervisor(supervisorOptions);
    const identity = resolveIdentity();
    async function cleanup() {
        const inspect = runner.query('podman', ['container', 'inspect', identity.instance]);
        if (inspect.ok) {
            let records;
            try {
                records = JSON.parse(inspect.stdout);
            } catch {
                assert.fail(`native Box inspection returned invalid JSON for ${identity.instance}`);
            }
            const id = String(records[0]?.Id || records[0]?.ID || '');
            assert.match(id, /^[a-f0-9]{12,64}$/,
                `native Box inspection returned an invalid ID for ${identity.instance}`);
            const removed = runner.query('podman', [
                'container', 'rm', '-f', '--time', '0', '--volumes', id,
            ], { timeoutMs: 120_000 });
            assert.equal(removed.ok, true, `failed to clean native Box ${id}: ${removed.stderr}`);
        }
        for (const name of Object.values(identity.volumes)) {
            runner.query('podman', ['volume', 'rm', '-f', name]);
        }
    }
    t.after(cleanup);
    return {
        root,
        workspace,
        child,
        lockHome,
        runner,
        supervisor,
        identity,
        output,
        engineEnvironment,
        candidateReference,
        useParent() { launchDirectory = workspace; },
        useChild() { launchDirectory = child; },
        resolveIdentity,
        cleanup,
    };
}

export function execInBox(runner, containerId, argv) {
    const result = runner.query('podman', [
        'container', 'exec', '--user', 'podman', '--workdir', '/workspace',
        containerId, ...argv,
    ], { timeoutMs: 120_000 });
    assert.equal(result.ok, true, `${argv.join(' ')} failed: ${result.stderr}`);
    return String(result.stdout || '').trim();
}
