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
