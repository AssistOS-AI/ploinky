import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { resolveStartSourcePolicy } from '../../ploinky-box/source-policy.mjs';
import {
    AGENTLIB_RELATIVE_CHECKOUT,
    ensureAgentlibCheckout,
    validateAgentlibCheckout,
} from '../../ploinky-box/dev/agentlib-checkout.mjs';
import {
    cleanupLocalAgentlibSnapshot,
    createLocalAgentlibSnapshot,
    publishLocalAgentlibSnapshot,
    sha256File,
} from '../../ploinky-box/dev/local-agentlib-snapshot.mjs';

function tempRoot(t, prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function writeAgentlibPackage(directory, { extra = true } = {}) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
        name: 'ploinky-agent-lib',
        version: '1.0.0',
        type: 'module',
        main: 'index.mjs',
        files: ['index.mjs', 'included.txt'],
    }));
    fs.writeFileSync(path.join(directory, 'index.mjs'), 'export const marker = "local";\n');
    if (extra) {
        fs.writeFileSync(path.join(directory, 'included.txt'), 'included-untracked-by-git\n');
        fs.writeFileSync(path.join(directory, 'ignored.txt'), 'not-in-package\n');
    }
}

function runFixtureGit(cwd, args, { env = process.env } = {}) {
    const result = spawnSync('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return String(result.stdout || '').trim();
}

test('host start mode parsing is exact and rejects local ref ambiguity', () => {
    assert.deepEqual(resolveStartSourcePolicy({}), { mode: 'local' });
    assert.deepEqual(resolveStartSourcePolicy({ PLOINKY_PROD: 'false' }), { mode: 'local' });
    assert.deepEqual(resolveStartSourcePolicy({ PLOINKY_PROD: 'true' }), { mode: 'locked' });
    assert.deepEqual(
        resolveStartSourcePolicy({ PLOINKY_PROD: 'true', PLOINKY_AGENTLIB_REF: 'feature' }),
        { mode: 'resolved-ref', requestedRef: 'feature' },
    );
    for (const value of ['', ' ', 'TRUE', '1', '0', 'yes', 'off']) {
        assert.throws(() => resolveStartSourcePolicy({ PLOINKY_PROD: value }), /exactly true or false/);
    }
    for (const ref of ['feature', ' ']) {
        assert.throws(
            () => resolveStartSourcePolicy({ PLOINKY_PROD: 'false', PLOINKY_AGENTLIB_REF: ref }),
            /requires PLOINKY_PROD=true/,
        );
    }
});

test('a missing checkout invokes only the exact submodule initializer before validation', (t) => {
    const root = tempRoot(t, 'ploinky-agentlib-checkout-');
    const checkout = path.join(root, AGENTLIB_RELATIVE_CHECKOUT);
    const calls = [];
    const spawn = (command, args) => {
        calls.push([command, args]);
        if (args[0] === 'submodule') writeAgentlibPackage(checkout, { extra: false });
        return {
            status: 0,
            stdout: args.includes('--show-toplevel') ? `${checkout}\n` : '',
            stderr: '',
        };
    };
    const result = ensureAgentlibCheckout({ repositoryRoot: root, spawn });
    assert.equal(result.checkoutPath, checkout);
    assert.deepEqual(calls[0], [
        'git',
        ['submodule', 'update', '--init', '--', 'node_modules/achillesAgentLib'],
    ]);
    assert.deepEqual(calls.slice(1).map((call) => call[1]), [
        ['-C', checkout, 'rev-parse', '--show-toplevel'],
    ]);
});

test('an empty checkout left by a fresh clone invokes the exact submodule initializer', (t) => {
    const root = tempRoot(t, 'ploinky-agentlib-empty-checkout-');
    const checkout = path.join(root, AGENTLIB_RELATIVE_CHECKOUT);
    fs.mkdirSync(checkout, { recursive: true });
    const calls = [];
    const spawn = (command, args) => {
        calls.push([command, args]);
        if (args[0] === 'submodule') writeAgentlibPackage(checkout, { extra: false });
        return {
            status: 0,
            stdout: args.includes('--show-toplevel') ? `${checkout}\n` : '',
            stderr: '',
        };
    };

    const result = ensureAgentlibCheckout({ repositoryRoot: root, spawn });

    assert.equal(result.checkoutPath, checkout);
    assert.deepEqual(calls.map((call) => call[1]), [
        ['submodule', 'update', '--init', '--', 'node_modules/achillesAgentLib'],
        ['-C', checkout, 'rev-parse', '--show-toplevel'],
    ]);
});

test('a real non-recursive clone initializes its empty AchillesAgentLib gitlink', (t) => {
    const fixture = tempRoot(t, 'ploinky-agentlib-real-clone-');
    const agentlibSource = path.join(fixture, 'agentlib-source');
    const parentSource = path.join(fixture, 'ploinky-source');
    const clone = path.join(fixture, 'ploinky-clone');
    const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };

    fs.mkdirSync(agentlibSource);
    runFixtureGit(agentlibSource, ['init']);
    writeAgentlibPackage(agentlibSource, { extra: false });
    runFixtureGit(agentlibSource, ['add', '--', '.']);
    runFixtureGit(agentlibSource, [
        '-c', 'user.name=Ploinky Test',
        '-c', 'user.email=ploinky-test@example.invalid',
        'commit', '-m', 'agentlib fixture',
    ]);

    fs.mkdirSync(parentSource);
    runFixtureGit(parentSource, ['init']);
    runFixtureGit(parentSource, [
        '-c', 'protocol.file.allow=always',
        'submodule', 'add', '--', agentlibSource, AGENTLIB_RELATIVE_CHECKOUT,
    ]);
    runFixtureGit(parentSource, ['add', '--', '.gitmodules', AGENTLIB_RELATIVE_CHECKOUT]);
    runFixtureGit(parentSource, [
        '-c', 'user.name=Ploinky Test',
        '-c', 'user.email=ploinky-test@example.invalid',
        'commit', '-m', 'ploinky fixture',
    ]);

    runFixtureGit(fixture, ['clone', '--no-recurse-submodules', '--', parentSource, clone]);
    const checkout = path.join(clone, AGENTLIB_RELATIVE_CHECKOUT);
    assert.equal(fs.lstatSync(checkout).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(checkout), []);

    const result = ensureAgentlibCheckout({ repositoryRoot: clone, env: gitEnv });

    assert.equal(result.checkoutPath, checkout);
    assert.equal(result.package.name, 'ploinky-agent-lib');
    assert.equal(fs.existsSync(path.join(checkout, 'index.mjs')), true);
});

