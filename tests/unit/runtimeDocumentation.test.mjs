import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_RUNTIME_CONTRACT } from '../../container/runtime-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('canonical runtime documentation matches the contract-5 hard cut', () => {
    assert.equal(REQUIRED_RUNTIME_CONTRACT, '5');
    const canonicalDocuments = [
        'README.md',
        'docs/specs/DS003-agent-manifest-and-registry.md',
        'docs/specs/DS004-runtime-execution-and-isolation.md',
        'docs/specs/DS007-dependency-caches-and-startup-readiness.md',
        'docs/specs/DS011-security-model.md',
        'docs/code-derived-agent-lifecycle.md',
        'container/README.md',
    ];
    for (const relativePath of canonicalDocuments) {
        const content = read(relativePath);
        assert.match(content, /contract[- ]5|runtime-contract=5/i, relativePath);
        assert.doesNotMatch(content, /runtime-contract=[1-4]/, relativePath);
    }

    const isolationSpec = read('docs/specs/DS004-runtime-execution-and-isolation.md');
    assert.match(isolationSpec, /Every non-contract-5 box[\s\S]*ploinky\s+destroy/);
    assert.doesNotMatch(isolationSpec, /managed router gateway|gateway preflight|gateway namespace proof/);
    assert.match(isolationSpec, /--hosts-file=none[\s\S]*host\.containers\.internal:host-gateway/);
    assert.match(isolationSpec, /RoutingServer\.js[\s\S]*box port `8080`[\s\S]*private listener on `8081`/);
    assert.match(isolationSpec, /127\.0\.0\.1:<selectedRouterHostPort>:8080\/tcp/);
});

test('direct/core cutover documentation uses the explicit old core entry', () => {
    for (const relativePath of [
        'README.md',
        'container/README.md',
        'docs/specs/DS004-runtime-execution-and-isolation.md',
        'docs/code-derived-agent-lifecycle.md',
    ]) {
        const content = read(relativePath);
        assert.match(content, /node cli\/index\.js destroy/, relativePath);
        assert.match(content, /node cli\/index\.js network prune/, relativePath);
        assert.match(content, /public [`']?ploinky[`']? wrapper[\s\S]*outer runtime|outside a managed box[\s\S]*outer supervisor/i, relativePath);
    }
});
