import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import {
    appendControllerStateGuards,
    buildPersistentAgentRunArgs,
    buildPodmanStagedTargetMounts,
    ensurePodmanStagedAgentLibDir,
    ensurePodmanStagedCodeDir,
    podmanMountSuffix,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { CONTROLLER_STATE_DIR, PLOINKY_WORKSPACE_ROOT, SECRETS_FILE } from '../../cli/utils/config.js';
import { protectedControllerStateRoots } from '../../cli/utils/runtime/controllerStateGuards.js';
import { KEYPAIR_NAME } from '../../cli/utils/security/subjectIdentityKey.js';
import {
    initializeWorkspaceMasterKey,
    workspaceMasterKeyPath,
} from '../../ploinky-box/entrypoint/initialize-workspace.mjs';
import { makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

// Real-engine confidentiality check of the workspace master key and the stores
// it encrypts. A managed agent runs as the workspace owner (rootless root), so
// file modes cannot hide them; only the mount layout can. The workspace is
// built by the production initializer and secret store, the container by the
// production Podman run arguments. Synthetic key material only; never pulls.
const IMAGE = 'docker.io/library/busybox:1.36';
const SECRET_NAMES = ['master-key', '.secrets', 'ploinky_subject_identity_ed25519_v1.enc'];

function localPodmanImageId() {
    if (spawnSync('podman', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    const inspected = spawnSync('podman', ['image', 'inspect', '--format', '{{.Id}}', IMAGE], { encoding: 'utf8' });
    return inspected.status === 0 ? inspected.stdout.trim() : null;
}

const IMAGE_ID = localPodmanImageId();

// The two layouts that bind the whole workspace: at its own path (global) and
// at /root (isolated). The devel layout binds only a checkout.
const LAYOUTS = [
    { name: 'global', target: ws => ws, workdir: '/code' },
    { name: 'isolated', target: () => '/root', workdir: '/root' },
];

// Runs the production secret store in a controller process for `workspace`.
function controllerSecrets(workspace, operation, name = '', value = '') {
    const moduleUrl = new URL('../../cli/utils/security/encryptedSecretsFile.js', import.meta.url).href;
    const script = `
        const store = await import(${JSON.stringify(moduleUrl)});
        const [operation, name, value] = process.argv.slice(1);
        if (operation === 'set') store.setSecretValue(name, value);
        process.stdout.write(JSON.stringify(store.readSecretsFile()));
    `;
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace };
    delete env.PLOINKY_MASTER_KEY;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, operation, name, value], {
        cwd: workspace, env, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

function productionRunArgs(workspace, layout, containerName) {
    const agentName = 'demo';
    const agentCodePath = path.join(workspace, '.ploinky', 'repos', 'demoRepo', agentName);
    const sharedDir = path.join(workspace, '.data', 'shared');
    const agentHomeDir = path.join(workspace, '.data', agentName);
    const healthProbeHostDir = path.join(workspace, '.ploinky', 'run', 'health-probes', agentName);
    const nodeModulesDir = path.join(workspace, '.ploinky', 'deps', 'synthetic', 'node_modules');
    const agentLib = makeAgentLib(workspace, { name: 'ploinky/node_modules/achillesAgentLib' });
    for (const dir of [agentCodePath, sharedDir, agentHomeDir, healthProbeHostDir, nodeModulesDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(agentCodePath, 'index.js'), 'export default 1;\n');
    fs.symlinkSync(agentLib.sourceDir, path.join(nodeModulesDir, 'achillesAgentLib'));
    const runtimeRoot = path.join(workspace, '.ploinky', 'container-runtime', containerName);
    const cwdMountTarget = layout.target(workspace);
    const args = buildPersistentAgentRunArgs({
        runtime: 'podman',
        containerName,
        envHash: 'controller-secrets-podman-test',
        containerWorkdir: layout.workdir,
        agentLibMountPath: ensurePodmanStagedAgentLibDir(agentName, nodeModulesDir, { runtimeRoot, linkedRepositories: [] }),
        codeMountPath: ensurePodmanStagedCodeDir(agentName, agentCodePath, nodeModulesDir, new Map(), { runtimeRoot }),
        codeMountMode: ':z,ro',
        useNestedDependencyMounts: false,
        preparedNodeModulesDir: nodeModulesDir,
        sharedDir,
        healthProbeHostDir,
        cwd: workspace,
        cwdMountTarget,
        agentHomeDir,
        agentLibGrant: {
            sourceDir: agentLib.sourceDir,
            runtimePath: AGENTLIB_STABLE_MOUNT_PATH,
            mode: 'local',
            fingerprint: 'a1'.repeat(32),
            commit: '',
            sourceIdHash: 'b2'.repeat(32),
            namespaced: true,
        },
    });
    for (const mount of buildPodmanStagedTargetMounts({
        agentCodePath, nodeModulesDir, codeReadOnly: true, writableProjectSource: false,
    })) {
        args.push('-v', `${mount.source}:${mount.target}${podmanMountSuffix(mount.ro)}`);
    }
    appendControllerStateGuards(args, 'podman', { workspaceRoot: workspace, canonicalRuntimeWorkspaceGuards: false });
    return { args, alias: cwdMountTarget };
}

// A readable, non-empty file is key material in the agent's hands; no bytes are
// printed. Every probe is reported so a failure shows the whole picture.
function probe(containerName, files, alias) {
    const script = [
        'echo "UID $(id -u)"',
        ...files.map(([label, file]) =>
            `if test -r "${file}" && test -s "${file}"; then echo "PROBE ${label} READABLE"; else echo "PROBE ${label} DENIED"; fi`),
        `if echo control > "${alias}/control.txt"; then echo "PROBE control-project OK"; else echo "PROBE control-project DENIED"; fi`,
    ].join('\n');
    const result = spawnSync('podman', ['exec', containerName, 'sh', '-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const probes = new Map();
    let uid = '';
    for (const line of result.stdout.split('\n')) {
        const match = line.match(/^PROBE (\S+) (\S+)$/);
        if (match) probes.set(match[1], match[2]);
        const identity = line.match(/^UID (\d+)$/);
        if (identity) uid = identity[1];
    }
    return { probes, uid, output: result.stdout };
}

function secretProbes(alias, relativeDirectory) {
    return SECRET_NAMES.map(name => [name, path.posix.join(alias, '.ploinky', relativeDirectory, name)]);
}

function withRunningAgent(t, workspace, layout, suffix, callback) {
    const containerName = `ploinky_controller_secrets_${layout.name}_${suffix}_${process.pid}_${Date.now()}`;
    const { args, alias } = productionRunArgs(workspace, layout, containerName);
    t.after(() => spawnSync('podman', ['rm', '-f', '-t', '0', containerName], { stdio: 'ignore' }));
    const started = spawnSync('podman', [...args, IMAGE, 'sleep', '300'], { encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    return callback({ containerName, alias });
}

for (const layout of LAYOUTS) {
    test(`real podman: production ${layout.name} run arguments keep the master key and encrypted stores unreadable`, {
        skip: !IMAGE_ID && `podman with a local ${IMAGE} image is required`,
    }, (t) => {
        const workspace = tempRoot(t, 'controller-secrets-podman-');
        const { path: keyPath } = initializeWorkspaceMasterKey({ workspaceRoot: workspace });
        const dataDir = path.join(workspace, '.ploinky', 'data');
        assert.equal(keyPath, path.join(dataDir, 'master-key'));
        assert.deepEqual(controllerSecrets(workspace, 'set', 'SYNTHETIC_TOKEN', 'synthetic-value-1'),
            { SYNTHETIC_TOKEN: 'synthetic-value-1' });
        fs.writeFileSync(path.join(dataDir, SECRET_NAMES[2]), 'synthetic-envelope\n', { mode: 0o600 });
        for (const name of SECRET_NAMES) {
            const stat = fs.statSync(path.join(dataDir, name));
            assert.equal(stat.uid, process.getuid(), `${name} is owned by the workspace owner`);
            assert.equal(stat.mode & 0o777, 0o600);
        }
        const keyBefore = fs.readFileSync(keyPath);

        withRunningAgent(t, workspace, layout, 'current', ({ containerName, alias }) => {
            const files = secretProbes(alias, 'data');
            const initial = probe(containerName, files, alias);
            // Rootless root is the workspace owner: 0600 does not stop it.
            assert.equal(initial.uid, '0', initial.output);
            for (const [label] of files) {
                assert.equal(initial.probes.get(label), 'DENIED', `${layout.name}: ${label} readable\n${initial.output}`);
            }
            assert.equal(initial.probes.get('control-project'), 'OK', initial.output);

            // The controller replaces the store by rename while the agent runs.
            // A per-file mask would be detached by that rename; the masked
            // directory is not.
            assert.deepEqual(controllerSecrets(workspace, 'set', 'SYNTHETIC_TOKEN', 'synthetic-value-2'),
                { SYNTHETIC_TOKEN: 'synthetic-value-2' });
            const afterWrite = probe(containerName, files, alias);
            for (const [label] of files) {
                assert.equal(afterWrite.probes.get(label), 'DENIED', `${layout.name}: ${label} readable after a controller write\n${afterWrite.output}`);
            }
        });
        // Legitimate controller access is unchanged.
        assert.deepEqual(controllerSecrets(workspace, 'read'), { SYNTHETIC_TOKEN: 'synthetic-value-2' });
        assert.deepEqual(fs.readFileSync(keyPath), keyBefore);
        assert.equal(fs.readFileSync(path.join(workspace, 'control.txt'), 'utf8'), 'control\n');
    });

    // Negative control: the retired layout kept the key and its stores beside
    // `.ploinky/data`, where the same production arguments only pin them
    // read-only. The probe must see them, or it proves nothing above.
    test(`real podman: production ${layout.name} run arguments expose a retired .ploinky/<secret> (negative control)`, {
        skip: !IMAGE_ID && `podman with a local ${IMAGE} image is required`,
    }, (t) => {
        const workspace = tempRoot(t, 'controller-secrets-retired-');
        fs.mkdirSync(path.join(workspace, '.ploinky', 'data'), { recursive: true, mode: 0o700 });
        for (const name of SECRET_NAMES) {
            fs.writeFileSync(path.join(workspace, '.ploinky', name), `${'0'.repeat(64)}\n`, { mode: 0o600 });
        }
        withRunningAgent(t, workspace, layout, 'retired', ({ containerName, alias }) => {
            const files = secretProbes(alias, '');
            const exposed = probe(containerName, files, alias);
            for (const [label] of files) {
                assert.equal(exposed.probes.get(label), 'READABLE', `${layout.name}: ${label}\n${exposed.output}`);
            }
        });
        // Which is why the controller refuses to run with them there.
        const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace };
        delete env.PLOINKY_MASTER_KEY;
        const refused = spawnSync(process.execPath, ['--input-type=module', '-e',
            `await import(${JSON.stringify(new URL('../../cli/utils/security/masterKey.js', import.meta.url).href)}).then(m => m.resolveMasterKey());`,
        ], { cwd: workspace, env, encoding: 'utf8' });
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /PLOINKY_RETIRED_CONTROLLER_SECRETS|retired agent-readable location/);
        assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'data', 'master-key')), false);
    });
}

// Every controller secret path lies inside a root that each runtime masks
// (Podman/Docker and bwrap guards, Seatbelt read denial).
test('every controller secret path lies inside a masked controller-state root', () => {
    const roots = protectedControllerStateRoots(PLOINKY_WORKSPACE_ROOT).map(entry => entry.hostPath);
    const inside = file => roots.some(root => path.dirname(file) === root);
    for (const file of [
        SECRETS_FILE,
        workspaceMasterKeyPath(PLOINKY_WORKSPACE_ROOT),
        path.join(CONTROLLER_STATE_DIR, `${KEYPAIR_NAME}.enc`),
    ]) {
        assert.equal(inside(file), true, `${file} is outside ${roots.join(', ')}`);
    }
    assert.deepEqual(SECRET_NAMES, [
        path.basename(workspaceMasterKeyPath(PLOINKY_WORKSPACE_ROOT)),
        path.basename(SECRETS_FILE),
        `${KEYPAIR_NAME}.enc`,
    ]);
});
