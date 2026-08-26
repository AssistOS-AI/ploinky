import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Lifecycle environment modules resolve config paths at import time. Keep
// their secrets fixture out of any ancestor ~/.ploinky owned by the developer.
const isolatedConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-hosthook-config-'));
process.env.PLOINKY_WORKSPACE_ROOT = isolatedConfigRoot;
process.once('exit', () => fs.rmSync(isolatedConfigRoot, { recursive: true, force: true }));

const { RESERVED_AGENT_ENV_NAMES } = await import('../../cli/utils/security/agentIdentityEnv.js');
const { buildLifecycleHookEnv, executeHostHook } = await import('../../cli/utils/runtime/lifecycleHooks.js');

// Host hooks (preinstall, hosthook_aftercreation, hosthook_postinstall) run on the
// HOST before the container exists, so the container-only PLOINKY_WORKSPACE_ROOT
// injection has not happened yet. These tests pin the contract that host hooks can
// still resolve the workspace root via PLOINKY_WORKSPACE_ROOT.

function withTmpWorkspace(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-hosthook-env-'));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// A probe hook that records the PLOINKY_WORKSPACE_ROOT it observes into $HOOK_OUT.
function writeProbeHook(dir) {
    const hookPath = path.join(dir, 'probe.sh');
    const outPath = path.join(dir, 'seen.txt');
    fs.writeFileSync(
        hookPath,
        '#!/usr/bin/env bash\nprintf "%s" "${PLOINKY_WORKSPACE_ROOT:-UNSET}" > "$HOOK_OUT"\n'
    );
    return { hookPath, outPath };
}

function writeMasterProbeHook(dir) {
    const hookPath = path.join(dir, 'master-probe.sh');
    const outPath = path.join(dir, 'master-seen.txt');
    fs.writeFileSync(
        hookPath,
        '#!/usr/bin/env bash\nprintf "%s" "${PLOINKY_MASTER_KEY:-UNSET}" > "$HOOK_OUT"\n'
    );
    return { hookPath, outPath };
}

function writeAgentLibProbeHook(dir) {
    const hookPath = path.join(dir, 'agent-lib-probe.sh');
    const outPath = path.join(dir, 'agent-lib-seen.txt');
    fs.writeFileSync(
        hookPath,
        '#!/usr/bin/env bash\nprintf "%s" "${PLOINKY_AGENT_LIB_DIR:-UNSET}" > "$HOOK_OUT"\n'
    );
    return { hookPath, outPath };
}

function withoutExportedRoot(fn) {
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    delete process.env.PLOINKY_WORKSPACE_ROOT; // mirror a normal `ploinky start`
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
    }
}

function withoutExportedRootOrMaster(fn) {
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousMaster = process.env.PLOINKY_MASTER_KEY;
    delete process.env.PLOINKY_WORKSPACE_ROOT;
    delete process.env.PLOINKY_MASTER_KEY;
    try {
        return fn();
    } finally {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        if (previousMaster === undefined) delete process.env.PLOINKY_MASTER_KEY;
        else process.env.PLOINKY_MASTER_KEY = previousMaster;
    }
}

test('host hook receives PLOINKY_WORKSPACE_ROOT defaulted to the workspace cwd', () => {
    withoutExportedRoot(() => withTmpWorkspace((dir) => {
        const { hookPath, outPath } = writeProbeHook(dir);
        const result = executeHostHook(hookPath, { HOOK_OUT: outPath }, { cwd: dir });
        assert.equal(result.success, true, result.message);
        assert.equal(fs.readFileSync(outPath, 'utf8'), dir);
    }));
});

