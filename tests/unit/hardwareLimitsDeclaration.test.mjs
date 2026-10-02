// The neutral `hardwareLimits` declaration (plan amendment A2): schema,
// layering, conflicts, deprecation of llmRuntime.runtimePolicy.resources,
// profile resolution through the production resolver, refusal parity,
// identity of hashes and rendered arguments, and no restart on migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

// Graph preflight reads the workspace from the process; set it before the
// modules that resolve workspace paths are loaded.
const originalCwd = process.cwd();
const originalEnv = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
};
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-declaration-')));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '8080';
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
const markerPath = path.join(workspace, 'box-marker');
fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
const box = { boxMarkerOptions: { markerPath }, workspaceRoot: workspace };

const base = { container: 'node:20-alpine', network: { mode: 'default' } };
const OLD = (resources, extra = {}) => ({ ...base, llmRuntime: { runtimePolicy: { resources } }, ...extra });
const NEW = (hardwareLimits, extra = {}) => ({ ...base, hardwareLimits, ...extra });

function writeManifest(repo, agent, manifest) {
    const directory = path.join(workspace, '.ploinky', 'repos', repo, agent);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return path.join(directory, 'manifest.json');
}
// Two equivalent graphs: one declares through the deprecated path, one
// through hardwareLimits; each root needs its limited child, which needs
// its limited grandchild.
for (const [repo, make] of [['oldpath', OLD], ['neutral', NEW]]) {
    writeManifest(repo, 'root', { ...base, enable: [`${repo}/needy`, `${repo}/plain`] });
    writeManifest(repo, 'needy', { ...make({ memory: '512m', pidsLimit: 64 }), enable: [`${repo}/grand`] });
    writeManifest(repo, 'grand', make({ cpus: '1' }));
    writeManifest(repo, 'plain', base);
}
writeManifest('clash', 'root', { ...base, enable: ['clash/needy', 'clash/plain'] });
writeManifest('clash', 'needy', NEW({ memory: '512m' }, { llmRuntime: { runtimePolicy: { resources: { memory: '256m' } } } }));
writeManifest('clash', 'plain', base);

const runtimeCapabilities = await import('../../cli/sandbox/runtimeCapabilities.js');
const { emitRunArgs, computeRuntimePolicyHash, RuntimePolicyError } = await import('../../cli/sandbox/docker/containerRuntimePolicy.js');
const { resolveManifestRuntimeProfile } = await import('../../cli/utils/runtime/profileService.js');
const declared = await import('../../cli/sandbox/hardwareLimits/declaredLimits.mjs');
const errors = await import('../../cli/sandbox/hardwareLimits/errors.mjs');
const interactiveModule = await import('../../cli/sandbox/docker/interactive.js');
const { assertInteractiveHardwareLimitsAbsent } = interactiveModule;
const { computeEnvHash } = await import('../../cli/sandbox/docker/common.js');
const { prepareLlmStartup, resolveLlmRuntimeAdmissionContext } = await import('../../cli/sandbox/docker/llmRuntimeIntegration.js');
const { detectHardware } = await import('../../cli/sandbox/docker/hardwareDetection.js');
const serviceManager = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { buildHardwareLimitsState } = await import('../../cli/server/authHandlers/hardwareLimitsRoutes.mjs');
const workspaceUtil = await import('../../cli/commands/workspaceUtil.js');

const {
    admitManifestRuntimeCapabilities,
    createHardwareLaunchGuard,
    hardwareLimitsHashOf,
    hardwareRefusalOf,
    renderRuntimePolicyArgs,
    validateManifestRuntimeCapabilities,
} = runtimeCapabilities;

test.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    declared.setHardwareDeclarationWarningSink(null);
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ALL = Object.freeze(['cpu', 'memory', 'pids']);
function prepared(extra = {}) {
    return {
        gate: 'on', prepared: true, backendReady: true, controllers: [...ALL], storeState: 'valid',
        storeToken: { epoch: 'epoch-1', revision: 1 }, overrides: new Map(),
        envelope: { cpus: 8, memoryBytes: 16 * 1024 ** 3 }, ...extra,
    };
}
const OFFLINE_HARDWARE = detectHardware({ runtime: 'podman', arch: 'x64', probes: {}, podmanInspect: () => null });

// While the resolver and admission run, every filesystem mutation and every
// child process throws: the declaration path is read-only and spawns nothing.
const FS_MUTATIONS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'rmdirSync', 'renameSync',
    'unlinkSync', 'chmodSync', 'chownSync', 'symlinkSync', 'linkSync', 'copyFileSync'];
const CHILD = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
function guarded(fn) {
    const saved = [];
    for (const [owner, names, label] of [[fs, FS_MUTATIONS, 'fs'], [childProcess, CHILD, 'child_process']]) {
        for (const name of names) {
            saved.push([owner, name, owner[name]]);
            owner[name] = () => { throw new Error(`guarded: ${label}.${name} was called`); };
        }
    }
    syncBuiltinESMExports();
    try {
        return fn();
    } finally {
        for (const [owner, name, value] of saved) owner[name] = value;
        syncBuiltinESMExports();
    }
}

let keySeq = 0;
function admit(manifest, {
    agentId = 'demo/worker', hardwareContext = prepared(), hardwareAdmission = 'metadata', profileName, ...rest
} = {}) {
    return guarded(() => {
        const profile = resolveManifestRuntimeProfile(manifest, { agentName: agentId, profileName, fallbackProfileName: 'default' });
        const admission = admitManifestRuntimeCapabilities(manifest, {
            ...box, agentId, runtime: 'podman', instanceKey: `ploinky_${agentId.replace('/', '_')}`,
            profileName: profile.resolvedProfileName, profileConfig: profile.profileConfig, network: profile.network,
            hardwareContext, hardwareAdmission, ...rest,
        });
        return { profile, admission };
    });
}
const requestOf = (manifest, options) => admit(manifest, options).admission.descriptor.hardwareRequest;
const refusalOf = (manifest, options) => hardwareRefusalOf(admit(manifest, options).admission);

