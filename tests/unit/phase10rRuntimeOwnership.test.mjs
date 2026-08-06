import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const ownershipModuleUrl = pathToFileURL(
    path.join(repoRoot, 'cli/sandbox/docker/runtimeOwnership.js'),
).href;
const serviceManagerPath = path.join(repoRoot, 'cli/sandbox/docker/agentServiceManager.js');

test('Podman physical ownership journal is complete, atomic, CAS guarded, and exact-ID removable', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-owner-'));
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        const ownership = await import(${JSON.stringify(ownershipModuleUrl)} + '?fixture=' + Date.now());
        const idA = 'a'.repeat(64);
        const idB = 'b'.repeat(64);
        const base = {
            containerName: 'ploinky-demo-alpha',
            containerId: idA,
            runtime: 'podman',
            agentName: 'alpha',
            repoName: 'demo',
            alias: 'alpha-blue',
            instanceId: 'instance-alpha',
            enableGeneration: 'enable-alpha',
            releaseGeneration: 'c'.repeat(64),
            projectPath: '/workspace/project',
            profile: 'default',
            imageId: 'd'.repeat(64),
            manifestSha256: 'sha256:' + 'e'.repeat(64),
            contractHash: 'sha256:' + 'f'.repeat(64),
            networkContractHash: 'sha256:' + '1'.repeat(64),
        };

        const first = ownership.publishPodmanRuntimeOwnership(base, { expectedContainerId: '' });
        assert.equal(first.containerName, base.containerName);
        assert.equal(first.containerId, idA);
        assert.equal(first.ownerRef, 'demo/alpha');
        assert.equal(first.role, 'podman-runtime');
        assert.equal(first.schemaVersion, 1);
        assert.deepEqual(ownership.readPodmanRuntimeOwnership(base.containerName), first);
        const selected = {
            type: 'agent',
            runtime: 'podman',
            repoName: base.repoName,
            agentName: base.agentName,
            alias: base.alias,
            instanceId: base.instanceId,
            enableGeneration: base.enableGeneration,
            releaseGeneration: base.releaseGeneration,
            projectPath: base.projectPath,
            profile: base.profile,
        };
        assert.equal(
            ownership.resolvePodmanRuntimeOwnership(base.containerName, selected).containerId,
            idA,
        );
        assert.throws(
            () => ownership.resolvePodmanRuntimeOwnership(
                base.containerName,
                { ...selected, repoName: 'foreign' },
            ),
            { code: 'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT' },
        );
        assert.throws(
            () => ownership.resolvePodmanRuntimeOwnership(
                base.containerName,
                { ...selected, containerId: idB },
            ),
            { code: 'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT' },
        );
        assert.equal(fs.statSync(ownership.podmanRuntimeOwnershipFile(base.containerName)).mode & 0o777, 0o600);
        assert.deepEqual(
            fs.readdirSync(ownership.PODMAN_RUNTIME_OWNERSHIP_DIR).filter((name) => name.endsWith('.tmp') || name.endsWith('.claim')),
            [],
        );

        assert.deepEqual(
            ownership.publishPodmanRuntimeOwnership(base, { expectedContainerId: idA }),
            first,
        );
        assert.throws(
            () => ownership.publishPodmanRuntimeOwnership(
                { ...base, repoName: 'foreign' },
                { expectedContainerId: idA },
            ),
            { code: 'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT' },
        );
        assert.deepEqual(ownership.readPodmanRuntimeOwnership(base.containerName), first);
        const second = ownership.publishPodmanRuntimeOwnership(
            { ...base, containerId: idB },
            { expectedContainerId: idA },
        );
        assert.equal(second.containerId, idB);
        assert.throws(
            () => ownership.publishPodmanRuntimeOwnership(
                { ...base, containerId: '2'.repeat(64) },
                { expectedContainerId: idA },
            ),
            { code: 'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT' },
        );
        assert.equal(ownership.readPodmanRuntimeOwnership(base.containerName).containerId, idB);

        assert.equal(ownership.removePodmanRuntimeOwnership(base.containerName, idA), false);
        assert.equal(ownership.readPodmanRuntimeOwnership(base.containerName).containerId, idB);
        assert.equal(ownership.removePodmanRuntimeOwnership(base.containerName, idB), true);
        assert.equal(ownership.readPodmanRuntimeOwnership(base.containerName), null);
        const republished = ownership.publishPodmanRuntimeOwnership(
            { ...base, containerId: idA },
            { expectedContainerId: idB },
        );
        assert.equal(republished.containerId, idA);
        assert.equal(ownership.removePodmanRuntimeOwnership(base.containerName, idA), true);

        assert.throws(
            () => ownership.publishPodmanRuntimeOwnership({ ...base, containerId: 'A'.repeat(64) }),
            { code: 'PLOINKY_RUNTIME_OWNERSHIP_INVALID' },
        );
        assert.throws(
            () => ownership.publishPodmanRuntimeOwnership({ ...base, manifestSha256: '' }),
            { code: 'PLOINKY_RUNTIME_OWNERSHIP_INVALID' },
        );
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: workspace,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_CWD: workspace,
        },
        encoding: 'utf8',
    });
    try {
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('agent launch publishes physical ownership before registry visibility or readiness', () => {
    const source = fs.readFileSync(serviceManagerPath, 'utf8');
    const launchStart = source.indexOf('function startAgentContainer(');
    const launchEnd = source.indexOf('\nfunction resolveHostPort(', launchStart);
    const launch = source.slice(launchStart, launchEnd);
    const immutableIdCheck = launch.indexOf('if (!IMMUTABLE_CONTAINER_ID.test(launchedContainerId))');
    const publication = launch.indexOf('publishPodmanRuntimeOwnership({');
    const registryBuild = launch.indexOf('const agents = loadAgentsMap();', publication);
    const readinessHook = launch.indexOf('runProfileLifecycle(', publication);

    assert.match(source, /from '\.\/runtimeOwnership\.js'/);
    assert.ok(immutableIdCheck >= 0, 'launch must validate the acquired immutable ID');
    assert.ok(publication > immutableIdCheck, 'ownership must publish after immutable ID validation');
    assert.ok(registryBuild > publication, 'ownership must publish before registry construction/visibility');
    assert.ok(readinessHook > publication, 'ownership must publish before readiness lifecycle hooks');
    assert.match(
        launch.slice(publication, registryBuild),
        /alias: instanceName/,
        'physical ownership must preserve the selected alias identity exactly',
    );
    assert.match(
        launch.slice(publication, registryBuild),
        /catch \(error\) \{\s*cleanupExactLaunch\(error\);\s*\}/,
        'publication failure must route through exact candidate cleanup',
    );
    assert.match(
        launch,
        /if \(options\.preserveRegistryRecord !== true\) saveAgentsMap\(agents\);/,
        'the ownership journal must not mutate prepared edge-generation registry semantics',
    );
});
