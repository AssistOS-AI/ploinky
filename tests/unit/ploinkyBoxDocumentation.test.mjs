import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('current documentation defines the Box/local command split and outer boundary', () => {
    const documents = {
        readme: read('README.md'),
        index: read('docs/index.html'),
        runtime: read('docs/runtime.html'),
        operations: read('docs/operations.html'),
    };

    for (const [name, document] of Object.entries(documents)) {
        assert.match(document, /ploinky-local/, `${name} omits the local-core command`);
        assert.match(document, /rootless Podman/i, `${name} omits the outer runtime requirement`);
        assert.match(document, /8080/, `${name} omits the in-box Router port`);
        assert.match(document, /8081/, `${name} omits the private unpublished port`);
        assert.match(document, /7882/, `${name} omits the fixed UDP publication`);
    }

    assert.match(documents.readme, /`ploinky` and `p-cli`[\s\S]*?Ploinky Box/);
    assert.match(documents.readme, /`ploinky-local`[\s\S]*?Docker-or-Podman/);
    assert.match(documents.readme, /`psh`[\s\S]*?local core/);
    assert.match(documents.readme, /`ploinky-shell` remains[\s\S]*?local/);
    assert.match(documents.operations, /no image, engine, instance-name, or key-rotation override/);
});

test('Box lifecycle documentation covers identity, retained state, bootstrap, and recovery', () => {
    const combined = [
        read('README.md'),
        read('docs/index.html'),
        read('docs/runtime.html'),
        read('docs/operations.html'),
    ].join('\n');

    for (const requirement of [
        /empty host[\s\S]*?\.ploinky[\s\S]*?identity anchor/i,
        /retained[\s\S]*?named volumes/i,
        /anonymous volumes/i,
        /status[\s\S]*?read-only/i,
        /stop[\s\S]*?dependency/i,
        /master key[\s\S]*?stable/i,
        /in-place rotation[\s\S]*?unsupported/i,
        /distinct[\s\S]*?identity[\s\S]*?empty[\s\S]*?volume/i,
        /hard cut/i,
        /custom host port|custom-port/i,
    ]) {
        assert.match(combined, requirement);
    }
});

test('release documentation names the exact graph and candidate-before-tag gate', () => {
    const operations = read('docs/operations.html');
    const runtime = read('docs/runtime.html');
    const requiredNames = [
        'AssistOSExplorer',
        'webmeetInfra',
        'UmamiAgent',
        'AchillesCLI',
        'proxies',
        'basic',
        'container-image-builds',
    ];

    for (const name of requiredNames) {
        assert.ok(operations.includes(name) || runtime.includes(name), `missing graph member ${name}`);
    }
    assert.match(operations, /Ploinky[\s\S]*?source_ref/);
    assert.match(operations, /candidate[\s\S]*?immutable digest[\s\S]*?runtime[\s\S]*?tag moves/i);
    assert.equal((runtime.match(/<h2>Ploinky Box Runtime Boundary<\/h2>/g) ?? []).length, 1);
    assert.equal((runtime.match(/Default rootless Podman containers use <code>pasta<\/code>/g) ?? []).length, 1);
});
