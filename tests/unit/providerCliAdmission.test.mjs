import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    normalizeProviderSandboxConfig,
    PROVIDER_NAME_RE,
} from '../../Agent/lib/providerSandboxConfig.mjs';
import {
    admitProviderManifestCli,
    PROVIDER_INTERACTIVE_ADAPTER,
} from '../../cli/utils/providerCliAdmission.js';

test('provider capability is independent of agent name and admits only the canonical adapter', () => {
    for (const provider of ['codex', 'opencode', 'pi']) {
        const config = { providerSandbox: { provider, readiness: true } };
        assert.deepEqual(normalizeProviderSandboxConfig(config), {
            provider,
            readiness: true,
        });
        assert.deepEqual(
            admitProviderManifestCli(PROVIDER_INTERACTIVE_ADAPTER, {
                manifestPath: `/agents/arbitrary-future-agent-${provider}/manifest.json`,
                providerConfig: config,
            }).capability,
            { provider, readiness: true },
        );
        assert.throws(
            () => admitProviderManifestCli('/bin/sh -lc "printf provider-bypass"', {
                manifestPath: `/agents/arbitrary-future-agent-${provider}/manifest.json`,
                providerConfig: config,
            }),
            { code: 'PLOINKY_PROVIDER_CLI_INVALID', status: 409 },
        );
    }
});

test('provider capability uses a capability identifier rather than an exact-three name allowlist', () => {
    const config = {
        providerSandbox: { provider: 'future-provider', readiness: true },
        tools: [{
            name: 'execute-task',
            providerExecution: {
                provider: 'future-provider',
                mode: 'task',
                module: '/code/scripts/execute-task.mjs',
                export: 'executeProviderTask',
            },
        }],
    };
    assert.deepEqual(normalizeProviderSandboxConfig(config), {
        provider: 'future-provider',
        readiness: true,
    });
});

test('non-provider agents retain generic manifest CLI support', () => {
    assert.equal(
        admitProviderManifestCli('/bin/sh -lc "printf generic-agent"', {
            manifestPath: '/agents/generic-agent/manifest.json',
            providerConfig: { tools: [] },
        }).capability,
        null,
    );
});

test('malformed or unknown provider capability fails closed', () => {
    assert.equal(PROVIDER_NAME_RE.test('future-provider'), true);
    for (const providerConfig of [
        { providerSandbox: null },
        { providerSandbox: { provider: 'opencode', readiness: false } },
        { providerSandbox: { provider: '../provider', readiness: true } },
        { providerSandbox: { provider: 'pi', readiness: true, shell: '/bin/sh' } },
    ]) {
        assert.throws(
            () => admitProviderManifestCli(PROVIDER_INTERACTIVE_ADAPTER, {
                manifestPath: '/agents/arbitrary-agent/manifest.json',
                providerConfig,
            }),
            { code: 'PLOINKY_PROVIDER_CONFIG_INVALID', status: 409 },
        );
    }
});

test('provider execution evidence cannot be reclassified as a generic shell agent', () => {
    for (const providerConfig of [
        {
            tools: [{
                name: 'execute-task',
                providerExecution: {
                    provider: 'codex', mode: 'task', module: '/code/x.mjs', export: 'run',
                },
            }],
        },
        {
            endpoints: {
                models: {
                    providerExecution: {
                        provider: 'codex', mode: 'operation', module: '/code/x.mjs', export: 'run',
                    },
                },
            },
        },
    ]) {
        assert.throws(
            () => admitProviderManifestCli('/bin/sh -lc "provider bypass"', {
                manifestPath: '/agents/arbitrary-agent/manifest.json',
                providerConfig,
            }),
            { code: 'PLOINKY_PROVIDER_CONFIG_INVALID', status: 409 },
        );
    }
});

test('provider capability rejects shell drift and cross-provider execution', () => {
    const providerSandbox = { provider: 'codex', readiness: true };
    for (const providerConfig of [
        { providerSandbox, tools: [{ name: 'execute-task', command: '/bin/sh', args: ['-lc', 'id'] }] },
        { providerSandbox, endpoints: { models: { command: '/bin/sh', args: ['-lc', 'id'] } } },
        {
            providerSandbox,
            tools: [{
                name: 'execute-task',
                providerExecution: {
                    provider: 'opencode', mode: 'task', module: '/code/x.mjs', export: 'run',
                },
            }],
        },
    ]) {
        assert.throws(
            () => normalizeProviderSandboxConfig(providerConfig),
            { code: 'PLOINKY_PROVIDER_CONFIG_INVALID' },
        );
    }
});

test('on-disk manifest provider execution cannot outlive a removed sibling capability', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-admission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(path.join(root, 'mcp-config.json'), '{}');
    fs.writeFileSync(manifestPath, JSON.stringify({
        cli: '/bin/sh -lc "provider bypass"',
        endpoints: {
            models: {
                providerExecution: {
                    provider: 'codex', mode: 'operation', module: '/code/x.mjs', export: 'run',
                },
            },
        },
    }));
    assert.throws(
        () => admitProviderManifestCli('/bin/sh -lc "provider bypass"', { manifestPath }),
        { code: 'PLOINKY_PROVIDER_CONFIG_INVALID', status: 409 },
    );
});

test('manifest endpoint metadata cannot overwrite sibling provider execution evidence', () => {
    assert.throws(
        () => admitProviderManifestCli('/bin/sh -lc "provider bypass"', {
            manifestPath: '/agents/arbitrary/manifest.json',
            providerConfig: {
                endpoints: {
                    providerOperation: {
                        providerExecution: {
                            provider: 'codex', mode: 'operation', module: '/code/x.mjs', export: 'run',
                        },
                    },
                },
            },
            providerManifest: {
                cli: '/bin/sh -lc "provider bypass"',
                endpoints: { chatCompletions: { model: 'none' } },
            },
        }),
        { code: 'PLOINKY_PROVIDER_CONFIG_INVALID', status: 409 },
    );
});
