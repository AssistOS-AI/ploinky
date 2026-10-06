import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policy from '../../cli/utils/runtime/agentDataPathPolicy.js';

function outcome(fn) {
    try { return { value: fn() }; } catch (error) {
        return { code: error.code, message: error.message, context: error.context };
    }
}

async function asyncOutcome(fn) {
    try { return { value: await fn() }; } catch (error) {
        return { code: error.code, message: error.message, context: error.context };
    }
}

test('async data policy matches sync values and errors across missing paths, aliases and escapes', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e3-policy-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.data', 'plain'), { recursive: true });
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync('../plain', path.join(root, '.data', 'plain', 'inside-link'));
    fs.symlinkSync('../outside', path.join(root, '.data', 'escape'));
    fs.symlinkSync('missing', path.join(root, '.data', 'dangling'));
    fs.writeFileSync(path.join(root, '.data', 'plain', 'file'), 'x');
    const options = { workspaceRoot: root };
    const paths = ['.data', '.data/plain', '.data/missing/child', '.data/plain/file/child',
        '.data/plain/inside-link', '.data/plain/inside-link/child', '.data/escape/child',
        '.data/dangling/child', '.data-other/x', '../escape'];
    let seed = 19;
    for (let index = 0; index < 40; index += 1) {
        seed = (seed * 48271) % 2147483647;
        paths.push(`.data/${seed % 2 ? 'plain' : 'escape'}/child-${seed % 17}`);
    }
    for (const relative of paths) {
        const target = path.resolve(root, relative);
        assert.deepEqual(await asyncOutcome(() => policy.assertCanonicalAgentDataPathAsync(target, options)),
            outcome(() => policy.assertCanonicalAgentDataPath(target, options)), relative);
        assert.deepEqual(await asyncOutcome(() => policy.projectedCanonicalPathAsync(target)),
            outcome(() => policy.projectedCanonicalPath(target)), relative);
    }
    for (const key of ['agent', 'other-1.2', '', '.', '..', '../escape', 'a/b', 'a\\b', ' bad']) {
        assert.deepEqual(await asyncOutcome(() => policy.resolveAgentDataPathAsync(key, options)),
            outcome(() => policy.resolveAgentDataPath(key, options)), key);
    }
    const target = path.join(root, '.data', 'created');
    assert.equal(await policy.ensureAgentDataDirectoryAsync(target, { ...options, mode: 0o750 }), target);
    assert.equal(fs.statSync(target).mode & 0o777, 0o750);
    fs.rmdirSync(target);
    fs.symlinkSync('../outside', target);
    assert.deepEqual(await asyncOutcome(() => policy.ensureAgentDataDirectoryAsync(target, options)),
        outcome(() => policy.ensureAgentDataDirectory(target, options)));
    assert.deepEqual(fs.readdirSync(path.join(root, 'outside')), []);
});

test('async policy rejects a symlinked data root and accepts a canonical workspace alias', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e3-root-policy-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'workspace'));
    fs.mkdirSync(path.join(root, 'external'));
    fs.symlinkSync('workspace', path.join(root, 'alias'));
    for (const workspaceRoot of [path.join(root, 'workspace'), path.join(root, 'alias')]) {
        const options = { workspaceRoot };
        assert.equal(await policy.resolveAgentDataPathAsync('agent', options),
            policy.resolveAgentDataPath('agent', options));
    }
    fs.symlinkSync('../external', path.join(root, 'workspace', '.data'));
    for (const workspaceRoot of [path.join(root, 'workspace'), path.join(root, 'alias')]) {
        const options = { workspaceRoot };
        assert.deepEqual(await asyncOutcome(() => policy.resolveAgentDataPathAsync('agent', options)),
            outcome(() => policy.resolveAgentDataPath('agent', options)));
    }
});