function captureWarnings() {
    const messages = [];
    declared.setHardwareDeclarationWarningSink((message) => messages.push(message));
    return messages;
}

// --- schema --------------------------------------------------------------

test('HD.schema-manifest-and-profile-field', () => {
    const manifest = NEW({ memory: '512m', cpus: '0.5', pidsLimit: 64 }, { profiles: { default: {}, dev: { hardwareLimits: { cpus: 1 } } } });
    assert.doesNotThrow(() => validateManifestRuntimeCapabilities(manifest));
    assert.deepEqual(requestOf(manifest), [
        { field: 'memory', value: '512m', source: 'manifest' },
        { field: 'cpus', value: '0.5', source: 'manifest' },
        { field: 'pidsLimit', value: '64', source: 'manifest' },
    ]);
    assert.deepEqual(requestOf(manifest, { profileName: 'dev' }).find((entry) => entry.field === 'cpus'), { field: 'cpus', value: '1', source: 'profile' });
});

test('HD.unknown-key-refused', () => {
    for (const manifest of [
        NEW({ memory: '512m', swap: '1g' }),
        NEW({ shmSize: '64m' }),
        { ...base, profiles: { default: {}, dev: { hardwareLimits: { cpuset: '0-1' } } } },
    ]) {
        assert.throws(() => validateManifestRuntimeCapabilities(manifest), (error) => error instanceof RuntimePolicyError
            && error.code === 'PLOINKY_HARDWARE_LIMITS_DECLARATION_INVALID'
            && /hardwareLimits: unknown field '(swap|shmSize|cpuset)' \(allowed: memory, cpus, pidsLimit\)$/.test(error.message), JSON.stringify(manifest));
        assert.throws(() => admit(manifest), /unknown field/);
    }
    for (const value of [null, 'memory=1g', ['512m']]) {
        assert.throws(() => validateManifestRuntimeCapabilities(NEW(value)), /manifest\.hardwareLimits: expected object/);
    }
});

test('HD.gpu-key-refused', () => {
    for (const hardwareLimits of [{ gpu: { smPercent: 50, vramPercent: 50 } }, { smPercent: 50 }, { vramPercent: 25 }, { gpus: 'all' }]) {
        for (const manifest of [NEW(hardwareLimits), { ...base, profiles: { default: { hardwareLimits } } }]) {
            assert.throws(() => validateManifestRuntimeCapabilities(manifest), (error) => error.code === 'PLOINKY_HARDWARE_LIMITS_DECLARATION_INVALID'
                && /cannot be declared; GPU shares are administrator-only and are set in Explorer Settings → Hardware limits$/.test(error.message), JSON.stringify(manifest));
        }
    }
});

test('HD.invalid-values-refused-like-resources', () => {
    // Each key is validated by the same check as runtimePolicy.resources.
    for (const [hardwareLimits, pattern] of [
        [{ memory: '512 megabytes' }, /hardwareLimits\.memory: invalid size value$/],
        [{ cpus: '-1' }, /hardwareLimits\.cpus: invalid CPU value$/],
        [{ pidsLimit: 0 }, /hardwareLimits\.pidsLimit: invalid value$/],
        [{ pidsLimit: '64' }, /hardwareLimits\.pidsLimit: invalid value$/],
        [{ pidsLimit: 1048577 }, /hardwareLimits\.pidsLimit: invalid value$/],
    ]) {
        assert.throws(() => validateManifestRuntimeCapabilities(NEW(hardwareLimits)), pattern);
        const field = Object.keys(hardwareLimits)[0];
        assert.throws(() => validateManifestRuntimeCapabilities(OLD(hardwareLimits)), new RegExp(`resources\\.${field}: invalid`));
    }
});

// --- AC-A0 equivalents: limits apply to every agent ------------------------

for (const [suffix, llmRuntime] of [['absent', undefined], ['false', { enabled: false }], ['true', { enabled: true }]]) {
    test(`HD.a0-manifest-llm-${suffix}`, () => {
        const manifest = NEW({ memory: '512m', cpus: '1.5', pidsLimit: 64 }, llmRuntime ? { llmRuntime } : {});
        // Gate off in a Box: refused with the declared request.
        const refusal = refusalOf(manifest, { hardwareContext: { gate: 'off', storeState: 'none' } });
        assert.equal(refusal.reasonCode, 'gate_off');
        assert.deepEqual(refusal.requested.map((entry) => [entry.field, entry.source]), [['memory', 'manifest'], ['cpus', 'manifest'], ['pidsLimit', 'manifest']]);
        // Prepared gate-on Box: placed with exactly these values.
        assert.deepEqual(admit(manifest).admission.descriptor.hardwarePlacement.expected, { cpus: '1.5', memoryBytes: 512 * 1024 ** 2, pidsLimit: 64 });
        // Lite sandbox: refused (an enabled LLM runtime is a container-only
        // capability, rejected before hardware admission).
        if (suffix !== 'true') {
            assert.equal(refusalOf({ ...manifest, network: { mode: 'host' } }, { runtimeKind: 'bwrap', insideBox: false, network: { mode: 'host' } }).reasonCode, 'lite_sandbox');
        }
    });
    test(`HD.a0-profile-llm-${suffix}`, () => {
        const manifest = { ...base, profiles: { default: { ...(llmRuntime ? { llmRuntime } : {}) }, dev: { hardwareLimits: { pidsLimit: 32 } } } };
        const refusal = refusalOf(manifest, { profileName: 'dev', hardwareContext: { gate: 'off', storeState: 'none' } });
        assert.equal(refusal.reasonCode, 'gate_off');
        assert.deepEqual(refusal.requested, [{ field: 'pidsLimit', value: '32', source: 'profile' }]);
        assert.match(errors.formatHardwareOutcome(refusal), /requests pidsLimit 32 \(selected profile\)/);
        assert.deepEqual(admit(manifest, { profileName: 'dev' }).admission.descriptor.hardwarePlacement.expected, { cpus: null, memoryBytes: null, pidsLimit: 32 });
    });
}

