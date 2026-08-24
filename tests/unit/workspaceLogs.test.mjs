import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    getWorkspaceLog,
    listWorkspaceLogs,
    maintainWorkspaceLogs,
    pruneWorkspaceLogs,
    searchWorkspaceLogs,
} from '../../cli/server/workspaceLogFiles.js';

async function fixture(t) {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-workspace-logs-'));
    t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
    await fs.mkdir(path.join(workspaceRoot, '.ploinky', 'logs'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, '.ploinky', 'data', 'router-security'), { recursive: true });
    return workspaceRoot;
}

test('maintenance atomically rotates active Router and Policy files into UTC archives', async (t) => {
    const workspaceRoot = await fixture(t);
    await fs.writeFile(path.join(workspaceRoot, '.ploinky', 'logs', 'router.log'),
        '{"ts":"2026-08-12T23:59:00.000Z","type":"router-before-midnight"}\n');
    await fs.writeFile(path.join(workspaceRoot, '.ploinky', 'data', 'router-security', 'policy-audit.log'),
        '{"ts":"2026-08-12T22:00:00.000Z","event":"policy-before-midnight"}\n');

    const result = await maintainWorkspaceLogs({
        retentionDays: 7,
        now: new Date('2026-08-13T00:01:00.000Z'),
        workspaceRoot,
    });
    assert.equal(result.results.every((entry) => entry.rotated), true);
    assert.equal((await listWorkspaceLogs('router', { workspaceRoot })).items[0].name, '2026-08-12.jsonl');
    assert.equal((await listWorkspaceLogs('policy', { workspaceRoot })).items[0].name, '2026-08-12.jsonl');
    assert.equal((await getWorkspaceLog('router', { name: '2026-08-12.jsonl', workspaceRoot })).item.content.includes('router-before-midnight'), true);
    await assert.rejects(fs.stat(path.join(workspaceRoot, '.ploinky', 'logs', 'router.log')), /ENOENT/);
});

test('maintenance is idempotent during the current UTC day', async (t) => {
    const workspaceRoot = await fixture(t);
    const active = path.join(workspaceRoot, '.ploinky', 'logs', 'router.log');
    await fs.writeFile(active, '{"ts":"2026-08-13T10:00:00.000Z","type":"today"}\n');
    const result = await maintainWorkspaceLogs({ retentionDays: 7, now: new Date('2026-08-13T11:00:00.000Z'), workspaceRoot });
    assert.equal(result.results.find((entry) => entry.source === 'router').rotated, false);
    assert.equal((await fs.readFile(active, 'utf8')).includes('today'), true);
});

test('retention removes expired quiet archives without requiring new writes', async (t) => {
    const workspaceRoot = await fixture(t);
    const archive = path.join(workspaceRoot, '.ploinky', 'logs', 'router-archive');
    await fs.mkdir(archive, { recursive: true });
    const expired = path.join(archive, '2026-07-01.jsonl');
    const recent = path.join(archive, '2026-08-10.jsonl');
    await fs.writeFile(expired, 'old\n');
    await fs.writeFile(recent, 'recent\n');
    await fs.utimes(expired, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
    await fs.utimes(recent, new Date('2026-08-10T00:00:00Z'), new Date('2026-08-10T00:00:00Z'));
    const result = await pruneWorkspaceLogs('router', 7, { now: new Date('2026-08-13T00:00:00Z'), workspaceRoot });
    assert.deepEqual(result.removed, ['2026-07-01.jsonl']);
    assert.equal((await listWorkspaceLogs('router', { workspaceRoot })).items[0].name, '2026-08-10.jsonl');
});

test('retention preserves a mixed archive while it still contains recent records', async (t) => {
    const workspaceRoot = await fixture(t);
    const active = path.join(workspaceRoot, '.ploinky', 'logs', 'router.log');
    await fs.writeFile(active, [
        '{"ts":"2026-07-01T00:00:00.000Z","type":"old"}',
        '{"ts":"2026-08-13T10:00:00.000Z","type":"recent"}',
        '',
    ].join('\n'));
    await maintainWorkspaceLogs({
        retentionDays: 7,
        now: new Date('2026-08-13T11:00:00.000Z'),
        workspaceRoot,
    });
    const listing = await listWorkspaceLogs('router', { workspaceRoot });
    assert.equal(listing.items.length, 1);
    const retained = await getWorkspaceLog('router', { name: listing.items[0].name, workspaceRoot });
    assert.match(retained.item.content, /"type":"recent"/);
});

test('live reads and retained search remain bounded and reject unsafe names', async (t) => {
    const workspaceRoot = await fixture(t);
    await fs.writeFile(path.join(workspaceRoot, '.ploinky', 'logs', 'router.log'),
        '{"ts":"2026-08-13T10:00:00.000Z","type":"Needle"}\n');
    const live = await getWorkspaceLog('router', { name: 'live', maxBytes: 1024, workspaceRoot });
    assert.match(live.item.content, /Needle/);
    assert.equal(live.item.truncated, false);
    const search = await searchWorkspaceLogs('router', { query: 'needle', limit: 1, workspaceRoot });
    assert.equal(search.matches.length, 1);
    await assert.rejects(getWorkspaceLog('router', { name: '../router.log', workspaceRoot }), /invalid/);
    await assert.rejects(maintainWorkspaceLogs({ retentionDays: 0, workspaceRoot }), /between 1 and 365/);
});

test('bounded reads return only complete tail lines while search keeps exact full-file line numbers', async (t) => {
    const workspaceRoot = await fixture(t);
    const active = path.join(workspaceRoot, '.ploinky', 'logs', 'router.log');
    await fs.writeFile(active, 'old first line\nold second line\nNeedle newest\n');
    const live = await getWorkspaceLog('router', { name: 'live', maxBytes: 18, workspaceRoot });
    assert.equal(live.item.truncated, true);
    assert.equal(live.item.content, 'Needle newest\n');
    const search = await searchWorkspaceLogs('router', { query: 'old first', limit: 10, workspaceRoot });
    assert.deepEqual(search.matches.map(({ lineNumber, line }) => ({ lineNumber, line })), [
        { lineNumber: 1, line: 'old first line' },
    ]);
});

test('search stops at the bounded byte budget', async (t) => {
    const workspaceRoot = await fixture(t);
    const active = path.join(workspaceRoot, '.ploinky', 'logs', 'router.log');
    await fs.writeFile(active, 'first line\nsecond needle\nthird needle\n');
    const search = await searchWorkspaceLogs('router', {
        query: 'needle',
        limit: 10,
        maxBytes: 25,
        workspaceRoot,
    });
    assert.equal(search.truncated, true);
    assert.equal(search.scannedBytes <= 25, true);
    assert.deepEqual(search.matches.map(({ line }) => line), ['second needle']);
});

test('live reads refuse a symlink swapped into the Ploinky log path', async (t) => {
    const workspaceRoot = await fixture(t);
    const active = path.join(workspaceRoot, '.ploinky', 'logs', 'router.log');
    await fs.symlink('/etc/passwd', active);
    const live = await getWorkspaceLog('router', { name: 'live', workspaceRoot });
    assert.equal(live.item.content, '');
});
