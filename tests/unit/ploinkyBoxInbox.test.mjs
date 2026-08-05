import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readInboxStatus } from '../../ploinky-box/inbox/readStatus.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-inbox-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function treeHash(root) {
    const hash = crypto.createHash('sha256');
    function walk(directory, relative = '') {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            const next = path.join(relative, name);
            const stat = fs.lstatSync(target);
            hash.update(`${next}\0${stat.mode}\0`);
            if (stat.isDirectory()) walk(target, next);
            else if (stat.isFile()) hash.update(fs.readFileSync(target));
            else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(target));
        }
    }
    walk(root);
    return hash.digest('hex');
}

test('fresh status reports not initialized without changing the tree', (t) => {
    const root = fixture(t);
    const before = treeHash(root);
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query'); } },
    });
    assert.equal(result.state, 'not-initialized');
    assert.equal(result.initialized, false);
    assert.deepEqual(result.runtimes, []);
    assert.deepEqual(result.cloudflarePublication, {
        mode: 'local-only',
        management: null,
        state: 'unstarted',
        connectorState: 'absent',
        configurationGeneration: '',
        desiredDigest: '',
        hostnames: [],
    });
    assert.equal(treeHash(root), before);
});

test('status reads only the redacted Cloudflare publication contract', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    const run = path.join(ploinky, 'run');
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'agents.json'), '{}');
    fs.writeFileSync(path.join(run, 'cloudflare-publication-status.json'), JSON.stringify({
        mode: 'cloudflare',
        management: 'connector-only',
        state: 'ready',
        connectorState: 'running',
        configurationGeneration: `sha256:${'a'.repeat(64)}`,
        desiredDigest: `sha256:${'b'.repeat(64)}`,
        hostnames: ['office.example.test'],
        secret: 'must-not-cross',
        tunnelTokenSecret: 'publication/cloudflare-connector',
    }));
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query'); } },
    });
    assert.deepEqual(result.cloudflarePublication, {
        mode: 'cloudflare',
        management: 'connector-only',
        state: 'ready',
        connectorState: 'running',
        configurationGeneration: `sha256:${'a'.repeat(64)}`,
        desiredDigest: `sha256:${'b'.repeat(64)}`,
        hostnames: ['office.example.test'],
    });
    assert.doesNotMatch(JSON.stringify(result), /must-not-cross|tunnelTokenSecret|publication\/cloudflare/);
});

test('malformed and symlinked Cloudflare status fail to local unstarted with a warning', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    const run = path.join(ploinky, 'run');
    const statusPath = path.join(run, 'cloudflare-publication-status.json');
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'agents.json'), '{}');
    fs.writeFileSync(statusPath, '{truncated');
    let result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query'); } },
    });
    assert.equal(result.cloudflarePublication.state, 'unstarted');
    assert.equal(result.warnings.some((entry) => entry.includes('cloudflare-publication-status')), true);

    fs.unlinkSync(statusPath);
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({
        mode: 'cloudflare',
        management: 'api-managed',
        state: 'ready',
    }));
    fs.symlinkSync(outside, statusPath);
    result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query'); } },
    });
    assert.equal(result.cloudflarePublication.state, 'unstarted');
    assert.equal(result.warnings.some((entry) => entry.includes('cloudflare-publication-status')), true);
});

test('symlinked Cloudflare status parent cannot spoof publication readiness', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    const outside = path.join(root, 'outside-run');
    fs.mkdirSync(ploinky);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(ploinky, 'agents.json'), '{}');
    fs.writeFileSync(path.join(outside, 'cloudflare-publication-status.json'), JSON.stringify({
        mode: 'cloudflare',
        management: 'connector-only',
        state: 'ready',
        connectorState: 'running',
        configurationGeneration: `sha256:${'a'.repeat(64)}`,
        desiredDigest: `sha256:${'b'.repeat(64)}`,
        hostnames: ['spoofed.example.test'],
    }));
    fs.symlinkSync(outside, path.join(ploinky, 'run'));
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query'); } },
    });
    assert.equal(result.cloudflarePublication.state, 'unstarted');
    assert.deepEqual(result.cloudflarePublication.hostnames, []);
    assert.equal(result.warnings.some((entry) => entry.includes('cloudflare-publication-status')), true);
});

