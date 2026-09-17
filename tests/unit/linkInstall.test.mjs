import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkInstallDeclarations, prepareLinkedRepositories } from '../../cli/utils/linkInstall.mjs';

const url = 'https://github.com/example/Library.git';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calls = [];
    const repo = (name, origin = url) => {
        const directory = path.join(root, name);
        fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
        fs.writeFileSync(path.join(directory, '.git/origin'), origin);
        return directory;
    };
    const execFile = (command, args) => {
        assert.equal(command, 'git');
        calls.push(args);
        if (args.includes('clone')) {
            fs.mkdirSync(path.join(args.at(-1), '.git'));
            fs.writeFileSync(path.join(args.at(-1), '.git/origin'), args.at(-2));
            return '';
        }
        return fs.readFileSync(path.join(args[1], '.git/origin'), 'utf8');
    };
    return { root, repo, calls, options: { workspaceRoot: root, execFile, writable: true } };
}

test('clones only missing repositories, uses stable links and preserves local edits', t => {
    const f = fixture(t);
    const manifest = { 'link-install': [url] };
    const [mount] = prepareLinkedRepositories(manifest, f.options);
    const source = path.join(fs.realpathSync(f.root), 'Library');
    assert.deepEqual(mount, { name: 'Library', source, target: source, link: 'linked/Library', readOnly: false });
    fs.writeFileSync(path.join(mount.source, 'local-edit'), 'keep');
    prepareLinkedRepositories(manifest, f.options);
    assert.equal(f.calls.filter(args => args.includes('clone')).length, 1);
    assert.equal(f.calls.some(args => args.includes('pull') || args.includes('fetch') || args.includes('reset')), false);
    assert.equal(fs.readFileSync(path.join(mount.source, 'local-edit'), 'utf8'), 'keep');
});

test('matches Git origin across directory names and HTTPS/SSH forms', t => {
    const f = fixture(t);
    const source = f.repo('checkout', 'git@github.com:example/Library.git');
    const [mount] = prepareLinkedRepositories({ 'link-install': [url] }, { ...f.options, create: false, writable: false });
    assert.equal(mount.source, source);
    // Same-path grant: the runtime destination is the workspace checkout path.
    assert.equal(mount.target, source);
    assert.equal(mount.link, 'linked/Library');
    assert.equal(mount.readOnly, true);
    assert.equal(f.calls.some(args => args.includes('clone')), false);
});

test('rejects ambiguous, colliding, escaping and invalid declarations without cloning', t => {
    const f = fixture(t);
    f.repo('Library', 'https://github.com/another/Library.git');
    assert.throws(() => prepareLinkedRepositories({ 'link-install': [url] }, f.options), /different or missing Git origin/);
    f.repo('one'); f.repo('two');
    assert.throws(() => prepareLinkedRepositories({ 'link-install': [url] }, f.options), /Multiple workspace/);
    for (const value of ['file:///tmp/repo', 'https://user:pass@github.com/example/repo', '../repo', 'https://github.com/a/repo#branch']) {
        assert.throws(() => linkInstallDeclarations({ 'link-install': [value] }));
    }
    assert.throws(() => linkInstallDeclarations({ 'link-install': url }), /array/);
    assert.throws(() => linkInstallDeclarations({ 'link-install': [url, 'https://github.com/other/Library.git'] }), /collision/);
    assert.equal(f.calls.some(args => args.includes('clone')), false);
});

test('adoption never clones and failed clone cleans only its temporary directory', t => {
    const f = fixture(t);
    const manifest = { 'link-install': [url] };
    assert.throws(() => prepareLinkedRepositories(manifest, { ...f.options, create: false }), /missing/);
    assert.throws(() => prepareLinkedRepositories(manifest, { ...f.options, execFile() { throw new Error('private diagnostic'); } }), /Could not clone/);
    assert.deepEqual(fs.readdirSync(f.root), []);
});
