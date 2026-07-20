import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RESERVED_AGENT_ENV_NAMES } from '../../cli/utils/security/agentIdentityEnv.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';
import { buildLifecycleHookEnv, executeHostHook } from '../../cli/utils/runtime/lifecycleHooks.js';

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

test('host hook receives the generated fallback PLOINKY_MASTER_KEY seed', () => {
    withoutExportedRootOrMaster(() => withTmpWorkspace((dir) => {
        const { hookPath, outPath } = writeMasterProbeHook(dir);
        const result = executeHostHook(hookPath, { HOOK_OUT: outPath }, { cwd: dir });
        assert.equal(result.success, true, result.message);

        const generatedSeed = fs.readFileSync(path.join(dir, '.ploinky', 'master-key'), 'utf8').trim();
        assert.ok(generatedSeed.length > 0);
        assert.equal(fs.readFileSync(outPath, 'utf8'), generatedSeed);
    }));
});

test('host hook preserves an explicitly provided PLOINKY_MASTER_KEY', () => {
    withoutExportedRootOrMaster(() => withTmpWorkspace((dir) => {
        const { hookPath, outPath } = writeMasterProbeHook(dir);
        const result = executeHostHook(
            hookPath,
            { HOOK_OUT: outPath, PLOINKY_MASTER_KEY: 'explicit-master' },
            { cwd: dir }
        );
        assert.equal(result.success, true, result.message);
        assert.equal(fs.readFileSync(outPath, 'utf8'), 'explicit-master');
        assert.equal(fs.existsSync(path.join(dir, '.ploinky', 'master-key')), false);
    }));
});

test('host lifecycle hooks receive authoritative box edge locators after manifest and profile env', () => {
    withTmpWorkspace((dir) => {
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            env: [
                { name: 'PLOINKY_EDGE_TOPOLOGY_FILE', default: '/manifest/spoof.json' },
                { name: 'PLOINKY_ROUTER_URL', default: 'http://manifest.invalid:1' },
                { name: 'PLOINKY_INTERNAL_ROUTER_URL', default: 'http://manifest.invalid:2' },
            ],
        }));
        const identity = { PLOINKY_AGENT_ID: 'agent:demo/fixture' };
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
                PLOINKY_INTERNAL_ROUTER_URL: 'http://profile.invalid:2',
            },
        });
        const expectedTopology = path.join(
            PLOINKY_WORKSPACE_ROOT,
            '.ploinky',
            'run',
            'edge-topology',
            'current.json',
        );

        for (const env of [manifestEnv, profileEnv]) {
            assert.equal(env.PLOINKY_EDGE_TOPOLOGY_FILE, expectedTopology);
            assert.equal(env.PLOINKY_ROUTER_URL, 'http://127.0.0.1:8080');
            assert.equal(env.PLOINKY_INTERNAL_ROUTER_URL, 'http://127.0.0.1:8081');
            assert.equal(env.PLOINKY_AGENT_ID, identity.PLOINKY_AGENT_ID);
        }
        for (const name of [
            'PLOINKY_EDGE_TOPOLOGY_FILE',
            'PLOINKY_ROUTER_URL',
            'PLOINKY_INTERNAL_ROUTER_URL',
        ]) {
            assert.ok(RESERVED_AGENT_ENV_NAMES.includes(name), `${name} must be reserved`);
        }
    });
});
