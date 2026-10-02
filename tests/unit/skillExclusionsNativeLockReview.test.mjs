import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { syncManagedSkillExports } from '../../cli/utils/skills/exportTransaction.mjs';
import { createSkillExclusionPlanner } from '../../cli/utils/skills/exportExclusions.mjs';

// The exporter's own Git calls use process.env: never read the global, system
// or XDG Git policy of this machine.
const isolation = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-native-lock-env-')));
delete process.env.PLOINKY_SKILL_EXCLUDES_COMPOSE;
Object.assign(process.env, { HOME: isolation, XDG_CONFIG_HOME: path.join(isolation, 'xdg'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
test.after(() => fs.rmSync(isolation, { recursive: true, force: true }));

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-native-lock-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    const source = path.join(root, 'source');
    fs.mkdirSync(repo); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# fixture');
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg'),
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = args => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    const initialized = git(['init', '-q']);
    assert.equal(initialized.status, 0, initialized.stderr);
    const config = path.join(repo, '.git', 'config');
    const sync = () => syncManagedSkillExports({ folder: repo, owner: 'fixture',
        sources: [{ name: 'fixture', path: source }], exclusions: createSkillExclusionPlanner({
            env, containerExecutor: false, gitDirBoundary: root, capability: () => ({ supported: true }),
        }) });
    return { root, repo, source, config, sync, git };
}

for (const name of ['config.lock', 'config.worktree.lock']) {
    test(`an existing native ${name} defers exclusions and is never removed`, t => {
        const w = fixture(t);
        const lock = path.join(w.repo, '.git', name);
        const before = fs.readFileSync(w.config);
        fs.writeFileSync(lock, 'foreign writer');
        const inode = fs.statSync(lock).ino;
        const result = w.sync();
        assert.equal(result.exclusions.status, 'deferred');
        assert.equal(result.exclusions.code, 'git-config-busy');
        assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign writer');
        assert.equal(fs.statSync(lock).ino, inode);
        assert.deepEqual(fs.readFileSync(w.config), before);
    });
}

test('a cooperative native Git writer cannot slip between config validation and publication', t => {
    const w = fixture(t);
    const rename = fs.renameSync;
    let contender = null;
    try {
        fs.renameSync = (from, to) => {
            if (from === `${w.config}.lock` && to === w.config) {
                contender = w.git(['config', '--file', w.config, 'review.concurrent', 'preserved']);
            }
            return rename(from, to);
        };
        assert.equal(w.sync().transaction.status, 'committed');
    } finally { fs.renameSync = rename; }
    assert.ok(contender, 'the contender ran at the publication boundary');
    assert.notEqual(contender.status, 0);
    assert.match(contender.stderr, /could not lock config file|File exists/);
    assert.equal(fs.existsSync(`${w.config}.lock`), false, 'our lock is gone after publication');
    const retry = w.git(['config', '--file', w.config, 'review.concurrent', 'preserved']);
    assert.equal(retry.status, 0, retry.stderr);
    w.sync();
    assert.equal(w.git(['config', '--file', w.config, '--get', 'review.concurrent']).stdout.trim(), 'preserved',
        'a successful native write survives the next idempotent export');
});

test('a replaced native lock is preserved and never published or removed by its former owner', t => {
    const w = fixture(t);
    const before = fs.readFileSync(w.config);
    const read = fs.readFileSync;
    let replaced = false;
    try {
        fs.readFileSync = (filename, ...args) => {
            if (!replaced && typeof filename === 'string' && path.basename(filename) === 'config'
                && path.basename(path.dirname(filename)).startsWith('skill-export-config-')) {
                replaced = true;
                fs.unlinkSync(`${w.config}.lock`);
                fs.writeFileSync(`${w.config}.lock`, 'successor lock');
            }
            return read(filename, ...args);
        };
        assert.throws(() => w.sync(), { code: 'SKILL_EXPORT_RECOVERY_REQUIRED' });
    } finally { fs.readFileSync = read; }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(`${w.config}.lock`, 'utf8'), 'successor lock');
    assert.deepEqual(fs.readFileSync(w.config), before);
});

// A second export folder in the same worktree, with the first folder's contribution already recorded.
function withChild(w) {
    const child = path.join(w.repo, 'child');
    fs.mkdirSync(child);
    const exclusions = () => createSkillExclusionPlanner({ env: w.env, containerExecutor: false, gitDirBoundary: w.root, capability: () => ({ supported: true }) });
    const syncChild = (extra = {}) => syncManagedSkillExports({ folder: child, owner: 'fixture', sources: [{ name: 'fixture', path: w.source }], exclusions: exclusions(), ...extra });
    return { child, syncChild };
}
const sharedMetadata = w => ['ploinky-skill-exports.exclude', 'ploinky-skill-exports.exclusions.json', 'config', 'config.worktree']
    .map(name => { const file = path.join(w.repo, '.git', name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; });

test('an existing native lock defers a second folder and keeps the first folder\'s recorded contribution', t => {
    const w = fixture(t);
    assert.equal(w.sync().exclusions.status, 'published');
    const { syncChild } = withChild(w);
    const before = sharedMetadata(w);
    // The first export enabled worktree config, so a worktree-scope native lock is the one that matters.
    const worktreeLock = path.join(w.repo, '.git', 'config.worktree.lock');
    fs.writeFileSync(worktreeLock, 'foreign writer');
    const result = syncChild();
    assert.equal(result.exclusions.code, 'git-config-busy');
    assert.equal(fs.readFileSync(worktreeLock, 'utf8'), 'foreign writer');
    assert.deepEqual(sharedMetadata(w), before);
    fs.rmSync(worktreeLock);
    assert.equal(syncChild().exclusions.status, 'published');
    const record = JSON.parse(fs.readFileSync(path.join(w.repo, '.git', 'ploinky-skill-exports.exclusions.json'), 'utf8'));
    assert.deepEqual(Object.keys(record.owners).sort(), ['.', 'child']);
});

test('a pre-existing common Git lock without an owner blocks a second folder and is preserved', t => {
    const w = fixture(t);
    assert.equal(w.sync().exclusions.status, 'published');
    const { syncChild } = withChild(w);
    const before = sharedMetadata(w);
    const lock = path.join(w.repo, '.git', 'ploinky-skill-exports-config.lock');
    fs.mkdirSync(lock);
    assert.throws(() => syncChild({ lock: { waitMs: 0 } }), { code: 'SKILL_EXPORT_LOCK_OWNERLESS' });
    assert.ok(fs.statSync(lock).isDirectory(), 'the lock is preserved');
    assert.deepEqual(sharedMetadata(w), before);
    assert.equal(fs.existsSync(path.join(w.repo, 'child', '.agents', 'skills', 'fixture')), false, 'nothing was published');
});