test('a present dirty checkout is validation-only and an invalid symlink is preserved', (t) => {
    const root = tempRoot(t, 'ploinky-agentlib-present-');
    const checkout = path.join(root, AGENTLIB_RELATIVE_CHECKOUT);
    writeAgentlibPackage(checkout);
    const calls = [];
    ensureAgentlibCheckout({
        repositoryRoot: root,
        spawn(command, args) {
            calls.push([command, args]);
            return { status: 0, stdout: `${checkout}\n`, stderr: '' };
        },
    });
    assert.deepEqual(calls.map((call) => call[1]), [
        ['-C', checkout, 'rev-parse', '--show-toplevel'],
    ]);

    const linked = path.join(root, 'linked-agentlib');
    fs.symlinkSync(checkout, linked, 'dir');
    assert.throws(() => validateAgentlibCheckout(linked, {
        spawn() { throw new Error('symlink must fail before Git'); },
    }), /not a real directory/);
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
});

test('present unsafe or populated invalid checkout paths are never initialized or replaced', (t) => {
    const root = tempRoot(t, 'ploinky-agentlib-invalid-checkout-');
    const checkout = path.join(root, AGENTLIB_RELATIVE_CHECKOUT);
    const outside = path.join(root, 'outside');
    writeAgentlibPackage(outside, { extra: false });

    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    fs.symlinkSync(outside, checkout, 'dir');
    assert.throws(
        () => ensureAgentlibCheckout({
            repositoryRoot: root,
            spawn() { throw new Error('Git must not run for a symlink'); },
        }),
        /not a real directory/,
    );
    assert.equal(fs.lstatSync(checkout).isSymbolicLink(), true);

    fs.unlinkSync(checkout);
    fs.writeFileSync(checkout, 'not a checkout');
    assert.throws(
        () => ensureAgentlibCheckout({
            repositoryRoot: root,
            spawn() { throw new Error('Git must not run for a non-directory'); },
        }),
        /not a real directory/,
    );
    assert.equal(fs.readFileSync(checkout, 'utf8'), 'not a checkout');

    fs.unlinkSync(checkout);
    fs.mkdirSync(checkout);
    const sentinel = path.join(checkout, 'do-not-replace.txt');
    fs.writeFileSync(sentinel, 'preserve me');
    const calls = [];
    assert.throws(() => ensureAgentlibCheckout({
        repositoryRoot: root,
        spawn(command, args) {
            calls.push([command, args]);
            return { status: 0, stdout: `${checkout}\n`, stderr: '' };
        },
    }), /package\.json/);
    assert.deepEqual(calls.map((call) => call[1]), [
        ['-C', checkout, 'rev-parse', '--show-toplevel'],
    ]);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve me');
});