// --- conflicts, equal values and deprecation ------------------------------

test('HD.conflict-manifest-refused', () => {
    captureWarnings();
    const manifest = NEW({ memory: '512m', cpus: '1' }, { llmRuntime: { runtimePolicy: { resources: { memory: '256m', cpus: 1 } } } });
    const refusal = refusalOf(manifest);
    assert.equal(refusal.state, 'refused');
    assert.equal(refusal.code, errors.HARDWARE_UNENFORCEABLE);
    assert.equal(refusal.reasonCode, 'declaration_conflict');
    assert.equal(refusal.reason, 'Conflicting hardware limit declarations: the manifest declares memory as 512m in hardwareLimits and as 256m in the deprecated llmRuntime.runtimePolicy.resources.');
    assert.equal(refusal.fix, 'Declare memory only under hardwareLimits and remove it from llmRuntime.runtimePolicy.resources in the same manifest or profile.');
    assert.deepEqual(errors.validateHardwareOutcome(refusal), refusal);
    // Strict admission throws the same typed outcome.
    assert.throws(() => admit(manifest, { hardwareAdmission: 'strict' }), (error) => error.name === 'HardwareLimitsError'
        && JSON.stringify(error.hardwareOutcome) === JSON.stringify(refusal));
    // Refused everywhere: outside a Box, in a lite sandbox and with the gate off.
    const outside = guarded(() => admitManifestRuntimeCapabilities(manifest, { agentId: 'demo/worker', runtime: 'podman', insideBox: false, hardwareAdmission: 'metadata' }));
    assert.equal(hardwareRefusalOf(outside).reasonCode, 'declaration_conflict');
    assert.throws(() => guarded(() => admitManifestRuntimeCapabilities(manifest, { agentId: 'demo/worker', runtime: 'podman', insideBox: false })), /Conflicting hardware limit declarations/);
    assert.equal(refusalOf({ ...manifest, network: { mode: 'host' } }, { runtimeKind: 'bwrap', insideBox: false, network: { mode: 'host' } }).reasonCode, 'declaration_conflict');
    assert.equal(refusalOf(manifest, { hardwareContext: { gate: 'off', storeState: 'none' } }).reasonCode, 'declaration_conflict');
    // Never rendered.
    assert.equal(admit(manifest).admission.descriptor.hardwarePlacement, undefined);
    // An internal helper is never refused.
    assert.equal(admit(manifest, { helper: true }).admission.hardwareEligibility, undefined);
});

test('HD.conflict-profile-refused', () => {
    captureWarnings();
    const conflicting = { hardwareLimits: { pidsLimit: 64 }, llmRuntime: { runtimePolicy: { resources: { pidsLimit: 32 } } } };
    for (const profiles of [{ default: conflicting }, { default: {}, dev: conflicting }]) {
        const manifest = { ...base, profiles };
        const refusal = refusalOf(manifest, { profileName: profiles.dev ? 'dev' : undefined });
        assert.equal(refusal.reasonCode, 'declaration_conflict');
        assert.match(refusal.reason, /the profile declares pidsLimit as 64 in hardwareLimits and as 32 in the deprecated llmRuntime\.runtimePolicy\.resources\.$/);
    }
});

test('HD.equal-values-accepted-with-warning', () => {
    const messages = captureWarnings();
    const manifest = NEW({ memory: '512m', cpus: '0.5' }, { llmRuntime: { runtimePolicy: { resources: { memory: '512m', cpus: 0.5, shmSize: '64m' } } } });
    const { admission } = admit(manifest, { agentId: 'demo/equal' });
    assert.equal(admission.hardwareEligibility.state, 'eligible');
    assert.equal(admission.descriptor.hardwareDeclarationConflicts, undefined);
    assert.equal(admission.descriptor.runtimePolicy.resources.memory, '512m');
    assert.equal(admission.descriptor.runtimePolicy.resources.shmSize, '64m', 'LLM-only settings stay in effect');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^\[hardware-limits\] demo\/equal: llmRuntime\.runtimePolicy\.resources\.memory, llmRuntime\.runtimePolicy\.resources\.cpus are deprecated; declare memory, cpus and pidsLimit under hardwareLimits/);
});

test('HD.deprecation-warning-once', () => {
    const messages = captureWarnings();
    const old = OLD({ memory: '512m' });
    for (let index = 0; index < 3; index += 1) {
        admit(old, { agentId: 'demo/once' });
        admit(old, { agentId: 'demo/once', hardwareAdmission: 'strict' });
    }
    assert.equal(messages.length, 1, 'once per agent per process');
    assert.equal(messages[0], '[hardware-limits] demo/once: llmRuntime.runtimePolicy.resources.memory is deprecated; declare memory, cpus and pidsLimit under hardwareLimits at the manifest root or in the same profile.');
    admit(old, { agentId: 'demo/other' });
    assert.equal(messages.length, 2, 'each agent is named once');
    // No warning for the neutral field or for LLM-only settings.
    admit(NEW({ memory: '512m' }), { agentId: 'demo/neutral' });
    admit({ ...base, llmRuntime: { runtimePolicy: { resources: { shmSize: '64m', ulimits: { memlock: { soft: -1, hard: -1 } } }, ipc: 'private', platform: 'linux/amd64' } } }, { agentId: 'demo/llm-only' });
    assert.equal(messages.length, 2);
    // A profile declaration is named by its profile path.
    admit({ ...base, profiles: { default: {}, dev: { llmRuntime: { runtimePolicy: { resources: { cpus: '1' } } } } } }, { agentId: 'demo/profiled', profileName: 'dev' });
    assert.match(messages[2], /^\[hardware-limits\] demo\/profiled: profiles\.dev\.llmRuntime\.runtimePolicy\.resources\.cpus is deprecated;/);
});

