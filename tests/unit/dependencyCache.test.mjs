import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
    STAMP_VERSION,
    STAMP_FILENAME,
    CORE_MARKER_MODULE,
    NPM_INSTALL_ARGS,
    buildContainerInstallScript,
    buildContainerInstallRunArgs,
    sha256,
    hashFile,
    hashMergedPackage,
    hashObject,
    stampPath,
    readStamp,
    writeStamp,
    isGlobalCacheValid,
    isAgentCacheValid,
    getGlobalCachePath,
    getAgentCachePath,
    acquireLock,
    ensureCacheDir,
    ensureAgentCacheForFamily,
    nodeModulesDir,
} from '../../cli/utils/dependencies/dependencyCache.js';

function tempDir(prefix = 'deps-cache-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedCoreMarker(cachePath) {
    ensureCacheDir(cachePath);
    const markerDir = path.join(nodeModulesDir(cachePath), CORE_MARKER_MODULE);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'package.json'), '{"name":"mcp-sdk"}');
}

test('sha256 produces deterministic digest', () => {
    assert.equal(sha256('hello'), sha256('hello'));
    assert.notEqual(sha256('hello'), sha256('world'));
});

test('hashFile returns null for missing file', () => {
    assert.equal(hashFile('/nonexistent-' + Date.now()), null);
});

test('hashObject is stable under key order', () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    assert.equal(hashObject(a), hashObject(b));
});

test('hashMergedPackage is stable across dep-ordering', () => {
    const a = { name: 'x', dependencies: { b: '1', a: '2' }, devDependencies: { d: '3' } };
    const b = { name: 'x', dependencies: { a: '2', b: '1' }, devDependencies: { d: '3' } };
    assert.equal(hashMergedPackage(a), hashMergedPackage(b));
});

test('hashMergedPackage changes when deps change', () => {
    const a = { name: 'x', dependencies: { a: '1' } };
    const b = { name: 'x', dependencies: { a: '2' } };
    assert.notEqual(hashMergedPackage(a), hashMergedPackage(b));
});

test('container dependency installer disables audit/fund and emits a heartbeat', () => {
    const script = buildContainerInstallScript({ installDir: '/install', heartbeatSeconds: 7 });
    assert.match(script, /DEBIAN_FRONTEND/);
    assert.match(script, /npm install/);
    assert.match(script, /--no-audit/);
    assert.match(script, /--no-fund/);
    assert.match(script, /still running/);
    assert.match(script, /sleep 7/);
    assert.deepEqual(NPM_INSTALL_ARGS, ['install', '--no-package-lock', '--no-audit', '--no-fund']);
});

test('container dependency install runs as root for non-root runtime images', () => {
    const imageId = 'a'.repeat(64);
    const args = buildContainerInstallRunArgs({
        cwd: '/tmp/cache',
        image: imageId,
        runtime: 'podman',
        shellPath: '/bin/sh',
        installScript: 'echo ok',
        probeOwnership: {
            owner: 'test/dependency-cache',
            releaseGeneration: 'b'.repeat(64),
        },
    });

    const userIndex = args.indexOf('--user');
    const volumeIndex = args.indexOf('-v');
    assert.notEqual(userIndex, -1);
    assert.equal(args[userIndex + 1], '0:0');
    assert.ok(userIndex < volumeIndex, 'user override should apply to the container run');
    assert.deepEqual(args.slice(-3), [imageId, '-lc', 'echo ok']);
    assert.equal(args.includes('--network'), false, 'installer must use the managed Podman network default');
    assert.equal(args.some((arg) => String(arg).includes('slirp4netns')), false);
});

