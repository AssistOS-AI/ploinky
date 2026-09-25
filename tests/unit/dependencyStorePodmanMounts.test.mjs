import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import {
    appendLegacyAgentDataGuards,
    buildPersistentAgentRunArgs,
    buildPodmanStagedTargetMounts,
    ensurePodmanStagedAgentLibDir,
    ensurePodmanStagedCodeDir,
    podmanMountSuffix,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { buildAgentInstallPlan } from '../../cli/utils/dependencies/store/installContract.mjs';
import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { containerProvider, fakeInstaller, fakeLease, makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

// Real-engine check of the immutable dependency cache: a published dependency store
// object is mounted with the production Podman run arguments and a real
// container tries to modify it. Requires a local busybox image; never pulls.
const IMAGE = 'docker.io/library/busybox:1.36';
const GLOBAL = Object.freeze({ name: 'ploinky-global-deps', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } });

function localPodmanImageId() {
    if (spawnSync('podman', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    const inspected = spawnSync('podman', ['image', 'inspect', '--format', '{{.Id}}', IMAGE], { encoding: 'utf8' });
    return inspected.status === 0 ? inspected.stdout.trim() : null;
}

const IMAGE_ID = localPodmanImageId();

// Relative path, mode and content (file bytes or symlink text) of every entry.
function snapshotTree(dir) {
    const entries = [];
    const walk = (current, rel) => {
        for (const name of fs.readdirSync(current).sort()) {
            const abs = path.join(current, name);
            const relName = rel ? `${rel}/${name}` : name;
            const stat = fs.lstatSync(abs);
            const content = stat.isSymbolicLink() ? fs.readlinkSync(abs)
                : stat.isFile() ? fs.readFileSync(abs).toString('base64') : null;
            entries.push([relName, stat.mode, content]);
            if (stat.isDirectory()) walk(abs, relName);
        }
    };
    walk(dir, '');
    return entries;
}

function publishObject(store, lease, { provider, agentLib, registration, dependencies }) {
    const plan = buildAgentInstallPlan({
        provider,
        globalPackage: GLOBAL,
        agentPackage: {
            selection: 'code',
            relativePath: `${registration}/code/package.json`,
            sha256: 'f'.repeat(64),
            manifest: { name: registration.replace('/', '-'), version: '1.0.0', dependencies },
        },
        registration,
        agentLibSelection: agentLib,
    });
    const built = store.ensureGeneration(lease, plan, {
        installer: fakeInstaller(),
        consumer: { kind: 'container', engine: 'podman', containerName: `ploinky_${registration.replace('/', '_')}` },
    });
    assert.equal(built.status, 'built');
    return { plan, built };
}

function assertObjectValid(store, object) {
    const validation = store.validateObject(object.built.objectId, { inputKey: object.plan.inputKey });
    assert.equal(validation.valid, true, validation.reason);
}

function probeScript(probes) {
    return probes.map(([label, command]) =>
        `if sh -c ${JSON.stringify(command)} 2>/dev/null; then echo "PROBE ${label} OK"; else echo "PROBE ${label} DENIED"; fi`);
}

function runDetached(args, script) {
    const name = args[args.indexOf('--name') + 1];
    try {
        const started = spawnSync('podman', [...args, IMAGE, 'sh', '-c', script], { encoding: 'utf8' });
        assert.equal(started.status, 0, started.stderr || started.stdout);
        const waited = spawnSync('podman', ['wait', name], { encoding: 'utf8' });
        const logs = spawnSync('podman', ['logs', name], { encoding: 'utf8' });
        assert.equal(waited.stdout.trim(), '0', `${waited.stderr}${logs.stdout}${logs.stderr}`);
        const probes = new Map();
        const reads = new Map();
        for (const line of logs.stdout.split('\n')) {
            const probe = line.match(/^PROBE (\S+) (OK|DENIED)$/);
            if (probe) probes.set(probe[1], probe[2]);
            const read = line.match(/^READ (\S+) (.*)$/);
            if (read) reads.set(read[1], read[2]);
        }
        return { probes, reads, logs: logs.stdout };
    } finally {
        spawnSync('podman', ['rm', '-f', name], { stdio: 'ignore' });
    }
}

// The three project layouts of buildPersistentAgentRunArgs: the workspace at
// its own path (global), the workspace at /root (isolated), and a repository
// checkout inside the controller root (devel).
const LAYOUTS = [
    { name: 'global', cwd: ws => ws, target: ws => ws, workdir: '/code' },
    { name: 'isolated', cwd: ws => ws, target: () => '/root', workdir: '/root' },
    { name: 'devel', cwd: ws => path.join(ws, '.ploinky', 'repos', 'demoRepo'), target: ws => path.join(ws, '.ploinky', 'repos', 'demoRepo'), workdir: '/code' },
];

// Fresh workspaces have no retired .ploinky/data or .ploinky/shared roots;
// migrated workspaces still do. The controller guards differ between the two.
for (const layout of LAYOUTS) for (const legacyRoots of [false, true]) {
    const variant = `${layout.name}${legacyRoots ? ' with legacy data roots' : ''}`;
    test(`real podman: production ${variant} run arguments keep every dependency store object immutable`, { skip: !IMAGE_ID && `podman with a local ${IMAGE} image is required` }, (t) => {
        const workspace = tempRoot(t, 'depstore-podman-');
        if (legacyRoots) {
            for (const key of ['data', 'shared']) fs.mkdirSync(path.join(workspace, '.ploinky', key), { recursive: true });
        }
        const agentLib = makeAgentLib(workspace, { name: 'ploinky/node_modules/achillesAgentLib' });
        const provider = containerProvider({ imageId: IMAGE_ID, engine: 'podman', agentLib });
        const { lease, assertLease } = fakeLease();
        const store = createCacheStore({
            depsDir: path.join(workspace, '.ploinky', 'deps'),
            workspaceRoot: workspace,
            assertLease,
            checkDiskSpace: () => ({ ok: true, availableBytes: 1e12 }),
        });
        const own = publishObject(store, lease, { provider, agentLib, registration: 'demoRepo/demo', dependencies: { 'dep-own': '1.0.0' } });
        const other = publishObject(store, lease, { provider, agentLib, registration: 'demoRepo/other', dependencies: { 'dep-other': '1.0.0' } });
        assertObjectValid(store, own);
        assertObjectValid(store, other);

        const agentName = 'demo';
        const containerName = `ploinky_depstore_ro_${layout.name}${legacyRoots ? "_legacy" : ""}_${process.pid}_${Date.now()}`;
        const cwd = layout.cwd(workspace);
        const cwdMountTarget = layout.target(workspace);
        const agentCodePath = path.join(workspace, '.ploinky', 'repos', 'demoRepo', agentName);
        const sharedDir = path.join(workspace, '.data', 'shared');
        const agentHomeDir = path.join(workspace, '.data', agentName);
        const healthProbeHostDir = path.join(workspace, '.ploinky', 'run', 'health-probes', agentName);
        for (const dir of [agentCodePath, sharedDir, agentHomeDir, healthProbeHostDir]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(agentCodePath, 'index.js'), 'export default 1;\n');

        // Same sequence as the Podman start path: staged Agent and code trees,
        // the persistent run arguments, staged target mounts, then legacy guards.
        const nodeModulesDir = own.built.nodeModulesPath;
        const runtimeRoot = path.join(workspace, '.ploinky', 'container-runtime', containerName);
        const args = buildPersistentAgentRunArgs({
            runtime: 'podman',
            containerName,
            envHash: 'depstore-podman-test',
            containerWorkdir: layout.workdir,
            agentLibMountPath: ensurePodmanStagedAgentLibDir(agentName, nodeModulesDir, { runtimeRoot, linkedRepositories: [] }),
            codeMountPath: ensurePodmanStagedCodeDir(agentName, agentCodePath, nodeModulesDir, new Map(), { runtimeRoot }),
            codeMountMode: ':z,ro',
            useNestedDependencyMounts: false,
            preparedNodeModulesDir: nodeModulesDir,
            sharedDir,
            healthProbeHostDir,
            cwd,
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
            agentCodePath,
            nodeModulesDir,
            codeReadOnly: true,
            writableProjectSource: agentCodePath.startsWith(`${cwd}${path.sep}`),
        })) {
            args.push('-v', `${mount.source}:${mount.target}${podmanMountSuffix(mount.ro)}`);
        }
        appendLegacyAgentDataGuards(args, 'podman', { workspaceRoot: workspace, canonicalRuntimeWorkspaceGuards: false });

        // A store path is reachable beyond its own read-only bind only through the
        // writable project bind; this is its spelling there, if it has one.
        const projectAlias = (hostPath) => (hostPath === cwd || hostPath.startsWith(`${cwd}${path.sep}`)
            ? path.posix.join(cwdMountTarget, path.relative(cwd, hostPath))
            : null);
        const objectDir = path.dirname(own.built.payloadPath);
        const otherModules = other.built.nodeModulesPath;
        const ownProbes = [
            ['own-file-via-code', 'echo tampered > /code/node_modules/left-pad/index.js'],
            ['own-new-via-code', 'echo tampered > /code/node_modules/new.js'],
            ['own-file', `echo tampered > ${nodeModulesDir}/left-pad/index.js`],
            ['own-new', `echo tampered > ${nodeModulesDir}/new.js`],
            ['own-lock', `echo tampered > ${nodeModulesDir}/.package-lock.json`],
            ['own-rm', `rm ${nodeModulesDir}/dep-own/package.json`],
            ['own-mkdir', `mkdir ${nodeModulesDir}/newdir`],
            ['own-chmod', `chmod 777 ${nodeModulesDir}/left-pad/index.js`],
            ['own-symlink', `ln -s /etc/passwd ${nodeModulesDir}/evil`],
            ['own-rename', `mv ${nodeModulesDir}/dep-own ${nodeModulesDir}/dep-moved`],
            ['own-agentlib-link', `rm ${nodeModulesDir}/achillesAgentLib`],
        ];
        // Through the project bind the whole store is visible, including the
        // admitted tree under another spelling and other registrations' objects.
        const storeProbes = [];
        for (const [label, hostPath, command] of [
            ['own-alias-file', nodeModulesDir, dir => `echo tampered > ${dir}/left-pad/index.js`],
            ['own-alias-new', nodeModulesDir, dir => `echo tampered > ${dir}/new.js`],
            ['payload-sibling', own.built.payloadPath, dir => `echo tampered > ${dir}/extra.js`],
            ['manifest', objectDir, dir => `echo tampered >> ${dir}/manifest.json`],
            ['index', store.paths.index, dir => `echo tampered > ${dir}/tampered.json`],
            ['other-object-file', otherModules, dir => `echo tampered > ${dir}/dep-other/index.js`],
            ['other-object-new', otherModules, dir => `echo tampered > ${dir}/new.js`],
        ]) {
            const alias = projectAlias(hostPath);
            if (alias) storeProbes.push([`store-${label}`, command(alias)]);
        }
        // global and isolated expose the store through the project bind; devel does not.
        assert.equal(storeProbes.length, projectAlias(store.paths.root) ? 7 : 0);
        const controls = [
            ['control-project', `echo control > ${cwdMountTarget}/control.txt`],
        ];
        const storeBefore = snapshotTree(store.paths.root);
        const { probes, reads, logs } = runDetached(args, [
            'set -u',
            'echo "READ left-pad $(cat /code/node_modules/left-pad/index.js)"',
            'echo "READ agentlib $(cat /code/node_modules/achillesAgentLib/package.json)"',
            ...probeScript([...ownProbes, ...storeProbes, ...controls]),
        ].join('\n'));

        assert.equal(reads.get('left-pad'), 'module.exports = "left-pad:m1";', logs);
        assert.match(reads.get('agentlib') || '', /ploinky-agent-lib/, logs);
        for (const [label] of [...ownProbes, ...storeProbes]) {
            assert.equal(probes.get(label), 'DENIED', `${variant}: ${label} must not modify the cache store\n${logs}`);
        }
        // The attempts are meaningful only if the writable project bind is writable.
        assert.equal(probes.get('control-project'), 'OK', logs);
        assert.equal(fs.readFileSync(path.join(cwd, 'control.txt'), 'utf8'), 'control\n');

        assert.deepEqual(snapshotTree(store.paths.root), storeBefore, `${variant}: host cache store bytes, modes and links unchanged`);
        assertObjectValid(store, own);
        assertObjectValid(store, other);
    });
}