test('HD.deprecation-warning-bounded', () => {
    const messages = captureWarnings();
    const profiles = {};
    for (let index = 0; index < 6; index += 1) profiles[`p${index}`] = { llmRuntime: { runtimePolicy: { resources: { memory: '1g', cpus: '2' } } } };
    profiles['evil name\n<script>'] = { llmRuntime: { runtimePolicy: { resources: { pidsLimit: 7 } } } };
    const secretish = OLD({ memory: '987654321m' }, { profiles: { default: {}, ...profiles }, env: { API_TOKEN: 'super-secret-value' } });
    admit(secretish, { agentId: 'demo/bounded' });
    assert.equal(messages.length, 1);
    assert.ok(messages[0].length < 1200, messages[0].length);
    assert.match(messages[0], / and \d+ more are deprecated;/);
    assert.doesNotMatch(messages[0], /987654321|super-secret-value|API_TOKEN|\n|<script>/);
    const note = declared.deprecatedDeclarationNote(secretish);
    assert.equal(note.paths.length, 8);
    assert.equal(note.omitted, 14 - 8);
    assert.ok(declared.deprecatedHardwareDeclarations(secretish).includes('profiles.evil_name__script_.llmRuntime.runtimePolicy.resources.pidsLimit'));
});

test('HD.stored-overrides-declared', () => {
    const manifest = NEW({ memory: '512m', cpus: '0.5' });
    const context = prepared({ overrides: new Map([['demo/worker', { cpus: 2 }]]) });
    const { admission } = admit(manifest, { hardwareContext: context });
    assert.equal(admission.descriptor.runtimePolicy.resources.cpus, '2');
    assert.equal(admission.descriptor.runtimePolicy.resources.memory, '512m');
    assert.deepEqual(admission.descriptor.hardwareRequest, [
        { field: 'memory', value: '512m', source: 'manifest' },
        { field: 'cpus', value: '2', source: 'settings' },
    ]);
});

// --- profile resolution: the actual resolver, then admission --------------

test('HD.profile-empty-default', () => {
    captureWarnings();
    for (const dev of [{ hardwareLimits: { memory: '256m' } }, { llmRuntime: { runtimePolicy: { resources: { memory: '256m' } } } }]) {
        const manifest = { ...base, profiles: { default: {}, dev } };
        const { profile, admission } = admit(manifest, { profileName: 'dev' });
        assert.equal(profile.resolvedProfileName, 'dev');
        assert.deepEqual(profile.profileConfig.hardwareLimits, { memory: '256m' });
        assert.deepEqual(admission.descriptor.hardwareRequest, [{ field: 'memory', value: '256m', source: 'profile' }]);
        assert.equal(admission.descriptor.hardwarePlacement.expected.memoryBytes, 256 * 1024 ** 2);
        // The default profile alone declares nothing.
        assert.equal(admit(manifest).admission.descriptor.hardwareRequest, undefined);
    }
});

test('HD.profile-partial-selected-override', () => {
    const manifest = { ...base, profiles: { default: { hardwareLimits: { memory: '512m', cpus: '1', pidsLimit: 64 } }, dev: { hardwareLimits: { cpus: '0.5' } } } };
    const { admission } = admit(manifest, { profileName: 'dev' });
    assert.deepEqual(admission.descriptor.hardwareRequest, [
        { field: 'memory', value: '512m', source: 'profile' },
        { field: 'cpus', value: '0.5', source: 'profile' },
        { field: 'pidsLimit', value: '64', source: 'profile' },
    ]);
    // The manifest layer still sits below the profile layer.
    const layered = { ...manifest, hardwareLimits: { memory: '1g', cpus: '4' } };
    assert.deepEqual(admit(layered, { profileName: 'dev' }).admission.descriptor.runtimePolicy.resources, { memory: '512m', cpus: '0.5', pidsLimit: 64 });
});

test('HD.profile-old-default-neutral-selected', () => {
    const messages = captureWarnings();
    const manifest = { ...base, profiles: {
        default: { llmRuntime: { runtimePolicy: { resources: { memory: '256m', cpus: '1', shmSize: '64m' } } } },
        dev: { hardwareLimits: { memory: '512m' } },
    } };
    const { profile, admission } = admit(manifest, { profileName: 'dev', agentId: 'demo/inherit' });
    // Inheritance is never a conflict: the selected neutral memory overrides
    // the inherited old-path memory; the inherited cpus stays.
    assert.equal(admission.hardwareEligibility.state, 'eligible');
    assert.deepEqual(profile.profileConfig.hardwareLimits, { memory: '512m', cpus: '1' });
    assert.deepEqual(admission.descriptor.runtimePolicy.resources, { memory: '512m', cpus: '1', shmSize: '64m' });
    assert.equal(messages.length, 1, 'the default profile still uses the deprecated path');
    assert.match(messages[0], /profiles\.default\.llmRuntime\.runtimePolicy\.resources\.memory, profiles\.default\.llmRuntime\.runtimePolicy\.resources\.cpus are deprecated/);
});

test('HD.profile-neutral-default-old-selected', () => {
    captureWarnings();
    const manifest = { ...base, profiles: {
        default: { hardwareLimits: { memory: '256m', pidsLimit: 64 } },
        dev: { llmRuntime: { runtimePolicy: { resources: { memory: '512m' } } } },
    } };
    const { admission } = admit(manifest, { profileName: 'dev' });
    assert.equal(admission.hardwareEligibility.state, 'eligible');
    assert.deepEqual(admission.descriptor.hardwareRequest, [
        { field: 'memory', value: '512m', source: 'profile' },
        { field: 'pidsLimit', value: '64', source: 'profile' },
    ]);
});

