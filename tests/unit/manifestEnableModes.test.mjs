import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    DEFAULT_ENABLE_AGENT_MODE,
    ENABLE_AGENT_MODES,
    resolveManifestEnableModes,
    resolveRequestedEnableMode,
} from '../../cli/utils/agents.js';

test('a manifest without enableModes keeps every mode with the isolated default', () => {
    assert.deepEqual(resolveManifestEnableModes({ container: 'node:22' }), {
        modes: [...ENABLE_AGENT_MODES],
        defaultMode: DEFAULT_ENABLE_AGENT_MODE,
    });
    assert.equal(resolveRequestedEnableMode({}, undefined, 'repo/agent'), 'isolated');
    assert.equal(resolveRequestedEnableMode({}, 'global', 'repo/agent'), 'global');
});

test('manifest enableModes narrows the modes and its first entry is the default', () => {
    const manifest = { enableModes: ['global', 'devel'] };
    assert.deepEqual(resolveManifestEnableModes(manifest), { modes: ['global', 'devel'], defaultMode: 'global' });
    assert.equal(resolveRequestedEnableMode(manifest, undefined, 'repo/agent'), 'global');
    assert.equal(resolveRequestedEnableMode(manifest, '', 'repo/agent'), 'global');
    assert.equal(resolveRequestedEnableMode(manifest, 'default', 'repo/agent'), 'global');
    assert.equal(resolveRequestedEnableMode(manifest, 'DEVEL', 'repo/agent'), 'devel');
});

test('an explicit mode outside manifest enableModes is rejected', () => {
    assert.throws(
        () => resolveRequestedEnableMode({ enableModes: ['global'] }, 'isolated', 'repo/agent'),
        {
            code: 'PLOINKY_AGENT_ENABLE_MODE_UNSUPPORTED',
            message: "Agent 'repo/agent' does not support mode 'isolated'. Allowed: global",
        },
    );
});

test('an unknown requested mode is left for the full-mode-list error', () => {
    assert.equal(resolveRequestedEnableMode({ enableModes: ['global'] }, 'bogus', 'repo/agent'), 'bogus');
});

test('invalid manifest enableModes declarations are rejected', () => {
    for (const enableModes of [[], 'global', ['global', 'global'], ['shared'], [null], {}]) {
        assert.throws(
            () => resolveManifestEnableModes({ enableModes }),
            { code: 'PLOINKY_MANIFEST_ENABLE_MODES_INVALID' },
            JSON.stringify(enableModes),
        );
    }
});

test('enable planning resolves the run mode through the manifest enable modes', () => {
    const source = fs.readFileSync(new URL('../../cli/utils/agents.js', import.meta.url), 'utf8');
    assert.match(source, /const normalizedMode = resolveRequestedEnableMode\(manifest, normalized\.mode,/);
});

test('Marketplace workers pass an explicit isolated mode instead of the manifest default', () => {
    const worker = fs.readFileSync(new URL('../../cli/server/marketplaceEnableWorkerThread.js', import.meta.url), 'utf8');
    assert.doesNotMatch(worker, /mode === 'isolated' \? undefined/);
});
