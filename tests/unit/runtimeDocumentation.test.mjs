import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    BOX_MARKER_CONTENT,
    BOX_READY_LINE,
    BOX_TMPFS,
} from '../../ploinky-box/constants.mjs';
import {
    DEPENDENCY_MARKER_NAME,
} from '../../ploinky-box/entrypoint/install-dependencies.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('active runtime documentation describes the semantic Box configuration', () => {
    assert.equal(BOX_MARKER_CONTENT, 'assistos/ploinky-box\n');
    assert.equal(BOX_READY_LINE, 'PLOINKY_BOX_READY');
    assert.deepEqual(BOX_TMPFS, {
        destination: '/tmp',
        options: ['rw', 'exec', 'nosuid', 'nodev', 'mode=1777', 'notmpcopyup'],
    });
    assert.equal(DEPENDENCY_MARKER_NAME, '.ploinky-box-dependencies.json');
    const runtimeDocuments = [
        'README.md',
        'docs/code-derived-agent-lifecycle.md',
        'container/README.md',
    ];
    for (const relativePath of runtimeDocuments) {
        const content = read(relativePath);
        assert.match(content, /assistos\/ploinky-box/, relativePath);
        assert.match(content, /127\.0\.0\.1:[^`\n]*:8080\/tcp/, relativePath);
        // The selected media UDP port is published to the same in-Box port (default 7882).
        assert.match(
            content,
            /0\.0\.0\.0:<(?:selectedMediaHostPort|selected-media-host-port)>:<(?:selectedMediaHostPort|selected-media-host-port)>\/udp/,
            relativePath,
        );
        assert.doesNotMatch(
            content,
            /0\.0\.0\.0:<(?:selectedMediaHostPort|selected-media-host-port)>:7882\/udp/,
            relativePath,
        );
        assert.doesNotMatch(content, /io\.assistos\.ploinky\.runtime-contract/, relativePath);
        assert.doesNotMatch(content, /io\.assistos\.ploinky\.identity-schema/, relativePath);
        assert.doesNotMatch(content, /contract[- ](?:v)?[56]|runtime[- ]v[56]/i, relativePath);
        assert.doesNotMatch(
            content,
            /container\/(?:runtime-(?:supervisor|contract|engine)|smoke-runtime)\.mjs/,
            relativePath,
        );
        assert.doesNotMatch(content, /three (?:managed |explicitly )?named volumes/i, relativePath);
        assert.doesNotMatch(content, /retained workspace-volume/i, relativePath);
        assert.match(content, /four durable (?:host )?binds/i, relativePath);
        assert.match(
            content,
            /rw,exec,nosuid,nodev,mode=1777,notmpcopyup/,
            relativePath,
        );
        assert.match(content, /(?:transient )?`?\/tmp`? tmpfs/i, relativePath);
    }
});

test('active runtime documentation separates durable caches from disposable nested state', () => {
    for (const relativePath of [
        'README.md',
        'docs/code-derived-agent-lifecycle.md',
        'container/README.md',
    ]) {
        // Match against unwrapped prose so line breaks cannot hide a claim.
        const content = read(relativePath).replace(/\s+/g, ' ');
        // The image cache is the only reusable nested storage.
        assert.match(content, /ploinky-images/, relativePath);
        assert.match(content, /\/opt\/ploinky\/node_modules/, relativePath);
        // Nested container state is disposable, so agent data belongs in binds.
        assert.match(
            content,
            /persistent agent data must use explicit `\/workspace` binds/i,
            relativePath,
        );
        assert.match(content, /discarded (?:with|when) the outer/i, relativePath);
        // No active document may still promise the broad nested store survives.
        assert.doesNotMatch(content, /two named storage volumes/i, relativePath);
        assert.doesNotMatch(content, /deliberately preserves it/i, relativePath);
        assert.doesNotMatch(
            content,
            /storage-run-1000[^.]{0,80}(?:survives|persists)[^.]{0,30}stop/i,
            relativePath,
        );
    }
});

test('direct/core cutover documentation uses the explicit old core entry', () => {
    for (const relativePath of [
        'README.md',
        'container/README.md',
        'docs/code-derived-agent-lifecycle.md',
    ]) {
        const content = read(relativePath);
        assert.match(content, /node cli\/index\.js destroy/, relativePath);
        assert.match(content, /node cli\/index\.js network prune/, relativePath);
        assert.match(content, /public [`']?ploinky[`']? wrapper[\s\S]*outer runtime|outside a managed box[\s\S]*outer supervisor/i, relativePath);
    }
});
