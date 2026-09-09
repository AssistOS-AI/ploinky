import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGitCommand } from '../../cli/utils/gitCommand.js';

function fixture(t, script) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-git-diagnostics-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, 'git');
    fs.writeFileSync(executable, `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    return { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` };
}

test('Git failure retains command, status and stderr while redacting credentials', (t) => {
    const env = fixture(t, `
        process.stderr.write('fatal: cannot fetch https://user:private-password@example.invalid/repo.git?token=private-token\\n');
        process.stderr.write('Authorization: Bearer private-bearer\\n');
        process.exit(128);
    `);
    assert.throws(() => runGitCommand(['clone', 'https://user:private-password@example.invalid/repo.git'], {
        env, stdio: 'ignore',
    }), error => {
        assert.equal(error.status, 128);
        assert.match(error.message, /git clone .*exited with status 128/);
        assert.match(error.message, /fatal: cannot fetch/);
        assert.match(error.stderr, /example\.invalid\/repo\.git/);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /private-password|private-token|private-bearer/);
        return true;
    });
});

test('Git diagnostics retain the bounded tail and omit terminal control sequences', (t) => {
    const env = fixture(t, `
        process.stderr.write('progress\\n'.repeat(3000) + '\\x1b[31mfatal: final failure\\n');
        process.exit(1);
    `);
    assert.throws(() => runGitCommand(['pull'], { env, stdio: 'pipe' }), error => {
        assert.match(error.stderr, /^\[earlier output omitted\]/);
        assert.match(error.stderr, /fatal: final failure$/);
        assert.ok(error.stderr.length < 8300);
        assert.equal(error.stderr.includes('\x1b'), false);
        return true;
    });
});

test('Git success preserves stdout and Git signals remain errors', (t) => {
    const env = fixture(t, `
        if (process.argv.includes('signal')) process.kill(process.pid, 'SIGTERM');
        else process.stdout.write('actual-branch\\n');
    `);
    assert.equal(String(runGitCommand(['branch'], { env, stdio: 'pipe' })), 'actual-branch\n');
    assert.throws(() => runGitCommand(['signal'], { env, stdio: 'pipe' }), error => {
        assert.equal(error.signal, 'SIGTERM');
        assert.match(error.message, /terminated by SIGTERM/);
        return true;
    });
});

test('Large Git progress output does not change a successful exit into a buffer error', (t) => {
    const env = fixture(t, `
        const fs = require('node:fs');
        fs.writeSync(2, 'progress\\n'.repeat(1200000));
        process.stdout.write('done\\n');
    `);
    assert.equal(String(runGitCommand(['fetch'], { env, stdio: 'pipe' })), 'done\n');
});

test('Truncated credential lines and long unbroken output are omitted before sanitization', (t) => {
    const env = fixture(t, `
        const fs = require('node:fs');
        fs.writeSync(2, 'password=' + 'private-fragment'.repeat(600000) + '\\nfatal: denied\\n');
        process.exit(1);
    `);
    assert.throws(() => runGitCommand(['fetch'], { env, stdio: 'ignore' }), error => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /fatal: denied/);
        assert.doesNotMatch(error.message, /private-fragment/);
        assert.ok(error.stderr.length < 100);
        return true;
    });
});
