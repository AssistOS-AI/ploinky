// Classify real throwaway Git repositories, and run the printed fix where it is
// a Git command, so the offline heuristics are checked against actual history.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assessAgentLibPin, readCheckoutPinContext } from '../../ploinky-box/agentlib-pin.mjs';

const L = 'a1'.repeat(20);
const I = 'b2'.repeat(20);
const N = 'c3'.repeat(20);
const LOCK = 'ploinky-box/dependencies.lock.json';
const GIT_ENV = (() => {
    const env = {
        ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
    return env;
})();
const skip = spawnSync('git', ['--version'], { env: GIT_ENV }).status === 0
    ? false : 'git is not available on PATH; real-repository pin classification was not exercised';

function git(cwd, ...args) {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
        { cwd, env: GIT_ENV, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function setPin(dir, commit) {
    fs.mkdirSync(path.join(dir, 'ploinky-box'), { recursive: true });
    fs.writeFileSync(path.join(dir, LOCK), `${JSON.stringify({ repositories: { achillesAgentLib: {
        url: 'https://example.invalid/AchillesAgentLib.git', commit,
    } } }, null, 2)}\n`);
}

const readPin = (dir) => JSON.parse(fs.readFileSync(path.join(dir, LOCK), 'utf8')).repositories.achillesAgentLib.commit;

function commitAll(dir, message) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
}

function commitFile(dir, name) {
    fs.writeFileSync(path.join(dir, name), name);
    commitAll(dir, name);
}

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-pin-git-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

/** A seed repository with the given pin history, and a bare upstream cloned from it. */
function upstream(root, pins) {
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'master');
    for (const pin of pins) {
        setPin(seed, pin);
        commitAll(seed, `pin ${pin.slice(0, 4)}`);
    }
    git(root, 'clone', '-q', '--bare', 'seed', 'up.git');
    git(seed, 'remote', 'add', 'origin', path.join(root, 'up.git'));
    return { seed, bare: path.join(root, 'up.git') };
}

function publish(seed, pin) {
    setPin(seed, pin);
    commitAll(seed, `pin ${pin.slice(0, 4)}`);
    git(seed, 'push', '-q', 'origin', 'master');
}

function classify(root, imageCommit = I) {
    const context = readCheckoutPinContext(root, { imageCommit });
    const assessment = assessAgentLibPin({
        lockCommit: readPin(root), bundle: { commit: imageCommit, imageId: `sha256:${'e'.repeat(64)}` },
        imageRef: 'docker.io/assistos/ploinky-box:latest', context,
    });
    return { context, assessment };
}

function runFix(command) {
    const result = spawnSync('sh', ['-c', command], { env: GIT_ENV, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
}

test('real Git: a checkout 1 commit behind a fetched upstream is told to fast-forward', { skip }, (t) => {
    const root = workspace(t);
    const { seed } = upstream(root, [L]);
    git(root, 'clone', '-q', 'up.git', 'co');
    const checkout = path.join(root, 'co');
    publish(seed, I);
    git(checkout, 'fetch', '-q');
    const { context, assessment } = classify(checkout);
    assert.equal(context.behind, 1);
    assert.equal(assessment.kind, 'checkout-behind');
    assert.equal(assessment.fix, `git -C ${checkout} pull --ff-only`);
    runFix(assessment.fix);
    assert.equal(readPin(checkout), I);
});

test('real Git: a diverged checkout, 1 ahead and 1 behind, is told to rebase', { skip }, (t) => {
    const root = workspace(t);
    const { seed } = upstream(root, [L]);
    git(root, 'clone', '-q', 'up.git', 'co');
    const checkout = path.join(root, 'co');
    commitFile(checkout, 'local');
    publish(seed, I);
    git(checkout, 'fetch', '-q');
    const { context, assessment } = classify(checkout);
    assert.deepEqual([context.ahead, context.behind], [1, 1]);
    assert.equal(assessment.kind, 'checkout-behind');
    assert.equal(assessment.fix, `git -C ${checkout} pull --rebase --autostash`);
    // An unrelated uncommitted edit must not make the printed fix fail or be lost.
    fs.writeFileSync(path.join(checkout, 'local'), 'edited');
    runFix(assessment.fix);
    assert.equal(readPin(checkout), I);
    assert.equal(fs.readFileSync(path.join(checkout, 'local'), 'utf8'), 'edited');
});

test('real Git: an unfetched upstream that already pins the image is probably ahead of the checkout', { skip }, (t) => {
    const root = workspace(t);
    const { seed } = upstream(root, [L]);
    git(root, 'clone', '-q', 'up.git', 'co');
    const checkout = path.join(root, 'co');
    publish(seed, I);
    const { context, assessment } = classify(checkout);
    assert.equal(context.upstreamCommit, L);
    assert.equal(assessment.kind, 'checkout-probably-behind');
    assert.equal(assessment.fix, `git -C ${checkout} pull --ff-only`);
    runFix(assessment.fix);
    assert.equal(readPin(checkout), I);
});

test('real Git: a diverged checkout with a stale upstream is told to rebase, not fast-forward', { skip }, (t) => {
    const root = workspace(t);
    const { seed } = upstream(root, [L]);
    git(root, 'clone', '-q', 'up.git', 'co');
    const checkout = path.join(root, 'co');
    commitFile(checkout, 'local');
    publish(seed, I);
    const { context, assessment } = classify(checkout);
    assert.equal(context.ahead, 1);
    assert.equal(assessment.kind, 'checkout-probably-behind');
    assert.equal(assessment.fix, `git -C ${checkout} pull --rebase --autostash`);
    runFix(assessment.fix);
    assert.equal(readPin(checkout), I);
});

for (const detached of [false, true]) {
    test(`real Git: an uncommitted edit away from the committed image pin (${detached ? 'detached HEAD' : 'no upstream'}) is not an older image`, { skip }, (t) => {
        const root = workspace(t);
        const checkout = path.join(root, 'co');
        fs.mkdirSync(checkout);
        git(checkout, 'init', '-q', '-b', 'master');
        setPin(checkout, L);
        commitAll(checkout, 'pin L');
        setPin(checkout, I);
        commitAll(checkout, 'pin I');
        if (detached) git(checkout, 'checkout', '-q', '--detach');
        setPin(checkout, L);
        const { context, assessment } = classify(checkout);
        assert.equal(context.headCommit, I);
        assert.equal(assessment.kind, 'uncommitted-pin');
        assert.ok(assessment.fix.startsWith(`git -C ${checkout} checkout HEAD -- ${LOCK} to drop the change`));
        runFix(`git -C ${checkout} checkout HEAD -- ${LOCK}`);
        assert.equal(readPin(checkout), I);
    });
}

test('real Git: a staged edit away from the committed image pin is dropped by the printed fix', { skip }, (t) => {
    const root = workspace(t);
    const checkout = path.join(root, 'co');
    fs.mkdirSync(checkout);
    git(checkout, 'init', '-q', '-b', 'master');
    setPin(checkout, I);
    commitAll(checkout, 'pin I');
    setPin(checkout, L);
    git(checkout, 'add', LOCK);
    const { assessment } = classify(checkout);
    assert.equal(assessment.kind, 'uncommitted-pin');
    // `checkout -- <path>` restores from the index and would keep the staged pin.
    runFix(`git -C ${checkout} checkout HEAD -- ${LOCK}`);
    assert.equal(readPin(checkout), I);
    assert.equal(git(checkout, 'status', '--porcelain'), '');
});

test('real Git: a checkout that committed a newer pin reports the image as older, naming the removal commit', { skip }, (t) => {
    const root = workspace(t);
    const checkout = path.join(root, 'co');
    fs.mkdirSync(checkout);
    git(checkout, 'init', '-q', '-b', 'master');
    setPin(checkout, I);
    commitAll(checkout, 'pin I');
    commitFile(checkout, 'between');
    setPin(checkout, N);
    commitAll(checkout, 'pin N');
    const removal = git(checkout, 'rev-parse', 'HEAD');
    const { context, assessment } = classify(checkout);
    assert.equal(assessment.kind, 'image-older');
    assert.ok(removal.startsWith(context.replacedIn.commit), `${context.replacedIn.commit} is not ${removal}`);
    assert.match(assessment.fix, /^podman pull docker\.io\/assistos\/ploinky-box:latest, then rerun this command/);
});

test('real Git: a shallow clone does not guess which side is out of date', { skip }, (t) => {
    const root = workspace(t);
    const { bare } = upstream(root, [I, L]);
    git(root, 'clone', '-q', '--depth', '1', `file://${bare}`, 'co');
    const checkout = path.join(root, 'co');
    const { context, assessment } = classify(checkout);
    assert.equal(context.shallow, true);
    assert.equal(assessment.kind, 'shallow-unknown');
    assert.equal(assessment.fix, `git -C ${checkout} fetch --unshallow, then rerun this command; `
        + `if the checkout is simply outdated, git -C ${checkout} pull --ff-only fixes it.`);
    runFix(`git -C ${checkout} fetch -q --unshallow`);
    assert.equal(classify(checkout).assessment.kind, 'image-older');
});

test('real Git: a directory without Git metadata is no-git', { skip }, (t) => {
    const root = workspace(t);
    const plain = path.join(root, 'plain');
    setPin(plain, L);
    assert.equal(classify(plain).assessment.kind, 'no-git');
});

test('real Git: an inherited GIT_DIR does not redirect the queries to another repository', { skip }, (t) => {
    const root = workspace(t);
    const { seed } = upstream(root, [L]);
    git(root, 'clone', '-q', 'up.git', 'co');
    const checkout = path.join(root, 'co');
    publish(seed, I);
    git(checkout, 'fetch', '-q');
    git(root, 'clone', '-q', 'up.git', 'other');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(root, 'other', '.git');
    try {
        const { context, assessment } = classify(checkout);
        assert.equal(context.behind, 1);
        assert.equal(assessment.kind, 'checkout-behind');
    } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
    }
});

test('real Git: an inherited GIT_WORK_TREE and GIT_INDEX_FILE do not redirect the queries', { skip }, (t) => {
    const root = workspace(t);
    const { seed } = upstream(root, [L]);
    git(root, 'clone', '-q', 'up.git', 'co');
    const checkout = path.join(root, 'co');
    publish(seed, I);
    git(checkout, 'fetch', '-q');
    git(root, 'clone', '-q', 'up.git', 'other');
    const names = ['GIT_WORK_TREE', 'GIT_INDEX_FILE'];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.GIT_WORK_TREE = path.join(root, 'other');
    process.env.GIT_INDEX_FILE = path.join(root, 'other', '.git', 'index');
    try {
        const { context, assessment } = classify(checkout);
        assert.equal(context.root, fs.realpathSync(checkout));
        assert.equal(context.behind, 1);
        assert.equal(assessment.kind, 'checkout-behind');
    } finally {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});