test('host hook does not override an explicitly provided PLOINKY_WORKSPACE_ROOT', () => {
    withoutExportedRoot(() => withTmpWorkspace((dir) => {
        const explicit = path.join(dir, 'explicit-root');
        fs.mkdirSync(explicit);
        const { hookPath, outPath } = writeProbeHook(dir);
        const result = executeHostHook(
            hookPath,
            { HOOK_OUT: outPath, PLOINKY_WORKSPACE_ROOT: explicit },
            { cwd: dir }
        );
        assert.equal(result.success, true, result.message);
        assert.equal(fs.readFileSync(outPath, 'utf8'), explicit);
    }));
});

test('host hook replaces a container-only agent library path with the host Agent tree', () => {
    withTmpWorkspace((dir) => {
        const { hookPath, outPath } = writeAgentLibProbeHook(dir);
        const result = executeHostHook(
            hookPath,
            { HOOK_OUT: outPath, PLOINKY_AGENT_LIB_DIR: '/Agent' },
            { cwd: dir }
        );
        assert.equal(result.success, true, result.message);
        assert.equal(
            fs.readFileSync(outPath, 'utf8'),
            path.resolve(import.meta.dirname, '../../Agent'),
        );
        assert.ok(RESERVED_AGENT_ENV_NAMES.includes('PLOINKY_AGENT_LIB_DIR'));
    });
});

test('host hook does not create or receive a fallback PLOINKY_MASTER_KEY seed', () => {
    withoutExportedRootOrMaster(() => withTmpWorkspace((dir) => {
        const { hookPath, outPath } = writeMasterProbeHook(dir);
        const result = executeHostHook(hookPath, { HOOK_OUT: outPath }, { cwd: dir });
        assert.equal(result.success, true, result.message);

        assert.equal(fs.existsSync(path.join(dir, '.ploinky', 'master-key')), false);
        assert.equal(fs.readFileSync(outPath, 'utf8'), 'UNSET');
    }));
});

test('host hook strips an explicitly provided PLOINKY_MASTER_KEY', () => {
    withoutExportedRootOrMaster(() => withTmpWorkspace((dir) => {
        const { hookPath, outPath } = writeMasterProbeHook(dir);
        const result = executeHostHook(
            hookPath,
            { HOOK_OUT: outPath, PLOINKY_MASTER_KEY: 'explicit-master' },
            { cwd: dir }
        );
        assert.equal(result.success, true, result.message);
        assert.equal(fs.readFileSync(outPath, 'utf8'), 'UNSET');
        assert.equal(fs.existsSync(path.join(dir, '.ploinky', 'master-key')), false);
    }));
});