test('HD.profile-conflict-within-raw-profile', () => {
    captureWarnings();
    const conflict = { hardwareLimits: { memory: '512m' }, llmRuntime: { runtimePolicy: { resources: { memory: '256m' } } } };
    // In the selected profile, and in the default profile even where the
    // selected profile overrides the key: a conflict of one raw profile is
    // always refused, typed and contained.
    for (const profiles of [
        { default: {}, dev: conflict },
        { default: conflict, dev: { hardwareLimits: { memory: '1g' } } },
        { default: { hardwareLimits: { memory: '1g' } }, dev: conflict },
    ]) {
        const manifest = { ...base, profiles };
        const refusal = refusalOf(manifest, { profileName: 'dev' });
        assert.equal(refusal.reasonCode, 'declaration_conflict', JSON.stringify(profiles));
        assert.match(refusal.reason, /the profile declares memory as 512m in hardwareLimits and as 256m in the deprecated/);
        assert.throws(() => admit(manifest, { profileName: 'dev', hardwareAdmission: 'strict' }), (error) => errors.findHardwareOutcome(error)?.reasonCode === 'declaration_conflict');
    }
    // Equal values within one raw profile are not a conflict.
    const equal = { ...base, profiles: { default: {}, dev: { hardwareLimits: { memory: '512m' }, llmRuntime: { runtimePolicy: { resources: { memory: '512m' } } } } } };
    assert.equal(admit(equal, { profileName: 'dev' }).admission.hardwareEligibility.state, 'eligible');
});

test('HD.profile-other-llm-settings-unchanged', () => {
    // Only the three hardware-limit keys follow the selected profile; its
    // other llmRuntime settings keep the resolver's existing behavior.
    const manifest = { ...base, profiles: {
        default: { llmRuntime: { runtimePolicy: { resources: { shmSize: '64m' } } } },
        dev: { llmRuntime: { runtimePolicy: { resources: { shmSize: '128m', cpus: '1' }, ipc: 'private' } } },
    } };
    const { profile, admission } = admit(manifest, { profileName: 'dev' });
    assert.equal(admission.descriptor.runtimePolicy.resources.shmSize, '64m');
    assert.equal(admission.descriptor.runtimePolicy.resources.cpus, '1');
    assert.equal(profile.profileConfig.llmRuntime.runtimePolicy.ipc, undefined);
    // A manifest without hardware-limit declarations resolves exactly as before.
    const plain = { ...base, profiles: { default: { env: { A: '1' }, llmRuntime: { enabled: false } }, dev: { env: { B: '2' } } } };
    const resolved = resolveManifestRuntimeProfile(plain, { agentName: 'demo/plain', profileName: 'dev' });
    assert.equal(Object.hasOwn(resolved.profileConfig, 'hardwareLimits'), false);
    assert.deepEqual(resolved.profileConfig.llmRuntime, { enabled: false });
});

// --- parity: hardwareLimits behaves exactly like the old path --------------

function bothForms(resources, extra = {}) {
    return { old: OLD(resources, extra), neutral: NEW(resources, extra) };
}
function sameRefusal(forms, options, reasonCode) {
    captureWarnings();
    const old = refusalOf(forms.old, options);
    const neutral = refusalOf(forms.neutral, options);
    assert.equal(old?.reasonCode, reasonCode);
    assert.deepEqual(neutral, old);
    return neutral;
}

test('HD.parity-lite-sandbox', () => {
    const forms = bothForms({ memory: '256m', cpus: '1.5' }, { network: { mode: 'host' } });
    for (const runtimeKind of ['bwrap', 'seatbelt']) {
        sameRefusal(forms, { runtimeKind, insideBox: false, network: { mode: 'host' } }, 'lite_sandbox');
    }
});

test('HD.parity-d4', () => {
    const forms = bothForms({ memory: '512m' }, { containerSecurity: { nestedPodman: true }, network: { mode: 'host' } });
    const refusal = sameRefusal(forms, { network: { mode: 'host' } }, 'host_network_nested_podman');
    assert.equal(refusal.reason, 'This release cannot enforce this hardware limit for host networking with nestedPodman.');
});

test('HD.parity-gate-off', () => {
    const refusal = sameRefusal(bothForms({ memory: '512m' }), { hardwareContext: { gate: 'off', storeState: 'none' } }, 'gate_off');
    assert.match(errors.formatHardwareOutcome(refusal), /Hardware limits are off for this workspace\. On the host run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart, or remove the declared limit\.$/);
});

test('HD.parity-unprepared-and-controller-missing', () => {
    const forms = bothForms({ memory: '512m', pidsLimit: 64 });
    for (const [extra, reasonCode] of [
        [{ prepared: false, backendReady: false, unpreparedKind: 'cgroup' }, 'cgroup_unsupported'],
        [{ prepared: true, backendReady: false, unpreparedKind: 'runtime', runtimeObserved: 'unknown/unknown/runc/systemd' }, 'runtime_unverified'],
        [{ prepared: true, backendReady: false, unpreparedKind: 'parents', unpreparedDetail: 'denied' }, 'backend_unavailable'],
        [{ prepared: false, backendReady: false }, 'unprepared'],
        [{ controllers: ['cpu', 'pids'] }, 'controller_unavailable'],
        [{ storeState: 'unreadable', storeDetail: 'corrupt' }, 'store_unreadable'],
    ]) {
        sameRefusal(forms, { hardwareContext: prepared(extra) }, reasonCode);
    }
});

test('HD.parity-metadata-strict-and-launch', () => {
    captureWarnings();
    const forms = bothForms({ memory: '512m', cpus: 0.5, pidsLimit: 128 });
    // Strict throws the outcome metadata records.
    for (const manifest of [forms.old, forms.neutral]) {
        const metadata = refusalOf(manifest, { hardwareContext: { gate: 'off', storeState: 'none' } });
        assert.throws(() => admit(manifest, { hardwareContext: { gate: 'off', storeState: 'none' }, hardwareAdmission: 'strict' }),
            (error) => JSON.stringify(errors.findHardwareOutcome(error)) === JSON.stringify(metadata));
    }
    // An eligible strict admission launches with the same guard argv and readback target.
    const guards = [forms.old, forms.neutral].map((manifest) => {
        const { admission } = admit(manifest, { hardwareAdmission: 'strict' });
        const guard = createHardwareLaunchGuard(admission, { key: 'ploinky_demo_worker', ref: 'demo/worker', hardwareContext: prepared() });
        return { args: guard.createArgs(['create', '--name', 'x', 'image']), placement: admission.descriptor.hardwarePlacement };
    });
    assert.deepEqual(guards[1], guards[0]);
    assert.deepEqual(guards[0].args.slice(0, 2), ['--cgroup-manager=cgroupfs', 'create']);
});