test('status exposes allowlisted counts and treats disappearing containers as transient', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    fs.writeFileSync(path.join(ploinky, 'routing.json'), '{"port":8080,"secret":"canary"}\n');
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        alpha: {
            type: 'agent', runtime: 'podman', containerId: 'a'.repeat(64),
            instanceId: 'instance-alpha', enableGeneration: 'generation-alpha',
            projectPath: '/workspace/projects/alpha', secret: 'canary',
        },
        beta: {
            type: 'agent', runtime: 'podman', containerId: 'b'.repeat(64),
            instanceId: 'instance-beta', enableGeneration: 'generation-beta',
            projectPath: '/workspace/projects/beta',
        },
    }));
    const before = treeHash(root);
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: {
            query(command, args) {
                if (args.at(-1) === 'b'.repeat(64)) return { ok: false, stdout: '', stderr: 'gone' };
                return { ok: true, stdout: JSON.stringify([{
                    Id: 'a'.repeat(64), Name: 'alpha', State: { Running: true },
                }]) };
            },
        },
    });
    assert.deepEqual({
        state: result.state,
        trackedAgents: result.trackedAgents,
        runningAgents: result.runningAgents,
    }, { state: 'initialized', trackedAgents: 2, runningAgents: 1 });
    assert.equal(JSON.stringify(result).includes('canary'), false);
    assert.equal(result.warnings.some((value) => value.includes('disappeared')), true);
    assert.deepEqual(result.runtimes, [{
        runtime: 'container',
        role: 'service',
        effectiveInstance: 'alpha',
        generation: 'generation-alpha',
        state: 'running',
        ownerKey: `container:${'a'.repeat(64)}`,
        processIdentity: `container:${'a'.repeat(64)}`,
        workdir: '/workspace/projects/alpha',
        homeKey: 'alpha',
        readiness: 'not-ready',
        logPath: `podman://${'a'.repeat(64)}`,
    }, {
        runtime: 'container',
        role: 'service',
        effectiveInstance: 'beta',
        generation: 'generation-beta',
        state: 'failed',
        ownerKey: `container:${'b'.repeat(64)}`,
        processIdentity: `container:${'b'.repeat(64)}`,
        workdir: '/workspace/projects/beta',
        homeKey: 'beta',
        readiness: 'not-ready',
        logPath: `podman://${'b'.repeat(64)}`,
    }]);
    assert.equal(treeHash(root), before);
});

test('Box status fails closed before inspecting an incomplete selected container identity', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    const containerId = 'd'.repeat(64);
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        coding_alias: {
            type: 'agent',
            runtime: 'podman',
            containerId,
        },
    }));
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('incomplete identity must not be inspected'); } },
    });
    assert.equal(result.runningAgents, 0);
    assert.equal(result.warnings.includes('coding_alias lacks a complete nested-Podman identity'), true);
    assert.deepEqual(result.runtimes, [{
        runtime: 'container',
        role: 'service',
        effectiveInstance: 'coding_alias',
        generation: '',
        state: 'failed',
        ownerKey: `container:${containerId}`,
        processIdentity: `container:${containerId}`,
        workdir: '',
        homeKey: 'coding_alias',
        readiness: 'not-ready',
        logPath: `podman://${containerId}`,
    }]);
});

test('Box container readiness requires the exact active ready generation and keeps its immutable log source', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    const record = {
        type: 'agent',
        runtime: 'podman',
        containerId: 'c'.repeat(64),
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
        alias: 'writer',
        projectPath: '/workspace/projects/current',
    };
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({ coding_alias: record }));
    const runner = {
        query() {
            return { ok: true, stdout: JSON.stringify([{
                Id: record.containerId,
                Name: 'coding_alias',
                State: { Running: true },
            }]) };
        },
    };

    const unpublished = readInboxStatus({
        workspaceRoot: root,
        runner,
        loadActiveGeneration: () => ({
            selector: { state: 'inactive', publicationState: 'ready' },
            generation: { agents: { coding_alias: record } },
        }),
    });
    assert.equal(unpublished.runtimes[0].readiness, 'not-ready');
    assert.equal(unpublished.runtimes[0].logPath, `podman://${record.containerId}`);

    const ready = readInboxStatus({
        workspaceRoot: root,
        runner,
        loadActiveGeneration: () => ({
            selector: { state: 'active', publicationState: 'ready' },
            generation: { agents: { coding_alias: record } },
        }),
    });
    assert.equal(ready.runtimes[0].readiness, 'ready');
    assert.equal(ready.runtimes[0].logPath, `podman://${record.containerId}`);
});

