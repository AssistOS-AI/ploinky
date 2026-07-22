import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readInboxStatus } from '../../ploinky-box/inbox/readStatus.mjs';
import { stopCoreWithoutBootstrap } from '../../ploinky-box/inbox/stopCore.mjs';

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
    assert.equal(treeHash(root), before);
});

test('status exposes allowlisted counts and treats disappearing containers as transient', (t) => {
    const root = fixture(t);
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(ploinky);
    fs.writeFileSync(path.join(ploinky, 'routing.json'), '{"port":8080,"secret":"canary"}\n');
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        alpha: { type: 'agent', runtime: 'podman', containerId: 'a'.repeat(64), secret: 'canary' },
        beta: { type: 'agent', runtime: 'podman', containerId: 'b'.repeat(64) },
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
    assert.equal(treeHash(root), before);
});

test('stop validates same-uid Watchdog and nested immutable IDs before signaling', (t) => {
    const root = fixture(t);
    const procRoot = path.join(root, 'proc');
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(path.join(ploinky, 'running'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'routing.json'), '{"port":8080}\n');
    fs.writeFileSync(path.join(ploinky, 'running', 'router.pid'), '123\n');
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        alpha: { type: 'agent', runtime: 'podman', containerId: 'a'.repeat(64) },
        legacy: { type: 'agent', runtime: 'podman' },
    }));
    fs.mkdirSync(path.join(procRoot, '123'), { recursive: true });
    fs.writeFileSync(path.join(procRoot, '123', 'status'), 'Name:\tnode\nUid:\t501\t501\t501\t501\n');
    fs.writeFileSync(path.join(procRoot, '123', 'cmdline'), `node\0/opt/ploinky/cli/server/Watchdog.js\0`);
    const events = [];
    const result = stopCoreWithoutBootstrap({
        workspaceRoot: root,
        procRoot,
        uid: 501,
        kill(pid, signal) { events.push(['kill', pid, signal]); },
        runner: {
            query(command, args) {
                events.push(['query', command, ...args]);
                return { ok: true, stdout: JSON.stringify([{
                    Id: 'a'.repeat(64), Name: 'alpha',
                }]) };
            },
            run(command, args) { events.push(['run', command, ...args]); },
        },
    });
    assert.equal(result.watchdogStopped, true);
    assert.deepEqual(events[0], ['kill', 123, 'SIGTERM']);
    assert.equal(events.some((event) => event.join(' ').includes(`container stop --time 10 ${'a'.repeat(64)}`)), true);
    assert.equal(result.warnings.some((warning) => warning.includes('legacy')), true);
});

test('changed PIDs and nested names are reported without targeting them', (t) => {
    const root = fixture(t);
    const procRoot = path.join(root, 'proc');
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(path.join(ploinky, 'running'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'routing.json'), '{}');
    fs.writeFileSync(path.join(ploinky, 'running', 'router.pid'), '123');
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        alpha: { type: 'agent', runtime: 'podman', containerId: 'a'.repeat(64) },
    }));
    fs.mkdirSync(path.join(procRoot, '123'), { recursive: true });
    fs.writeFileSync(path.join(procRoot, '123', 'status'), 'Uid:\t999\t999\t999\t999\n');
    fs.writeFileSync(path.join(procRoot, '123', 'cmdline'), 'node\0/foreign.js\0');
    const events = [];
    const result = stopCoreWithoutBootstrap({
        workspaceRoot: root, procRoot, uid: 501,
        kill() { events.push(['kill']); },
        runner: {
            query() { return { ok: true, stdout: JSON.stringify([{ Id: 'a'.repeat(64), Name: 'changed' }]) }; },
            run() { events.push(['stop']); },
        },
    });
    assert.deepEqual(events, []);
    assert.equal(result.warnings.length, 2);
});