test('HD.parity-interactive', () => {
    captureWarnings();
    const forms = bothForms({ cpus: '1', memory: '256m' });
    const outcomes = [forms.old, forms.neutral].map((manifest) => {
        try {
            assertInteractiveHardwareLimitsAbsent(manifest, { agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', insideBox: true, hardwareContext: prepared() });
        } catch (error) {
            return errors.findHardwareOutcome(error);
        }
        return null;
    });
    assert.equal(outcomes[0].reasonCode, 'interactive_runtime');
    assert.deepEqual(outcomes[1], outcomes[0]);
});

test('HD.parity-graph-outcomes-and-blocked-dependants', () => {
    captureWarnings();
    const graphFor = (repo) => {
        const preflight = workspaceUtil.preflightWorkspaceStartRuntimeCapabilities(`${repo}/root`, { boxMarkerOptions: box.boxMarkerOptions });
        const availability = workspaceUtil.classifyWorkspaceGraphAvailability(preflight.graph, preflight.admissions);
        const strip = (outcome) => outcome && JSON.parse(JSON.stringify(outcome).replaceAll(repo, 'REPO'));
        const state = (name) => {
            const entry = availability.byNodeId.get(`${repo}/${name}`);
            return entry ? { state: entry.state, outcome: strip(entry.outcome || null) } : null;
        };
        return { root: state('root'), needy: state('needy'), grand: state('grand'), plain: state('plain') };
    };
    const old = graphFor('oldpath');
    const neutral = graphFor('neutral');
    assert.equal(old.grand.state, 'refused');
    assert.equal(old.needy.state, 'refused');
    assert.equal(old.root.state, 'blocked');
    assert.equal(old.plain.state, 'eligible');
    // Fingerprints differ only by the agent identities they bind.
    const withoutFingerprints = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (key === 'inputFingerprint' ? 'X' : entry)));
    assert.deepEqual(withoutFingerprints(neutral), withoutFingerprints(old));
    // A conflicting declaration is refused and contained like every refusal.
    const conflict = graphFor('clash');
    assert.equal(conflict.needy.state, 'refused');
    assert.equal(conflict.needy.outcome.reasonCode, 'declaration_conflict');
    assert.equal(conflict.root.state, 'blocked');
    assert.equal(conflict.plain.state, 'eligible');
});

test('HD.route-deprecated-declaration-note', () => {
    const oldPath = writeManifest('notes', 'old', OLD({ memory: '512m' }, { profiles: { default: {}, dev: { llmRuntime: { runtimePolicy: { resources: { cpus: '1' } } } } } }));
    const neutralPath = writeManifest('notes', 'neutral', NEW({ memory: '512m' }));
    const state = buildHardwareLimitsState({
        context: prepared(), registry: {}, metrics: null,
        installed: [{ ref: 'notes/old', manifestPath: oldPath }, { ref: 'notes/neutral', manifestPath: neutralPath }],
        admit: () => ({ descriptor: { runtimePolicy: { resources: { memory: '512m' } } } }),
    });
    const byRef = Object.fromEntries(state.agents.map((agent) => [agent.ref, agent]));
    assert.deepEqual(byRef['notes/old'].deprecatedDeclaration, {
        paths: ['llmRuntime.runtimePolicy.resources.memory', 'profiles.dev.llmRuntime.runtimePolicy.resources.cpus'],
        omitted: 0,
        replacement: 'hardwareLimits',
    });
    assert.equal(Object.hasOwn(byRef['notes/neutral'], 'deprecatedDeclaration'), false);
});

// --- identity: same values, same hash, argv and reuse decision -------------

const PAIRS = Object.freeze({
    manifest: [OLD({ memory: '512m', cpus: 0.5, pidsLimit: 128 }), NEW({ memory: '512m', cpus: 0.5, pidsLimit: 128 })],
    'manifest-with-llm-settings': [
        OLD({ memory: '1g', shmSize: '64m', ulimits: { memlock: { soft: -1, hard: -1 } } }, {}),
        NEW({ memory: '1g' }, { llmRuntime: { runtimePolicy: { resources: { shmSize: '64m', ulimits: { memlock: { soft: -1, hard: -1 } } } } } }),
    ],
    'manifest-mixed': [OLD({ memory: '512m', cpus: '1' }), NEW({ memory: '512m' }, { llmRuntime: { runtimePolicy: { resources: { cpus: '1' } } } })],
    profile: [
        { ...base, profiles: { default: { llmRuntime: { runtimePolicy: { resources: { memory: '256m' } } } }, dev: { llmRuntime: { runtimePolicy: { resources: { cpus: '1' } } } } } },
        { ...base, profiles: { default: { hardwareLimits: { memory: '256m' } }, dev: { hardwareLimits: { cpus: '1' } } } },
    ],
});

