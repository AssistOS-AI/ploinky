import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const snapshots = JSON.parse(fs.readFileSync(new URL('../fixtures/regressionBaselines.json', import.meta.url), 'utf8'));

// Build an owned repository from reviewed historical blobs. Its synthetic ref
// records provenance; it does not pretend to be the original complete commit.
export function historicalGitFixture(t, revision) {
    const snapshot = snapshots.revisions[revision];
    assert.ok(snapshot, 'historical revision must be explicitly pinned');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    });
    const run = (args, input) => {
        const result = spawnSync('git', args, { cwd: root, env, input, encoding: 'utf8' });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    run(['init', '--quiet']);
    for (const file of snapshot.files) {
        const bytes = Buffer.from(file.base64, 'base64');
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256);
        const oid = run(['hash-object', '-w', '--stdin'], bytes);
        assert.equal(oid, file.blob, 'historical bytes retain their original Git blob identity');
        run(['update-index', '--add', '--cacheinfo', file.mode, oid, file.path]);
    }
    const tree = run(['write-tree']);
    const commit = run(['commit-tree', tree], `Historical fixture from ${revision}, tree ${snapshot.tree}\n`);
    const ref = `refs/test-baselines/${revision}`;
    run(['update-ref', ref, commit]);
    assert.equal(run(['rev-parse', `${ref}^{tree}`]), tree);
    return { root, ref };
}
