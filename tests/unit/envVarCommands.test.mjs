import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const harness = fileURLToPath(new URL('../fixtures/exposeCommandHarness.mjs', import.meta.url));

function expose(input) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', harness, JSON.stringify(input)], {
        encoding: 'utf8',
        timeout: 10_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
}

for (const scenario of [
    { name: 'missing target', commands: [['TOKEN', '$VALUE']], error: /Missing agent name/ },
    { name: 'unknown target', commands: [['TOKEN', '$VALUE', 'typo']], error: /Agent 'typo' not found/ },
    { name: 'missing manifest', commands: [['TOKEN', '$VALUE', 'demo']], missingManifest: true, error: /ENOENT/ },
    { name: 'malformed JSON', commands: [['TOKEN', '$VALUE', 'demo']], manifestBytes: '{', error: /JSON/ },
    { name: 'non-object manifest', commands: [['TOKEN', '$VALUE', 'demo']], manifestBytes: 'null', error: /JSON object/ },
    { name: 'invalid expose shape', commands: [['TOKEN', '$VALUE', 'demo']], manifest: { expose: 'invalid' }, error: /array or object/ },
]) {
    test(`expose preserves active routes and manifest bytes for ${scenario.name}`, () => {
        const result = expose(scenario);
        assert.match(result.errors[0], scenario.error);
        assert.equal(result.selector.state, 'active');
        assert.equal(result.trace.includes('inactivate'), false);
        assert.equal(result.trace.includes('write'), false);
        assert.equal(result.manifestBytes, scenario.missingManifest ? null : result.originalBytes);
    });
}

for (const manifestBytes of [
    '{ "expose": [ { "ref": "VALUE", "name": "TOKEN" }, { "name": "OTHER", "value": "kept" } ] }\n',
    '{ "expose": { "TOKEN": "$VALUE", "OTHER": "kept" } }\n',
]) {
    test(`expose preserves exact bytes for repeated ${manifestBytes.includes('[') ? 'array' : 'object'} declaration`, () => {
        const result = expose({
            manifestBytes,
            commands: [['TOKEN', '$VALUE', 'demo'], ['TOKEN', '$VALUE', 'demo']],
        });
        assert.deepEqual(result.errors, [null, null]);
        assert.equal(result.selector.state, 'active');
        assert.equal(result.manifestBytes, manifestBytes);
        assert.equal(result.trace.includes('assert-active'), false);
        assert.equal(result.trace.includes('inactivate'), false);
        assert.equal(result.trace.includes('write'), false);
    });
}

test('expose removal of an absent name does not add an empty expose field or invalidate routes', () => {
    const result = expose({ commands: [['TOKEN', '', 'demo']] });
    assert.deepEqual(result.errors, [null]);
    assert.equal(result.selector.state, 'active');
    assert.equal(result.manifestBytes, result.originalBytes);
    assert.equal(result.trace.includes('write'), false);
});

test('expose validates, invalidates, and writes under the same lock only once for an idempotent change', () => {
    const result = expose({
        manifest: { expose: [{ name: 'TOKEN', ref: 'OLD' }, { name: 'OTHER', value: 'kept' }] },
        commands: [['TOKEN', '$VALUE', 'demo'], ['TOKEN', '$VALUE', 'demo']],
    });
    assert.deepEqual(result.errors, [null, null]);
    assert.equal(result.selector.state, 'inactive');
    assert.deepEqual(result.trace, [
        'lock-enter', 'validate-agent:demo', 'assert-active', 'inactivate', 'write', 'lock-exit',
        'lock-enter', 'validate-agent:demo', 'lock-exit',
    ]);
    assert.deepEqual(JSON.parse(result.manifestBytes).expose, [
        { name: 'OTHER', value: 'kept' }, { name: 'TOKEN', ref: 'VALUE' },
    ]);
});

test('expose deduplicates ambiguous repeated declarations instead of treating them as a no-op', () => {
    const result = expose({
        manifest: { expose: [{ name: 'TOKEN', ref: 'VALUE' }, { name: 'TOKEN', ref: 'VALUE' }] },
        commands: [['TOKEN', '$VALUE', 'demo']],
    });
    assert.deepEqual(result.errors, [null]);
    assert.equal(result.selector.state, 'inactive');
    assert.deepEqual(JSON.parse(result.manifestBytes).expose, [{ name: 'TOKEN', ref: 'VALUE' }]);
    assert.equal(result.trace.filter(event => event === 'write').length, 1);
});

for (const failure of ['failSourceCheck', 'failInvalidation']) {
    test(`expose does not write when ${failure} rejects the change`, () => {
        const result = expose({ [failure]: true, commands: [['TOKEN', '$VALUE', 'demo']] });
        assert.match(result.errors[0], /fixture/);
        assert.equal(result.selector.state, 'active');
        assert.equal(result.trace.includes('write'), false);
        assert.equal(result.manifestBytes, result.originalBytes);
    });
}

test('expose stays fail-closed if the validated manifest write fails', () => {
    const result = expose({ failWrite: true, commands: [['TOKEN', '$VALUE', 'demo']] });
    assert.match(result.errors[0], /fixture write rejected/);
    assert.equal(result.selector.state, 'inactive');
    assert.equal(result.manifestBytes, result.originalBytes);
    assert.ok(result.trace.indexOf('inactivate') < result.trace.indexOf('write'));
});