test('HD.identity-hash-args-equal', () => {
    captureWarnings();
    for (const [name, [old, neutral]] of Object.entries(PAIRS)) {
        const profileName = name === 'profile' ? 'dev' : undefined;
        for (const hardwareContext of [prepared(), prepared({ overrides: new Map([['demo/worker', { memoryPercent: 10 }]]) })]) {
            const [a, b] = [old, neutral].map((manifest) => admit(manifest, { profileName, hardwareContext, hardwareAdmission: 'strict' }));
            const descriptor = (value) => ({ ...value.admission.descriptor, manifestDigest: 'X' });
            assert.deepEqual(descriptor(b), descriptor(a), name);
            assert.match(hardwareLimitsHashOf(a.admission.descriptor), /^[0-9a-f]{64}$/, name);
            assert.equal(hardwareLimitsHashOf(b.admission.descriptor), hardwareLimitsHashOf(a.admission.descriptor), name);
            assert.deepEqual(renderRuntimePolicyArgs(b.admission.descriptor, { runtime: 'podman' }), renderRuntimePolicyArgs(a.admission.descriptor, { runtime: 'podman' }), name);
            assert.equal(computeRuntimePolicyHash(b.admission.descriptor.runtimePolicy), computeRuntimePolicyHash(a.admission.descriptor.runtimePolicy), name);
            const envHash = computeEnvHash(old, a.profile.profileConfig, {}, { agentName: 'worker', repoName: 'demo' });
            assert.match(envHash, /^[0-9a-f]{64}$/, name);
            assert.equal(computeEnvHash(neutral, b.profile.profileConfig, {}, { agentName: 'worker', repoName: 'demo' }), envHash, name);
        }
        // Outside a Box the engine flags are the same.
        const outside = [old, neutral].map((manifest) => guarded(() => {
            const profile = resolveManifestRuntimeProfile(manifest, { agentName: 'demo/worker', profileName, fallbackProfileName: 'default' });
            const admission = admitManifestRuntimeCapabilities(manifest, { agentId: 'demo/worker', runtime: 'podman', insideBox: false, profileName: profile.resolvedProfileName, profileConfig: profile.profileConfig });
            return emitRunArgs(admission.descriptor.runtimePolicy, { runtime: 'podman' });
        }));
        assert.deepEqual(outside[1], outside[0], name);
    }
});

