import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    BOX_MARKER_CONTENT,
    BOX_READY_LINE,
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
        assert.match(
            content,
            /0\.0\.0\.0:<(?:selectedMediaHostPort|selected-media-host-port)>:7882\/udp/,
            relativePath,
        );
        assert.doesNotMatch(content, /io\.assistos\.ploinky\.runtime-contract/, relativePath);
        assert.doesNotMatch(content, /io\.assistos\.ploinky\.identity-schema/, relativePath);
        assert.doesNotMatch(content, /contract[- ](?:v)?[56]|runtime[- ]v[56]/i, relativePath);
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
