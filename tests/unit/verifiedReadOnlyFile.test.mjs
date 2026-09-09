import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ensureVerifiedProducerDirectory,
    openVerifiedRegularFile,
    readVerifiedJsonObject,
} from '../../cli/utils/verifiedReadOnlyFile.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-verified-read-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('verified JSON accepts the exact byte boundary and rejects one byte more', (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'exact.json'), '{"ok":true}');
    fs.writeFileSync(path.join(root, 'large.json'), '{"ok":true} ');

    assert.deepEqual(readVerifiedJsonObject({
        trustedRoot: root,
        relativeSegments: ['exact.json'],
        byteLimit: 11,
        absent: null,
    }), { ok: true });
    assert.throws(() => readVerifiedJsonObject({
        trustedRoot: root,
        relativeSegments: ['large.json'],
        byteLimit: 11,
        absent: null,
    }), (error) => error.code === 'VERIFIED_FILE_INVALID' && /byte limit/.test(error.message));
});

test('verified JSON rejects empty, malformed, and non-object documents', (t) => {
    const root = fixture(t);
    const values = new Map([
        ['empty.json', ''],
        ['malformed.json', '{"secret":"do-not-echo"'],
        ['array.json', '[]'],
        ['null.json', 'null'],
    ]);
    for (const [name, value] of values) fs.writeFileSync(path.join(root, name), value);
    for (const [name] of values) {
        assert.throws(
            () => readVerifiedJsonObject({
                trustedRoot: root,
                relativeSegments: [name],
                byteLimit: 1024,
                absent: null,
            }),
            (error) => error.code === 'VERIFIED_FILE_INVALID'
                && !error.message.includes('do-not-echo'),
            name,
        );
    }
});

test('verified JSON bounds nesting and total object nodes iteratively', (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'deep.json'), `{"value":${'['.repeat(65)}{}${']'.repeat(65)}}`);
    fs.writeFileSync(path.join(root, 'wide.json'), JSON.stringify({ values: [{}, {}, {}, {}] }));

    assert.throws(() => readVerifiedJsonObject({
        trustedRoot: root,
        relativeSegments: ['deep.json'],
        byteLimit: 4096,
        maxDepth: 64,
        absent: null,
    }), /depth limit/);
    assert.throws(() => readVerifiedJsonObject({
        trustedRoot: root,
        relativeSegments: ['wide.json'],
        byteLimit: 4096,
        maxNodes: 4,
        absent: null,
    }), /node limit/);
});

test('verified opens follow directory symlinks while rejecting symlinked files', (t) => {
    const root = fixture(t);
    const outside = fixture(t);
    fs.writeFileSync(path.join(outside, 'state.json'), '{}');

    const linkedRoot = path.join(root, 'linked-root');
    fs.symlinkSync(outside, linkedRoot);
    const linked = openVerifiedRegularFile({ trustedRoot: linkedRoot, relativeSegments: ['state.json'] });
    assert.equal(fs.readFileSync(linked.descriptor, 'utf8'), '{}');
    fs.closeSync(linked.descriptor);

    fs.mkdirSync(path.join(root, 'safe'));
    fs.symlinkSync(outside, path.join(root, 'safe', 'linked-parent'));
    const nested = openVerifiedRegularFile({
        trustedRoot: root,
        relativeSegments: ['safe', 'linked-parent', 'state.json'],
    });
    assert.equal(fs.readFileSync(nested.descriptor, 'utf8'), '{}');
    fs.closeSync(nested.descriptor);

    fs.symlinkSync(path.join(outside, 'state.json'), path.join(root, 'state.json'));
    assert.throws(
        () => openVerifiedRegularFile({ trustedRoot: root, relativeSegments: ['state.json'] }),
        (error) => error.code === 'VERIFIED_FILE_INVALID',
    );

});

test('verified reads reject inode replacement, truncation, and growth and close descriptors', (t) => {
    const root = fixture(t);
    const target = path.join(root, 'state.json');
    fs.writeFileSync(target, '{"ok":true}');
    const replacement = path.join(root, 'replacement.json');
    fs.writeFileSync(replacement, '{"other":true}');

    let closed = 0;
    const swappedFs = {
        ...fs,
        constants: fs.constants,
        lstatSync(name) {
            const stat = fs.lstatSync(name);
            if (name === target) fs.renameSync(replacement, target);
            return stat;
        },
        closeSync(fd) { closed += 1; return fs.closeSync(fd); },
    };
    assert.throws(
        () => openVerifiedRegularFile({ trustedRoot: root, relativeSegments: ['state.json'], fsApi: swappedFs }),
        /replaced during validation/,
    );
    assert.equal(closed, 1);

    for (const mutation of ['truncate', 'grow']) {
        fs.writeFileSync(target, '{"ok":true}');
        let reads = 0;
        let closes = 0;
        const mutatingFs = {
            ...fs,
            constants: fs.constants,
            readSync(fd, buffer, offset, length, position) {
                const count = fs.readSync(fd, buffer, offset, length, position);
                reads += 1;
                if (reads === 1) {
                    if (mutation === 'truncate') fs.truncateSync(target, 2);
                    else fs.appendFileSync(target, ' ');
                }
                return count;
            },
            closeSync(fd) { closes += 1; return fs.closeSync(fd); },
        };
        assert.throws(() => readVerifiedJsonObject({
            trustedRoot: root,
            relativeSegments: ['state.json'],
            byteLimit: 1024,
            absent: null,
            fsApi: mutatingFs,
        }), /changed during read/);
        assert.equal(closes, 1, mutation);
    }
});

test('absence is caller-selected and every successful descriptor can be closed', (t) => {
    const root = fixture(t);
    const sentinel = Object.freeze({ missing: true });
    assert.equal(readVerifiedJsonObject({
        trustedRoot: root,
        relativeSegments: ['missing.json'],
        byteLimit: 32,
        absent: sentinel,
    }), sentinel);

    fs.writeFileSync(path.join(root, 'state.json'), '{}');
    const opened = openVerifiedRegularFile({ trustedRoot: root, relativeSegments: ['state.json'] });
    assert.ok(opened.descriptor >= 0);
    fs.closeSync(opened.descriptor);
});

test('producer directories create a private leaf without changing parent permissions', (t) => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'logs'), { mode: 0o700 });
    const created = ensureVerifiedProducerDirectory({
        trustedRoot: root,
        relativeSegments: ['logs', 'agents'],
    });
    assert.equal(created, path.join(root, 'logs', 'agents'));
    assert.equal(fs.statSync(created).mode & 0o777, 0o700);

    fs.chmodSync(path.join(root, 'logs'), 0o777);
    ensureVerifiedProducerDirectory({
        trustedRoot: root,
        relativeSegments: ['logs', 'other'],
    });
    assert.equal(fs.statSync(path.join(root, 'logs')).mode & 0o777, 0o777);
    assert.equal(fs.statSync(path.join(root, 'logs', 'other')).mode & 0o777, 0o700);
});

test('producer directories follow symlinked parents and reject missing parents', (t) => {
    const root = fixture(t);
    const outside = fixture(t);
    fs.symlinkSync(outside, path.join(root, 'logs'));
    ensureVerifiedProducerDirectory({
        trustedRoot: root,
        relativeSegments: ['logs', 'agents'],
    });
    assert.equal(fs.statSync(path.join(outside, 'agents')).isDirectory(), true);

    fs.unlinkSync(path.join(root, 'logs'));
    assert.throws(() => ensureVerifiedProducerDirectory({
        trustedRoot: root,
        relativeSegments: ['logs', 'agents'],
    }), /parent .* does not exist/);
});