test('Box status labels selected sandbox services and inner provider tasks without Podman misclassification', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    fs.writeFileSync(path.join(ploinky, 'routing.json'), '{}\n');
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        coding_alias: {
            type: 'agent',
            runtime: 'bwrap',
            instanceId: 'instance-phase9',
            enableGeneration: 'generation-phase9',
            homeKey: 'coding_alias.sandbox-v2',
            alias: 'writer',
            agentName: 'codexAgent',
            repoName: 'AchillesCLI',
            projectPath: '/workspace/projects/current',
        },
    }));
    const serviceOwner = {
        schemaVersion: 6,
        role: 'service',
        runtimeKey: 'coding_alias',
        ownerKey: 'service-owner-phase9',
        instanceId: 'instance-phase9',
        enableGeneration: 'generation-phase9',
        homeKey: 'coding_alias.sandbox-v2',
        workdir: '/workspace/projects/current',
        logPath: path.join(ploinky, 'logs', 'codexAgent-bwrap.log'),
        pid: 41,
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:41',
        readiness: 'ready',
    };
    const taskOwner = {
        schemaVersion: 6,
        role: 'provider-task',
        runtime: 'bwrap',
        runtimeKey: 'coding_alias',
        ownerKey: 'provider-task-owner-phase9',
        instanceId: 'instance-phase9',
        enableGeneration: 'generation-phase9',
        homeKey: 'coding_alias.sandbox-v2',
        workdir: '/workspace/projects/current',
        logPath: path.join(ploinky, 'logs', 'agents', 'instance-phase9', 'tasks', 'task-phase9-provider.log'),
        taskId: 'task-phase9',
        provider: 'codex',
        pid: 73,
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:73',
        readiness: 'ready',
        state: 'running',
    };
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('sandbox status must not query Podman'); } },
        collectSandboxOwners: () => [taskOwner],
        collectSandboxServiceOwners: () => [serviceOwner],
        inspectSandboxServiceOwner: (owner) => owner === serviceOwner,
        loadActiveGeneration: () => ({
            selector: { state: 'active', publicationState: 'ready' },
            generation: { agents: {
                coding_alias: {
                    type: 'agent',
                    runtime: 'bwrap',
                    instanceId: 'instance-phase9',
                    enableGeneration: 'generation-phase9',
                },
            } },
        }),
    });

    assert.deepEqual({
        trackedAgents: result.trackedAgents,
        runningAgents: result.runningAgents,
        runtimes: result.runtimes,
    }, {
        trackedAgents: 1,
        runningAgents: 1,
        runtimes: [{
            runtime: 'bwrap',
            role: 'service',
            effectiveInstance: 'writer',
            generation: 'generation-phase9',
            state: 'running',
            ownerKey: 'service-owner-phase9',
            processIdentity: serviceOwner.processIdentity,
            workdir: '/workspace/projects/current',
            homeKey: 'coding_alias.sandbox-v2',
            readiness: 'ready',
            logPath: serviceOwner.logPath,
        }, {
            runtime: 'bwrap',
            role: 'provider-task',
            effectiveInstance: 'writer',
            generation: 'generation-phase9',
            state: 'running',
            ownerKey: 'provider-task-owner-phase9',
            processIdentity: taskOwner.processIdentity,
            workdir: '/workspace/projects/current',
            homeKey: 'coding_alias.sandbox-v2',
            readiness: 'ready',
            logPath: taskOwner.logPath,
            taskId: 'task-phase9',
            provider: 'codex',
        }],
    });
    assert.equal(result.warnings.some((value) => value.includes('nested-Podman')), false);
    assert.doesNotMatch(JSON.stringify(result), /container|podman/i);
});

test('Box status fails closed on corrupt or mixed-generation sandbox ownership', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        coding_alias: {
            type: 'agent',
            runtime: 'seatbelt',
            instanceId: 'instance-current',
            enableGeneration: 'generation-current',
            homeKey: 'coding_alias.sandbox-v2',
        },
    }));
    const staleOwner = {
        role: 'provider-task',
        runtimeKey: 'coding_alias',
        ownerKey: 'stale-canary',
        instanceId: 'instance-current',
        enableGeneration: 'generation-retired',
        homeKey: 'coding_alias.sandbox-v2',
        workdir: '/workspace/operation',
        logPath: path.join(ploinky, 'logs', 'agents', 'instance-current', 'tasks', 'stale-provider.log'),
        taskId: 'stale-task',
        provider: 'codex',
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:99',
    };
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query Podman'); } },
        collectSandboxOwners: () => [staleOwner],
        readSandboxServiceOwner: () => null,
        inspectSandboxServiceOwner: () => { throw new Error('must not inspect stale task'); },
    });
    assert.equal(result.runningAgents, 0);
    assert.deepEqual(result.runtimes, [{
        runtime: 'seatbelt',
        role: 'service',
        effectiveInstance: 'coding_alias',
        generation: 'generation-current',
        state: 'stopped',
        ownerKey: '',
        processIdentity: '',
        workdir: '',
        homeKey: 'coding_alias.sandbox-v2',
        readiness: 'not-ready',
        logPath: '',
    }]);
    assert.equal(result.warnings.some((value) => value.includes('exact sandbox service owner')), true);
    assert.doesNotMatch(JSON.stringify(result), /stale-canary|stale-task|generation-retired/);

    const corrupt = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query Podman'); } },
        collectSandboxOwners: () => { throw new Error('owner-secret-canary'); },
        readSandboxServiceOwner: () => null,
    });
    assert.equal(corrupt.runningAgents, 0);
    assert.equal(corrupt.runtimes[0].state, 'stopped');
    assert.equal(corrupt.warnings.includes('sandbox ownership state is unreadable'), true);
    assert.doesNotMatch(JSON.stringify(corrupt), /owner-secret-canary/);
});