test('host lifecycle hooks remain principal-only after manifest, profile, and identity injection', () => {
    withTmpWorkspace((dir) => {
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            env: [
                { name: 'PLOINKY_EDGE_TOPOLOGY_FILE', default: '/manifest/spoof.json' },
                { name: 'PLOINKY_ROUTER_URL', default: 'http://manifest.invalid:1' },
                { name: 'PLOINKY_ROUTER_AUTHORITY', default: 'attacker.invalid:1' },
                { name: 'PLOINKY_INTERNAL_ROUTER_URL', default: 'http://manifest.invalid:2' },
            ],
        }));
        const identity = {
            PLOINKY_AGENT_ID: 'agent:demo/fixture',
            PLOINKY_AGENT_PRINCIPAL: 'agent:demo/fixture',
            PLOINKY_AGENT_API_KEY: 'forbidden-api-key',
            PLOINKY_AGENT_SECRET: 'forbidden-request-secret',
            PLOINKY_AGENT_PRIVATE_SECRET: 'forbidden-private-secret',
            PLOINKY_AGENT_API_PUBLIC_KEY: 'forbidden-trust-anchor',
            PLOINKY_ROUTER_DESCRIPTOR_FILE: '/forbidden/descriptor.json',
        };
        const build = (profileConfig) => buildLifecycleHookEnv({
            agentName: 'fixture',
            repoName: 'demo',
            profileName: 'default',
            profileConfig,
            agentPath: dir,
        }, {
            buildIdentityEnv() { return identity; },
        });

        const manifestEnv = build({});
        const profileEnv = build({
            env: {
                PLOINKY_EDGE_TOPOLOGY_FILE: '/profile/spoof.json',
                PLOINKY_ROUTER_URL: 'http://profile.invalid:1',
                PLOINKY_ROUTER_AUTHORITY: 'attacker.invalid:2',
                PLOINKY_INTERNAL_ROUTER_URL: 'http://profile.invalid:2',
            },
        });
        for (const env of [manifestEnv, profileEnv]) {
            assert.equal(env.PLOINKY_AGENT_ID, identity.PLOINKY_AGENT_ID);
            assert.equal(env.PLOINKY_AGENT_PRINCIPAL, identity.PLOINKY_AGENT_PRINCIPAL);
            for (const name of [
                'PLOINKY_MASTER_KEY',
                'PLOINKY_AGENT_API_KEY',
                'PLOINKY_AGENT_SECRET',
                'PLOINKY_AGENT_PRIVATE_SECRET',
                'PLOINKY_AGENT_API_PUBLIC_KEY',
                'PLOINKY_ROUTER_DESCRIPTOR_FILE',
                'PLOINKY_EDGE_TOPOLOGY_FILE',
                'PLOINKY_ROUTER_URL',
                'PLOINKY_ROUTER_AUTHORITY',
                'PLOINKY_INTERNAL_ROUTER_URL',
            ]) assert.equal(env[name], undefined, `${name} must not exist before attestation`);
        }
        for (const name of [
            'PLOINKY_EDGE_TOPOLOGY_FILE',
            'PLOINKY_ROUTER_URL',
            'PLOINKY_ROUTER_AUTHORITY',
            'PLOINKY_INTERNAL_ROUTER_URL',
        ]) {
            assert.ok(RESERVED_AGENT_ENV_NAMES.includes(name), `${name} must be reserved`);
        }
    });
});

test('executed host hook observes no inherited or caller-supplied key, descriptor, trust, or Router state', () => {
    withTmpWorkspace((dir) => {
        const hookPath = path.join(dir, 'env-probe.sh');
        const outPath = path.join(dir, 'env-seen.txt');
        fs.writeFileSync(hookPath, '#!/usr/bin/env bash\nenv | LC_ALL=C sort > "$HOOK_OUT"\n');
        const sensitive = {
            PLOINKY_MASTER_KEY: 'master',
            PLOINKY_AGENT_API_KEY: 'api',
            PLOINKY_AGENT_SECRET: 'request',
            PLOINKY_AGENT_PRIVATE_SECRET: 'private',
            PLOINKY_AGENT_API_PUBLIC_KEY: 'trust',
            PLOINKY_ROUTER_DESCRIPTOR_FILE: '/descriptor',
            PLOINKY_EDGE_TOPOLOGY_FILE: '/topology',
            PLOINKY_ROUTER_URL: 'http://router.invalid',
            PLOINKY_INTERNAL_ROUTER_URL: 'http://router.invalid/internal',
        };
        const previous = Object.fromEntries(Object.keys(sensitive).map((name) => [name, process.env[name]]));
        Object.assign(process.env, sensitive);
        try {
            const result = executeHostHook(hookPath, {
                ...sensitive,
                HOOK_OUT: outPath,
                PLOINKY_AGENT_ID: 'agent:demo/fixture',
                PLOINKY_AGENT_PRINCIPAL: 'agent:demo/fixture',
            }, { cwd: dir });
            assert.equal(result.success, true, result.message);
            const observed = fs.readFileSync(outPath, 'utf8');
            for (const name of Object.keys(sensitive)) {
                assert.doesNotMatch(observed, new RegExp(`^${name}=`, 'm'), `${name} leaked to executed hook`);
            }
            assert.match(observed, /^PLOINKY_AGENT_ID=agent:demo\/fixture$/m);
            assert.match(observed, /^PLOINKY_AGENT_PRINCIPAL=agent:demo\/fixture$/m);
        } finally {
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
});
