import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const localEntrypoint = path.join(repositoryRoot, 'bin', 'ploinky-local');

function writeExecutable(filePath, source) {
    fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function createRecordedCommand(fakeBin, command, sourceLines) {
    writeExecutable(path.join(fakeBin, command), [
        '#!/bin/sh',
        `printf '${command} %s\\n' "$*" >> "$PLOINKY_PHASE10X_CALLS"`,
        ...sourceLines,
        '',
    ].join('\n'));
}

test('exported ploinky-local rejects Darwin before Node or any runtime probe', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-phase10x-darwin-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fakeBin = path.join(root, 'bin');
    const journal = path.join(root, 'calls.log');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(journal, '');

    createRecordedCommand(fakeBin, 'uname', ['printf \'Darwin\\n\'']);
    for (const command of ['node', 'podman', 'docker', 'buildah', 'bwrap', 'sandbox-exec']) {
        createRecordedCommand(fakeBin, command, ['exit 99']);
    }

    const result = spawnSync(localEntrypoint, ['status'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`,
            PLOINKY_PHASE10X_CALLS: journal,
        },
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /ploinky-local refuses execution outside its managed Linux Box boundary/i,
    );
    assert.equal(fs.readFileSync(journal, 'utf8'), '');
    const source = fs.readFileSync(localEntrypoint, 'utf8');
    assert.match(source, /\/usr\/bin\/uname -s/);
    assert.match(source, /\[\[ "\$PLOINKY_LOCAL_KERNEL" != "Linux" \]\]/);
});

test('exported ploinky-local continues normally on the Linux Box execution plane', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-phase10x-linux-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectRoot = path.join(root, 'project');
    const fakeBin = path.join(root, 'fake-bin');
    const journal = path.join(root, 'calls.log');
    const scriptDirectory = path.join(projectRoot, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(scriptDirectory, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'achillesAgentLib'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'cli'), { recursive: true });

    createRecordedCommand(fakeBin, 'kernel-proof', ['printf \'Linux\\n\'']);
    createRecordedCommand(fakeBin, 'node', ['exit 0']);
    for (const command of ['podman', 'docker', 'buildah']) {
        createRecordedCommand(fakeBin, command, ['exit 99']);
    }

    const testEntrypoint = path.join(scriptDirectory, 'ploinky-local');
    const source = fs.readFileSync(localEntrypoint, 'utf8')
        .replace('/usr/bin/uname', path.join(fakeBin, 'kernel-proof'))
        .replace(
            'SCRIPT_DIR=$(dirname "$(readlink -f "$0")")',
            `SCRIPT_DIR=${JSON.stringify(scriptDirectory)}`,
        );
    writeExecutable(testEntrypoint, source);
    fs.writeFileSync(path.join(projectRoot, 'cli', 'index.js'), '');

    const result = spawnSync(testEntrypoint, ['status', '--fixture'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`,
            PLOINKY_PHASE10X_CALLS: journal,
        },
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(journal, 'utf8').trim().split('\n');
    assert.equal(calls[0], 'kernel-proof -s');
    assert.match(calls[1], /^node .*\/cli\/index\.js status --fixture$/);
    assert.equal(calls.some((call) => /^(?:podman|docker|buildah) /.test(call)), false);
});