test('Box status retains exact failed sandbox owners as actionable survivor evidence', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        coding_alias: {
            type: 'agent',
            runtime: 'bwrap',
            instanceId: 'instance-current',
            enableGeneration: 'generation-current',
            homeKey: 'coding_alias.sandbox-v2',
            alias: 'writer',
        },
    }));
    const serviceOwner = {
        role: 'service',
        runtimeKey: 'coding_alias',
        ownerKey: 'service-owner-current',
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
        homeKey: 'coding_alias.sandbox-v2',
        workdir: '/code',
        logPath: path.join(ploinky, 'logs', 'coding-bwrap.log'),
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:41',
        readiness: 'ready',
    };
    const taskOwner = {
        role: 'provider-task',
        runtime: 'bwrap',
        runtimeKey: 'coding_alias',
        ownerKey: 'task-owner-current',
        instanceId: 'instance-current',
        enableGeneration: 'generation-current',
        homeKey: 'coding_alias.sandbox-v2',
        workdir: '/workspace/project',
        logPath: path.join(ploinky, 'logs', 'agents', 'instance-current', 'tasks', 'task-current-provider.log'),
        taskId: 'task-current',
        provider: 'codex',
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:42',
        readiness: 'ready',
        state: 'running',
    };
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: { query() { throw new Error('must not query Podman'); } },
        collectSandboxOwners: () => [taskOwner],
        readSandboxServiceOwner: () => serviceOwner,
        inspectSandboxServiceOwner: () => false,
    });
    assert.deepEqual(result.runtimes.map(({ role, state, readiness, ownerKey }) => ({
        role, state, readiness, ownerKey,
    })), [{
        role: 'service',
        state: 'failed',
        readiness: 'not-ready',
        ownerKey: 'service-owner-current',
    }, {
        role: 'provider-task',
        state: 'failed',
        readiness: 'not-ready',
        ownerKey: 'task-owner-current',
    }]);
});

test('Box status includes exact provider tasks owned by a selected coding container', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    const containerId = 'c'.repeat(64);
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        coding_container: {
            type: 'agent',
            runtime: 'podman',
            containerId,
            instanceId: 'container-instance',
            enableGeneration: 'container-generation',
            homeKey: 'coding_container',
            alias: 'container-writer',
            projectPath: '/workspace/projects/current',
        },
    }));
    const taskOwner = {
        schemaVersion: 6,
        role: 'provider-task',
        runtimeKind: 'container',
        runtimeKey: 'coding_container',
        ownerKey: 'container-task-owner',
        instanceId: 'container-instance',
        enableGeneration: 'container-generation',
        homeKey: 'coding_container',
        workdir: '/workspace/projects/current',
        logPath: path.join(ploinky, 'logs', 'agents', 'container-instance', 'tasks', 'container-task-provider.log'),
        taskId: 'container-task',
        provider: 'opencode',
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:107',
        readiness: 'ready',
        state: 'running',
    };
    const result = readInboxStatus({
        workspaceRoot: root,
        runner: {
            query() {
                return { ok: true, stdout: JSON.stringify([{
                    Id: containerId,
                    Name: 'coding_container',
                    State: { Running: true },
                }]) };
            },
        },
        collectSandboxOwners: () => [taskOwner],
        loadActiveGeneration: () => ({
            selector: { state: 'active', publicationState: 'ready' },
            generation: { agents: {
                coding_container: {
                    type: 'agent',
                    runtime: 'podman',
                    instanceId: 'container-instance',
                    enableGeneration: 'container-generation',
                },
            } },
        }),
    });
    assert.equal(result.runningAgents, 1);
    assert.equal(result.runtimes.length, 2);
    assert.equal(result.runtimes[0].homeKey, 'coding_container');
    assert.deepEqual(result.runtimes[1], {
        runtime: 'container',
        role: 'provider-task',
        effectiveInstance: 'container-writer',
        generation: 'container-generation',
        state: 'running',
        ownerKey: 'container-task-owner',
        processIdentity: taskOwner.processIdentity,
        workdir: '/workspace/projects/current',
        homeKey: 'coding_container',
        readiness: 'ready',
        logPath: taskOwner.logPath,
        taskId: 'container-task',
        provider: 'opencode',
    });
});