function graphReuse(spec) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-declaration-graph-'));
    try {
        fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
        const specPath = path.join(root, 'spec.json');
        fs.writeFileSync(specPath, JSON.stringify({ markerPath, ...spec }));
        const probe = fileURLToPath(new URL('../hardware-limits/graphReuseProbe.mjs', import.meta.url));
        const result = spawnSync(process.execPath, [probe, specPath], { cwd: root, encoding: 'utf8', env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root } });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim().split('\n').pop());
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function llmCatalog() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-declaration-llm-'));
    const catalogRoot = path.join(root, 'catalog');
    fs.mkdirSync(path.join(catalogRoot, 'architectures'), { recursive: true });
    fs.mkdirSync(path.join(catalogRoot, 'images'), { recursive: true });
    fs.writeFileSync(path.join(catalogRoot, 'catalog.json'), JSON.stringify({
        schemaVersion: 1, catalogId: 'test/catalog', defaultFallback: 'cpu-amd64',
        architectures: [{ id: 'cpu-amd64', path: 'architectures/cpu-amd64.json' }],
        images: [{ id: 'cpu-amd64', path: 'images/cpu-amd64.json' }],
    }));
    fs.writeFileSync(path.join(catalogRoot, 'architectures/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64', status: 'stable', platform: 'linux/amd64', accelerator: { family: 'cpu' },
        match: { requiredProbes: [] }, image: 'cpu-amd64',
        // No catalog resources: the catalog layer sits above the manifest, so
        // catalog values would mask which field the manifest declared.
        runtimePolicy: { platform: 'linux/amd64', ipc: 'default' },
        engineDefaults: { enginePort: 8080, runtimePort: 9000 },
    }));
    fs.writeFileSync(path.join(catalogRoot, 'images/cpu-amd64.json'), JSON.stringify({ id: 'cpu-amd64', ref: 'reg.example.com/llm-cpu-amd64:dev', platform: 'linux/amd64' }));
    return { root, env: { PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot, PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64' } };
}

const serializable = (context) => ({ ...context, overrides: Object.fromEntries(context.overrides) });

test('HD.identity-migration-no-restart-graph', (t) => {
    const { root, env } = llmCatalog();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const llmOld = OLD({ memory: '1g', cpus: '1.5' }, { llmRuntime: { enabled: true, runtimePolicy: { resources: { memory: '1g', cpus: '1.5' } } } });
    const llmNew = NEW({ memory: '1g', cpus: '1.5' }, { llmRuntime: { enabled: true } });
    const graph = graphReuse({
        hardwareContext: serializable(prepared()),
        llmEnv: env,
        agents: [
            { key: 'ploinky_demo_manifest', ref: 'demo/manifest', manifest: PAIRS.manifest[1], running: { manifest: PAIRS.manifest[0] } },
            { key: 'ploinky_demo_mixed', ref: 'demo/mixed', manifest: PAIRS['manifest-with-llm-settings'][1], running: { manifest: PAIRS['manifest-with-llm-settings'][0] } },
            { key: 'ploinky_demo_profile', ref: 'demo/profile', profile: 'dev', manifest: PAIRS.profile[1], running: { manifest: PAIRS.profile[0] } },
            { key: 'ploinky_demo_llm', ref: 'demo/llm', manifest: llmNew, running: { manifest: llmOld } },
            // Control: a changed value is still replaced, so the probe can see a change.
            { key: 'ploinky_demo_changed', ref: 'demo/changed', manifest: NEW({ memory: '768m', cpus: 0.5, pidsLimit: 128 }), running: { manifest: PAIRS.manifest[0] } },
        ],
    });
    assert.deepEqual(graph.results, {
        ploinky_demo_manifest: '', ploinky_demo_mixed: '', ploinky_demo_profile: '', ploinky_demo_llm: '', ploinky_demo_changed: 'limitsHashChanged',
    });
    assert.deepEqual(graph.probes.ploinky_demo_llm, ['admittedRuntimePolicy', 'resolvedHardware', 'resolvedSelection']);
});

test('HD.identity-llm-reuse-callers', (t) => {
    captureWarnings();
    const { root, env } = llmCatalog();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const llmOld = { ...base, llmRuntime: { enabled: true, runtimePolicy: { resources: { memory: '1g', cpus: '1.5' } } } };
    const llmNew = { ...base, hardwareLimits: { memory: '1g', cpus: '1.5' }, llmRuntime: { enabled: true } };
    const admitted = (manifest) => {
        const llm = resolveLlmRuntimeAdmissionContext({ runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env, resolvedHardware: OFFLINE_HARDWARE });
        const { admission } = admit(manifest, { agentId: 'demo/llm', catalogPolicy: llm.catalogPolicy, catalogIdentity: llm.catalogIdentity });
        return { llm, admission };
    };
    const before = admitted(llmOld);
    const after = admitted(llmNew);
    const creation = (manifest, { llm, admission }) => prepareLlmStartup({
        runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env, agentWorkDirRoot: root,
        manifestEnvNames: [], envHash: 'envhash', effectiveNetwork: base.network, writeState: false, createDirectories: false,
        resolvedSelection: llm.startup.selection, resolvedHardware: llm.startup.hardware, admittedRuntimePolicy: admission.descriptor.runtimePolicy,
    });
    const running = creation(llmOld, before);
    assert.equal(creation(llmNew, after).reuseHash, running.reuseHash);
    // ensureAgentService's own LLM reuse caller keeps the runtime created from
    // the old declaration once the manifest declares hardwareLimits.
    const reuse = serviceManager.serviceLlmReuseReason({
        runtime: 'podman', manifest: llmNew, profileConfig: null, agentName: 'llm', containerName: 'ploinky_demo_llm',
        envHash: 'envhash', serviceAdmission: after.admission, serviceLlmAdmissionContext: after.llm, env, agentWorkDirRoot: root,
        getContainerLabelImpl: (_name, label) => (label === 'ploinky.reusehash' ? running.reuseHash : ''),
    });
    assert.equal(reuse, '');
    // The non-admitted path computes the same policy hash from either form.
    const direct = (manifest) => prepareLlmStartup({
        runtime: 'podman', manifest, profileConfig: null, agentName: 'llm', env, agentWorkDirRoot: root,
        envHash: 'envhash', writeState: false, createDirectories: false, resolvedHardware: OFFLINE_HARDWARE,
    });
    assert.equal(direct(llmNew).policyHash, direct(llmOld).policyHash);
    assert.equal(direct(llmNew).reuseHash, direct(llmOld).reuseHash);
    // The declared values themselves reach the rendered arguments, from either field.
    for (const manifest of [llmNew, llmOld]) {
        const args = direct(manifest).runArgs;
        assert.equal(args[args.indexOf('--memory') + 1], '1g', JSON.stringify(args));
        assert.equal(args[args.indexOf('--cpus') + 1], '1.5', JSON.stringify(args));
    }
    for (const manifest of [llmNew, llmOld]) {
        const args = creation(manifest, admitted(manifest)).runArgs;
        assert.equal(args[args.indexOf('--memory') + 1], '1g', JSON.stringify(args));
    }
});

// The interactive create/reuse path refuses what admission refuses: its real
// caller passes the profile the production resolver returns, so a limit
// declared only in a profile (inherited from the default profile here) is
// refused before any engine or workspace operation.
test('HD.interactive-caller-resolves-the-profile', () => {
    const { runCommandInContainer } = interactiveModule;
    for (const [label, manifest] of [
        ['neutral', { ...base, profiles: { default: { hardwareLimits: { memory: '256m' } }, dev: {} } }],
        ['deprecated', { ...base, profiles: { default: { llmRuntime: { runtimePolicy: { resources: { memory: '256m' } } } }, dev: {} } }],
    ]) {
        const resolved = resolveManifestRuntimeProfile(manifest, { agentName: 'demo/shell' });
        const expected = (() => { try { assertInteractiveHardwareLimitsAbsent(manifest, { agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell', profileConfig: resolved.profileConfig }); } catch (error) { return errors.findHardwareOutcome(error); } return null; })();
        assert.ok(expected, `${label}: the resolved profile declares a limit`);
        let outcome = null;
        guarded(() => { try { runCommandInContainer('shell', 'demo', manifest, 'true'); } catch (error) { outcome = errors.findHardwareOutcome(error); if (!outcome) throw error; } });
        assert.ok(outcome, `${label}: the real interactive caller refuses`);
        assert.equal(outcome.reasonCode, 'interactive_runtime');
        assert.deepEqual(outcome.requested, [{ field: 'memory', value: '256m', source: 'profile' }]);
        assert.deepEqual(outcome.requested, expected.requested);
    }
});

// A declared value longer than the outcome bound is still a typed refusal on
// either declaration path, carrying a bounded prefix and the value's digest.
test('HD.long-requested-value-is-a-bounded-refusal', () => {
    const long = `${'0'.repeat(200)}512m`;
    const outcomes = [OLD({ memory: long }), NEW({ memory: long })].map((manifest) => refusalOf(manifest, { hardwareContext: { gate: 'off', storeState: 'none' } }));
    for (const outcome of outcomes) {
        assert.equal(outcome.code, errors.HARDWARE_UNENFORCEABLE);
        const [entry] = outcome.requested;
        assert.equal(entry.field, 'memory');
        assert.ok(Buffer.byteLength(entry.value) <= errors.OUTCOME_BOUNDS.value, entry.value);
        assert.ok(entry.value.startsWith('0'.repeat(32)));
        assert.match(entry.value, /\.\.\.sha256:[0-9a-f]{16}$/);
    }
    assert.equal(outcomes[0].requested[0].value, outcomes[1].requested[0].value);
    // The interactive refusal is bounded the same way.
    let interactive = null;
    try { assertInteractiveHardwareLimitsAbsent(NEW({ cpus: `0.${'5'.repeat(200)}` }), { agentName: 'shell', repoName: 'demo', containerName: 'ploinky_demo_shell' }); }
    catch (error) { interactive = errors.findHardwareOutcome(error); }
    assert.ok(interactive && Buffer.byteLength(interactive.requested[0].value) <= errors.OUTCOME_BOUNDS.value);
    // A value within the bound is carried unchanged.
    assert.equal(refusalOf(NEW({ memory: '512m' }), { hardwareContext: { gate: 'off', storeState: 'none' } }).requested[0].value, '512m');
});