test('npm pack captures package-visible working-tree bytes and publication uses one exact SHA', (t) => {
    const root = tempRoot(t, 'ploinky-agentlib-pack-test-');
    const checkout = path.join(root, 'checkout');
    const tempDirectory = path.join(root, 'tmp');
    const dependencies = path.join(root, 'dependencies');
    fs.mkdirSync(tempDirectory);
    fs.mkdirSync(dependencies);
    writeAgentlibPackage(checkout);

    const snapshot = createLocalAgentlibSnapshot(checkout, { tempRoot: tempDirectory });
    assert.deepEqual(Object.keys(snapshot).sort(), ['sha256', 'tempArchivePath']);
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.sha256, sha256File(snapshot.tempArchivePath));
    const listing = spawnSync('tar', ['-tzf', snapshot.tempArchivePath], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /package\/included\.txt/);
    assert.doesNotMatch(listing.stdout, /ignored\.txt/);

    const published = publishLocalAgentlibSnapshot(snapshot, { dependenciesRoot: dependencies });
    assert.equal(
        published,
        path.join(dependencies, '.ploinky-local-agentlib', `${snapshot.sha256}.tgz`),
    );
    assert.equal(sha256File(published), snapshot.sha256);
    assert.equal(fs.statSync(published).ino === fs.statSync(snapshot.tempArchivePath).ino, false);
    assert.equal(publishLocalAgentlibSnapshot(snapshot, { dependenciesRoot: dependencies }), published);

    cleanupLocalAgentlibSnapshot(snapshot);
    assert.equal(fs.existsSync(snapshot.tempArchivePath), false);
});

test('pack failures remove the private temporary directory', (t) => {
    const root = tempRoot(t, 'ploinky-agentlib-pack-failure-');
    const checkout = path.join(root, 'checkout');
    const tempDirectory = path.join(root, 'tmp');
    fs.mkdirSync(tempDirectory);
    writeAgentlibPackage(checkout);

    assert.throws(() => createLocalAgentlibSnapshot(checkout, {
        tempRoot: tempDirectory,
        spawn() {
            return { status: 1, stdout: '', stderr: 'simulated npm failure' };
        },
    }), /simulated npm failure/);
    assert.deepEqual(fs.readdirSync(tempDirectory), []);
});