test('writeStamp + readStamp round-trip', () => {
    const dir = tempDir();
    try {
        const stamp = writeStamp(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'abc' });
        assert.equal(stamp.version, STAMP_VERSION);
        assert.ok(stamp.preparedAt, 'preparedAt present');
        const read = readStamp(dir);
        assert.deepEqual(read, stamp);
        assert.equal(path.basename(stampPath(dir)), STAMP_FILENAME);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('readStamp returns null for missing stamp', () => {
    const dir = tempDir();
    try {
        assert.equal(readStamp(dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isGlobalCacheValid: valid when stamp + marker + hash match', () => {
    const dir = tempDir();
    try {
        seedCoreMarker(dir);
        writeStamp(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'h1' });
        const check = isGlobalCacheValid(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'h1' });
        assert.equal(check.valid, true, check.reason);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isGlobalCacheValid: stale when globalPackageHash changes', () => {
    const dir = tempDir();
    try {
        seedCoreMarker(dir);
        writeStamp(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'h1' });
        const check = isGlobalCacheValid(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'h2' });
        assert.equal(check.valid, false);
        assert.match(check.reason, /globalPackageHash/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isGlobalCacheValid: stale when installer image changes', () => {
    const dir = tempDir();
    try {
        seedCoreMarker(dir);
        writeStamp(dir, {
            runtimeKey: 'container-linux-arm64-glibc-node24',
            globalPackageHash: 'h1',
            installer: {
                runtimeFamily: 'container',
                nodeMajor: 24,
                platform: 'linux',
                arch: 'arm64',
                variant: 'glibc',
                installerRuntime: 'podman',
                image: 'node:24.15.0-bullseye',
            },
        });
        const check = isGlobalCacheValid(dir, {
            runtimeKey: 'container-linux-arm64-glibc-node24',
            globalPackageHash: 'h1',
            installer: {
                runtimeFamily: 'container',
                nodeMajor: 24,
                platform: 'linux',
                arch: 'arm64',
                variant: 'glibc',
                installerRuntime: 'podman',
                image: 'docker.io/assistos/ploinky-node:24-bookworm-tools',
            },
        });
        assert.equal(check.valid, false);
        assert.match(check.reason, /installer image changed/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isGlobalCacheValid: stale when runtimeKey changes', () => {
    const dir = tempDir();
    try {
        seedCoreMarker(dir);
        writeStamp(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'h1' });
        const check = isGlobalCacheValid(dir, { runtimeKey: 'bwrap-linux-x64-node22', globalPackageHash: 'h1' });
        assert.equal(check.valid, false);
        assert.match(check.reason, /runtime key mismatch/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isGlobalCacheValid: stale when core marker missing', () => {
    const dir = tempDir();
    try {
        ensureCacheDir(dir);
        writeStamp(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'h1' });
        const check = isGlobalCacheValid(dir, { runtimeKey: 'bwrap-linux-x64-node20', globalPackageHash: 'h1' });
        assert.equal(check.valid, false);
        assert.match(check.reason, /core marker/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isAgentCacheValid: valid when mergedPackageHash matches', () => {
    const dir = tempDir();
    try {
        seedCoreMarker(dir);
        writeStamp(dir, {
            runtimeKey: 'bwrap-linux-x64-node20',
            mergedPackageHash: 'm1',
        });
        const check = isAgentCacheValid(dir, { runtimeKey: 'bwrap-linux-x64-node20', mergedPackageHash: 'm1' });
        assert.equal(check.valid, true, check.reason);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isAgentCacheValid: stale when mergedPackageHash changes', () => {
    const dir = tempDir();
    try {
        seedCoreMarker(dir);
        writeStamp(dir, { runtimeKey: 'bwrap-linux-x64-node20', mergedPackageHash: 'm1' });
        const check = isAgentCacheValid(dir, { runtimeKey: 'bwrap-linux-x64-node20', mergedPackageHash: 'm2' });
        assert.equal(check.valid, false);
        assert.match(check.reason, /mergedPackageHash/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('isAgentCacheValid: stale when installer metadata is missing', () => {
    const dir = tempDir();
    try {
        seedCoreMarker(dir);
        writeStamp(dir, {
            runtimeKey: 'container-linux-x64-glibc-node24',
            mergedPackageHash: 'm1',
        });
        const check = isAgentCacheValid(dir, {
            runtimeKey: 'container-linux-x64-glibc-node24',
            mergedPackageHash: 'm1',
            installer: {
                runtimeFamily: 'container',
                nodeMajor: 24,
                platform: 'linux',
                arch: 'x64',
                variant: 'glibc',
                installerRuntime: 'docker',
                image: 'docker.io/assistos/ploinky-node:24-bookworm-tools',
            },
        });
        assert.equal(check.valid, false);
        assert.match(check.reason, /installer metadata missing/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('getGlobalCachePath rejects bad runtime key', () => {
    assert.throws(() => getGlobalCachePath('not-a-key'), /Invalid runtime key/);
});

test('getAgentCachePath requires repo+agent', () => {
    assert.throws(
        () => getAgentCachePath('', 'agent', 'bwrap-linux-x64-node20'),
        /repoName and agentName/,
    );
    assert.throws(
        () => getAgentCachePath('repo', '', 'bwrap-linux-x64-node20'),
        /repoName and agentName/,
    );
});

test('cache paths follow .ploinky/deps layout', () => {
    const rk = 'bwrap-linux-x64-node20';
    const globalPath = getGlobalCachePath(rk);
    assert.ok(globalPath.includes(path.join('.ploinky', 'deps', 'global', rk)));
    const agentPath = getAgentCachePath('repoX', 'agentY', rk);
    assert.ok(agentPath.includes(path.join('.ploinky', 'deps', 'agents', 'repoX', 'agentY', rk)));
});

test('acquireLock reclaims a legacy lock owned by a dead process', () => {
    const dir = tempDir();
    const lockFile = path.join(dir, '.lock');
    try {
        fs.writeFileSync(lockFile, JSON.stringify({
            pid: 2_147_483_647,
            at: '2020-01-01T00:00:00.000Z',
        }));
        const lock = acquireLock(dir, { timeoutMs: 20, pollMs: 1 });
        const owner = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
        assert.equal(owner.pid, process.pid);
        assert.ok(owner.ownerId);
        lock.release();
        assert.equal(fs.existsSync(lockFile), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('acquireLock waits without a busy loop while a live owner holds the lock', () => {
    const dir = tempDir();
    try {
        const held = acquireLock(dir);
        let clock = 0;
        const sleeps = [];
        assert.throws(
            () => acquireLock(dir, {
                timeoutMs: 10,
                pollMs: 4,
                now: () => clock,
                sleep(milliseconds) {
                    sleeps.push(milliseconds);
                    clock += milliseconds;
                },
            }),
            /Timed out waiting for cache lock/,
        );
        assert.deepEqual(sleeps, [4, 4, 4]);
        held.release();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('release does not remove a lock record owned by a successor', () => {
    const dir = tempDir();
    const lockFile = path.join(dir, '.lock');
    try {
        const lock = acquireLock(dir);
        const successor = {
            ...JSON.parse(fs.readFileSync(lockFile, 'utf8')),
            ownerId: crypto.randomUUID(),
        };
        fs.writeFileSync(lockFile, JSON.stringify(successor));
        lock.release();
        assert.equal(fs.existsSync(lockFile), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ensureAgentCacheForFamily prepares cache and returns node_modules path', () => {
    const cachePath = tempDir();
    const agentCodePath = tempDir();
    try {
        let call;
        const nm = ensureAgentCacheForFamily({
            family: 'seatbelt',
            repoName: 'repoX',
            agentName: 'agentY',
            agentCodePath,
            prepare(args) {
                call = args;
                return { cachePath };
            },
        });

        assert.equal(nm, nodeModulesDir(cachePath));
        assert.equal(call.repoName, 'repoX');
        assert.equal(call.agentName, 'agentY');
        assert.match(call.runtimeKey, /^seatbelt-/);
        assert.equal(call.agentPackagePath, path.join(agentCodePath, 'package.json'));
    } finally {
        fs.rmSync(cachePath, { recursive: true, force: true });
        fs.rmSync(agentCodePath, { recursive: true, force: true });
    }
});
