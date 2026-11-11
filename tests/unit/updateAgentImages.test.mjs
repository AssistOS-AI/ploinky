import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    classifyImageReference,
    collectTaggedAgentImages,
    isTagReference,
    refreshAgentImagesForUpdate,
    refreshTaggedImages,
} from '../../cli/commands/updateImages.js';
import { normalizeImageId, runtimeImageReuseProblem } from '../../cli/sandbox/docker/runtimeImageIdentity.js';
import { decideUpdateStatus } from '../../cli/commands/updateOutcome.js';
import { formatUpdateSummary } from '../../cli/commands/updateSummary.js';
import { appendUpdateRecords, buildCoreUpdateResult } from '../../cli/commands/updateRecords.js';

// `ploinky update` refreshes tag-referenced agent images once each, keeps the
// local image when a pull fails, and the reuse decision replaces a container
// whose image is no longer the one its reference names.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID_A = `sha256:${'a'.repeat(64)}`;
const ID_B = `sha256:${'b'.repeat(64)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;

test('tag and digest references are classified, including registry ports and implicit latest', () => {
    const cases = [
        ['docker.io/assistos/roboteam-agent:runtime', 'tag', 'docker.io/assistos/roboteam-agent:runtime'],
        ['foo:latest', 'tag', 'foo:latest'],
        ['foo', 'tag', 'foo:latest'],
        ['localhost:5000/x:tag', 'tag', 'localhost:5000/x:tag'],
        ['localhost:5000/x', 'tag', 'localhost:5000/x:latest'],
        ['registry.example:8443/team/app', 'tag', 'registry.example:8443/team/app:latest'],
        [`foo@${DIGEST}`, 'digest'],
        [`localhost:5000/x:tag@${DIGEST}`, 'digest'],
        [`docker.io/library/node:20@${DIGEST}`, 'digest'],
        ['a'.repeat(64), 'id'],
        [ID_A, 'id'],
        ['', 'invalid'],
        ['${AGENT_IMAGE}', 'invalid'],
        ['foo bar', 'invalid'],
    ];
    for (const [reference, kind, key] of cases) {
        const classified = classifyImageReference(reference);
        assert.equal(classified.kind, kind, reference);
        if (key) assert.equal(classified.key, key, reference);
    }
    assert.equal(classifyImageReference('foo').implicitTag, true);
    assert.equal(classifyImageReference('localhost:5000/x').name, 'localhost:5000/x');
    assert.equal(classifyImageReference(`localhost:5000/x:tag@${DIGEST}`).digest, DIGEST);
    assert.equal(isTagReference('node:20-alpine'), true);
    assert.equal(isTagReference(`node@${DIGEST}`), false);
});

test('tagged images of enabled agents are deduplicated per runtime; digest, sandbox and other entries are not refreshed', () => {
    const registry = {
        _config: { static: { agent: 'a' } },
        c1: { type: 'agent', repoName: 'r1', agentName: 'a', image: 'foo' },
        c2: { type: 'agent', repoName: 'r1', agentName: 'b', image: 'foo:latest' },
        c3: { type: 'agent', repoName: 'r2', agentName: 'c', image: 'foo:latest', alias: 'c2' },
        c4: { type: 'agent', repoName: 'r2', agentName: 'd', image: `bar@${DIGEST}` },
        c5: { type: 'agent', repoName: 'r2', agentName: 'e', image: null },
        c6: { type: 'agent', repoName: 'r2', agentName: 'f', throws: true },
        c7: { type: 'interactive', repoName: 'r2', agentName: 'g', image: 'baz:1' },
        c8: { type: 'agent', repoName: 'r3', agentName: 'h', image: 'foo', runtime: 'docker' },
    };
    const resolveImages = (record) => {
        if (record.throws) throw new Error('manifest missing');
        if (!record.image) return [];
        return [{ runtime: record.runtime || 'podman', image: record.image }];
    };
    const warnings = [];
    const entries = collectTaggedAgentImages(registry, resolveImages, { warn: message => warnings.push(message) });
    assert.deepEqual(entries, [
        { runtime: 'podman', reference: 'foo', key: 'foo:latest', agents: ['r1/a', 'r1/b', 'r2/c (c2)'] },
        { runtime: 'docker', reference: 'foo', key: 'foo:latest', agents: ['r3/h'] },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /r2\/f: image not resolved/);

    const scoped = collectTaggedAgentImages(registry, resolveImages, { repoName: 'r2' });
    assert.deepEqual(scoped.map(entry => [entry.reference, entry.agents]), [['foo:latest', ['r2/c (c2)']]]);
});

function fakeImages(initial) {
    const ids = new Map(Object.entries(initial));
    const pulls = [];
    return {
        ids,
        pulls,
        inspectImageId: (reference, runtime) => ids.get(`${runtime}:${reference}`) || '',
        pull: (behaviour) => (reference, { runtime }) => {
            pulls.push(`${runtime}:${reference}`);
            const next = behaviour[`${runtime}:${reference}`];
            if (next instanceof Error) throw next;
            if (next) ids.set(`${runtime}:${reference}`, next);
        },
    };
}

test('each image is pulled once; a changed ID is recorded, a failed pull keeps the local image and the update goes on', () => {
    const images = fakeImages({ 'podman:changed:1': ID_A, 'podman:same:1': ID_A, 'podman:broken:1': ID_B });
    const entries = [
        { runtime: 'podman', reference: 'changed:1', key: 'changed:1', agents: ['r/a'] },
        { runtime: 'podman', reference: 'same:1', key: 'same:1', agents: ['r/b'] },
        { runtime: 'podman', reference: 'broken:1', key: 'broken:1', agents: ['r/c'] },
        { runtime: 'podman', reference: 'absent:1', key: 'absent:1', agents: ['r/d'] },
    ];
    const logs = [];
    const warnings = [];
    const records = refreshTaggedImages(entries, {
        inspectImageId: images.inspectImageId,
        pull: images.pull({ 'podman:changed:1': ID_B, 'podman:broken:1': new Error("Image pull for 'broken:1' exited with code 125.") }),
        log: message => logs.push(message),
        warn: message => warnings.push(message),
    });
    assert.deepEqual(images.pulls, ['podman:changed:1', 'podman:same:1', 'podman:broken:1'],
        'a reference without a local copy is left to the start path');
    assert.deepEqual(records.map(record => [record.phase, record.id, record.outcome, record.code, record.required]), [
        ['agent-image', 'changed:1', 'changed', 'image-updated', false],
        ['agent-image', 'same:1', 'unchanged', 'image-current', false],
        ['agent-image', 'broken:1', 'skipped', 'image-pull-failed', false],
    ]);
    assert.deepEqual([records[0].before.imageId, records[0].after.imageId], [ID_A, ID_B]);
    assert.deepEqual(records[0].details.agents, ['r/a']);
    assert.equal(images.ids.get('podman:broken:1'), ID_B, 'the existing local image is kept');
    assert.match(warnings.join('\n'), /broken:1: refresh failed .*keeping local image bbbbbbbbbbbb/);
    assert.match(logs.join('\n'), /absent:1 is not present locally/);

    const decision = decideUpdateStatus(records);
    assert.deepEqual([decision.status, decision.exitCode, decision.activationAllowed], ['complete-with-skips', 0, true],
        'a failed refresh with a local image is a named optional skip, not a failed update');
    const summary = formatUpdateSummary(buildCoreUpdateResult({ command: ['update'], records }));
    assert.match(summary, /agent-image broken:1: skipped \(image-pull-failed, optional\)/);
});

test('pulls share a time budget below the host bound; a spent budget keeps the remaining local images', () => {
    const images = fakeImages({ 'podman:one:1': ID_A, 'podman:two:1': ID_A });
    let clock = 0;
    const timeouts = [];
    const records = refreshTaggedImages([
        { runtime: 'podman', reference: 'one:1', key: 'one:1', agents: ['r/a'] },
        { runtime: 'podman', reference: 'two:1', key: 'two:1', agents: ['r/b'] },
    ], {
        inspectImageId: images.inspectImageId,
        pull: (reference, options) => { timeouts.push(options.timeoutMs); images.pulls.push(reference); clock += 60_000; },
        budgetMs: 60_000,
        pullTimeoutMs: 30 * 60_000,
        now: () => clock,
        log: () => {}, warn: () => {},
    });
    assert.deepEqual(images.pulls, ['one:1']);
    assert.deepEqual(timeouts, [60_000], 'a pull never outlives the remaining budget');
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code]), [
        ['one:1', 'unchanged', 'image-current'],
        ['two:1', 'skipped', 'image-pull-budget-exhausted'],
    ]);
    assert.equal(decideUpdateStatus(records).exitCode, 0);
});

test('the update phase reads the registry, refreshes only the scoped repository and never throws', () => {
    const registry = {
        a: { type: 'agent', repoName: 'r1', agentName: 'a' },
        b: { type: 'agent', repoName: 'r2', agentName: 'b' },
    };
    const images = fakeImages({ 'podman:img-r1': ID_A, 'podman:img-r2': ID_A });
    const quiet = () => {};
    const records = refreshAgentImagesForUpdate({
        repoName: 'r2',
        readRegistry: () => registry,
        resolveImages: record => [{ runtime: 'podman', image: `img-${record.repoName}` }],
        inspectImageId: images.inspectImageId,
        pull: images.pull({}),
        log: quiet, warn: quiet,
    });
    assert.deepEqual(images.pulls, ['podman:img-r2']);
    assert.deepEqual(records.map(record => record.outcome), ['unchanged']);

    const unreadable = refreshAgentImagesForUpdate({
        readRegistry: () => { throw new Error('registry invalid'); },
        log: quiet, warn: quiet,
    });
    assert.deepEqual(unreadable, []);
});

test('image records join an update result without changing its activation decision', () => {
    const base = buildCoreUpdateResult({ command: ['update'], records: [] });
    const images = fakeImages({ 'podman:x:1': ID_A });
    const records = refreshTaggedImages([{ runtime: 'podman', reference: 'x:1', key: 'x:1', agents: ['r/a'] }], {
        inspectImageId: images.inspectImageId, pull: images.pull({ 'podman:x:1': ID_B }), log: () => {}, warn: () => {},
    });
    const result = appendUpdateRecords(base, records);
    assert.deepEqual([result.status, result.exitCode, result.activationAllowed, result.totals.changed], ['complete', 0, true, 1]);
});

test('a container whose image is not the current image of its reference is replaced', () => {
    assert.equal(normalizeImageId(ID_A), 'a'.repeat(64));
    assert.equal(normalizeImageId('a'.repeat(64)), 'a'.repeat(64));
    assert.equal(normalizeImageId('not-an-id'), '');
    assert.equal(runtimeImageReuseProblem({ containerImageId: ID_A, referenceImageId: 'a'.repeat(64) }), '',
        'docker sha256: and podman bare IDs compare equal');
    assert.equal(runtimeImageReuseProblem({ containerImageId: ID_A, referenceImageId: ID_B }),
        'image changed (aaaaaaaaaaaa -> bbbbbbbbbbbb)');
    assert.equal(runtimeImageReuseProblem({ containerImageId: ID_A, referenceImageId: '' }), '',
        'a reference without a local copy keeps the launch path as before');
    assert.equal(runtimeImageReuseProblem({ containerImageId: '', referenceImageId: ID_B }), '');
});

test('runUpdateCommand appends the image records after the source phase, scoped for `update repo`', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-images-'));
    try {
        const workspace = path.join(scratch, 'ws');
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
        const script = String.raw`
            const { runUpdateCommand } = await import(${JSON.stringify(pathToFileURL(path.join(projectRoot, 'cli/commands/updateCommand.js')).href)});
            const { buildCoreUpdateResult } = await import(${JSON.stringify(pathToFileURL(path.join(projectRoot, 'cli/commands/updateRecords.js')).href)});
            const { createOperationRecord } = await import(${JSON.stringify(pathToFileURL(path.join(projectRoot, 'cli/commands/updateOutcome.js')).href)});
            const quiet = () => {};
            const calls = [];
            const source = (command) => async () => buildCoreUpdateResult({ command, records: [] });
            const refreshAgentImages = ({ repoName }) => {
                calls.push(repoName);
                return [createOperationRecord({ phase: 'agent-image', id: 'foo:1', outcome: 'skipped', attempted: true,
                    required: false, code: 'image-pull-failed', reason: 'kept' })];
            };
            const handlers = { updateAllRepos: source(['update']), updatePloinkyRepos: source(['update', 'repos']),
                updateRepoResult: source(['update', 'repo', 'r1']) };
            const all = await runUpdateCommand([], { handlers, refreshAgentImages, log: quiet, error: quiet, insideBox: false });
            const repo = await runUpdateCommand(['repo', 'r1'], { handlers, refreshAgentImages, log: quiet, error: quiet, insideBox: false });
            console.log(JSON.stringify({ calls, all: [all.status, all.exitCode, all.records.map(r => r.phase)], repo: repo.records.map(r => r.id) }));
        `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: workspace,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace },
            encoding: 'utf8',
        });
        const result = JSON.parse(output.trim().split('\n').pop());
        assert.deepEqual(result.calls, [null, 'r1']);
        assert.deepEqual(result.all, ['complete-with-skips', 0, ['agent-image']]);
        assert.deepEqual(result.repo, ['foo:1']);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
