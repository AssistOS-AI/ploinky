import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { readSourceTreeDigest, verifyLocalSnapshotBundle } from '../release/verifyLocalSnapshotBundle.mjs';
import { verifyReleaseBundle, LOCKED_ROOT_POSTINSTALL } from '../release/verifyCopilot421Bundle.mjs';

const names = ['achillesAgentLib', 'ploinky', 'achillesCLI', 'explorer'];
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-verifier-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = {};
    const release = { repositories: {}, images: { ploinkyBox: { digest: `sha256:${'a'.repeat(64)}` } } };
    for (const name of names) {
        const repo = paths[name] = path.join(root, name);
        fs.mkdirSync(repo);
        const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        git('init');
        fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
        fs.writeFileSync(path.join(repo, 'source.mjs'), 'export const value = 1;\n');
        git('add', '.');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
        release.repositories[name] = { commit: git('rev-parse', 'HEAD') };
    }
    paths.rootPackage = path.join(paths.ploinky, 'package.json');
    paths.globalPackage = path.join(paths.ploinky, 'globalDeps', 'package.json');
    paths.dependencyLock = path.join(paths.ploinky, 'ploinky-box', 'dependencies.lock.json');
    for (const [file, value] of [
        [paths.rootPackage, { scripts: { postinstall: LOCKED_ROOT_POSTINSTALL } }],
        [paths.globalPackage, { dependencies: {} }],
        [paths.dependencyLock, { repositories: { achillesAgentLib: { url: 'https://example.invalid/lib.git', ...release.repositories.achillesAgentLib } } }],
    ]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
    }
    const manifest = { kind: 'local-snapshot-v1', release, trees: Object.fromEntries(names.map(name => [name, readSourceTreeDigest(paths[name])])) };
    return { paths, manifest };
}

test('exact dirty source snapshot passes while the release verifier still rejects it', t => {
    const { paths, manifest } = fixture(t);
    const result = verifyLocalSnapshotBundle(manifest, { paths });
    assert.equal(result.verificationMode, 'local-snapshot');
    assert.equal(result.repositories.ploinky.treeSha256, manifest.trees.ploinky);
    assert.throws(() => verifyReleaseBundle(manifest.release, { paths }), /uncommitted or untracked/);
    assert.throws(() => verifyReleaseBundle(manifest, { paths }), /release manifest must contain exactly/);
});

test('snapshot rejects changed bytes, additions, deletions, executable modes, and wrong base commits', t => {
    const { paths, manifest } = fixture(t);
    const file = path.join(paths.explorer, 'source.mjs');
    const original = fs.readFileSync(file);
    for (const modify of [
        () => fs.appendFileSync(file, '// changed'),
        () => fs.unlinkSync(file),
        () => fs.chmodSync(file, 0o755),
        () => fs.writeFileSync(path.join(paths.explorer, 'new file.mjs'), 'unexpected'),
    ]) {
        modify();
        assert.throws(() => verifyLocalSnapshotBundle(manifest, { paths }), /explorer source tree changed/);
        fs.writeFileSync(file, original);
        fs.chmodSync(file, 0o644);
        fs.rmSync(path.join(paths.explorer, 'new file.mjs'), { force: true });
    }
    manifest.release.repositories.explorer.commit = 'b'.repeat(40);
    assert.throws(() => verifyLocalSnapshotBundle(manifest, { paths }), /base commit changed/);
});

test('snapshot handles unusual filenames deterministically and rejects escaping links', t => {
    const { paths, manifest } = fixture(t);
    fs.writeFileSync(path.join(paths.explorer, 'unicode-λ\nfile.mjs'), 'hello');
    const digest = readSourceTreeDigest(paths.explorer);
    assert.notEqual(digest, manifest.trees.explorer);
    assert.equal(readSourceTreeDigest(paths.explorer), digest);
    fs.symlinkSync('../outside', path.join(paths.explorer, 'escape'));
    assert.throws(() => readSourceTreeDigest(paths.explorer), /symlink escapes/);
});

test('snapshot detects a file added or an earlier file changed during hashing', t => {
    const { paths } = fixture(t);
    const readSync = fs.readSync;
    t.after(() => { fs.readSync = readSync; });
    for (const mutate of [
        () => fs.appendFileSync(path.join(paths.explorer, '.gitignore'), 'extra\n'),
        () => fs.writeFileSync(path.join(paths.explorer, 'late.mjs'), 'late source'),
    ]) {
        let mutated = false;
        fs.readSync = (descriptor, buffer, ...args) => {
            const count = readSync(descriptor, buffer, ...args);
            if (!mutated && count && buffer.subarray(0, count).includes('export const value')) {
                mutated = true;
                mutate();
            }
            return count;
        };
        assert.throws(() => readSourceTreeDigest(paths.explorer), /changed while hashing/);
        assert.equal(mutated, true);
        fs.readSync = readSync;
    }
});
