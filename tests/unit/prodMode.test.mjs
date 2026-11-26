import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// AC4-AC6: the PROD var (strict parse, consistency, repair), the Router
// environment and the agent environment (captured value only).

const cwd = process.cwd();
const savedEnv = { ...process.env };
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-prod-mode-')));
test.after(() => {
    process.chdir(cwd);
    for (const name of Object.keys(process.env)) {
        if (!Object.hasOwn(savedEnv, name)) delete process.env[name];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(workspace, { recursive: true, force: true });
});
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = randomUUID().replaceAll('-', '').padEnd(64, 'a');
fs.writeFileSync('.env', '');

const { parseProd, readProd, assertProdProfileConsistency } = await import('../../cli/utils/prodMode.mjs');
const { handleVarCommand, handleVarStdinCommand } = await import('../../cli/commands/envVarCommands.js');
const { readSecretsFile, writeSecretsFile } = await import('../../cli/utils/security/encryptedSecretsFile.js');
const { setActiveProfile, getActiveProfile, getProfileEnvVars, validateProfile } = await import('../../cli/utils/runtime/profileService.js');
const { buildRouterEnv } = await import('../../cli/commands/workspaceUtil.js');
const { PROD_GATES_FILE, readCapturedProdGates } = await import('../../cli/utils/runtime/mcpProdGates.mjs');

const PROFILE_PATH = path.join(workspace, '.ploinky', 'profile');
const originalLog = console.log;

function writeManifest(repo, agent, manifest) {
    const dir = path.join(workspace, '.ploinky', 'repos', repo, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// Every environment profile name is declared by this manifest, so the profile
// file accepts it whatever the profile-name rules are.
writeManifest('r', 'full', { profiles: { default: {}, dev: {}, qa: {}, prod: {} } });

function reset() {
    fs.rmSync(PROFILE_PATH, { force: true });
    fs.rmSync(path.join(workspace, '.ploinky', 'data'), { recursive: true, force: true });
    delete process.env.PROD;
    fs.writeFileSync('.env', '');
}

function setProfileFile(name) {
    fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    fs.writeFileSync(PROFILE_PATH, name);
}

function writeCapture(value) {
    fs.mkdirSync(path.dirname(PROD_GATES_FILE), { recursive: true });
    fs.writeFileSync(PROD_GATES_FILE, typeof value === 'string' ? value : JSON.stringify(value));
}

function quietVar(...args) {
    console.log = () => {};
    try {
        return handleVarCommand(args);
    } finally {
        console.log = originalLog;
    }
}

function storedProd() {
    return Object.hasOwn(readSecretsFile(), 'PROD') ? readSecretsFile().PROD : undefined;
}

const codeIs = (code) => (error) => error?.code === code;

test('AC4: parseProd accepts only the exact literals and an empty selection', () => {
    assert.equal(parseProd('true'), true);
    assert.equal(parseProd('false'), false);
    assert.equal(parseProd(true), true);
    assert.equal(parseProd(false), false);
    for (const empty of [undefined, null, '']) assert.equal(parseProd(empty), undefined);
    for (const bad of ['True', 'FALSE', '1', '0', 'yes', 'true ', ' true', 'tru€', 'x'.repeat(64 * 1024), 0, 1, {}]) {
        assert.throws(() => parseProd(bad), codeIs('PLOINKY_PROD_INVALID'), JSON.stringify(String(bad).slice(0, 12)));
    }
    // A hostile value is never echoed whole.
    try {
        parseProd('x'.repeat(64 * 1024));
    } catch (error) {
        assert.ok(error.message.length < 200);
    }
});

test('AC4: var PROD refuses every invalid value and leaves the store unchanged', () => {
    reset();
    setProfileFile('prod');
    quietVar('PROD', 'true');
    assert.equal(storedProd(), 'true');
    for (const bad of ['yes', 'True', '1', 'true ', 'tru€', 'x'.repeat(64 * 1024)]) {
        assert.throws(() => quietVar('PROD', bad), codeIs('PLOINKY_PROD_INVALID'));
        assert.equal(storedProd(), 'true');
    }
    // An empty value is a usage error, not a write.
    assert.throws(() => quietVar('PROD', ''), /Usage/);
    assert.equal(storedProd(), 'true');
    // The same strictness applies to the inline assignment form.
    assert.throws(() => quietVar('PROD=yes'), codeIs('PLOINKY_PROD_INVALID'));
    assert.equal(storedProd(), 'true');
});

test('AC4: var --stdin PROD is strict and consistency-checked too', async () => {
    reset();
    setProfileFile('default');
    await assert.rejects(
        handleVarStdinCommand('PROD', Object.assign(async function* () { yield Buffer.from('true'); }(), { isTTY: false })),
        codeIs('PLOINKY_PROD_PROFILE_MISMATCH'),
    );
    assert.equal(storedProd(), undefined);
    await assert.rejects(
        handleVarStdinCommand('PROD', Object.assign(async function* () { yield Buffer.from('maybe'); }(), { isTTY: false })),
        codeIs('PLOINKY_PROD_INVALID'),
    );
    assert.equal(storedProd(), undefined);
});

test('AC5: var PROD true requires profile prod; profile changes are refused while PROD is true', () => {
    reset();
    setProfileFile('default');
    assert.throws(() => quietVar('PROD', 'true'), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
    assert.equal(storedProd(), undefined);

    assert.equal(setActiveProfile('prod').success, true);
    quietVar('PROD', 'true');
    assert.equal(storedProd(), 'true');
    quietVar('PROD', 'true'); // idempotent

    // `profile qa` with a stored PROD true throws and leaves the profile alone.
    assert.throws(() => setActiveProfile('qa'), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
    assert.equal(getActiveProfile(), 'prod');
    assert.equal(fs.readFileSync(PROFILE_PATH, 'utf8').trim(), 'prod');

    // `var PROD false` lifts the coupling.
    quietVar('PROD', 'false');
    assert.equal(setActiveProfile('qa').success, true);
    assert.equal(getActiveProfile(), 'qa');
    // Profile prod with PROD false is allowed.
    assert.equal(setActiveProfile('prod').success, true);
});

test('AC5: a stored invalid value is repaired by var PROD false and by var PROD true under profile prod', () => {
    reset();
    setProfileFile('default');
    writeSecretsFile({ PROD: 'yes' });
    assert.throws(() => readProd(), codeIs('PLOINKY_PROD_INVALID'));
    assert.throws(() => assertProdProfileConsistency(), codeIs('PLOINKY_PROD_INVALID'));
    // `requestedProd` never reads the stored value, so the repair is allowed.
    quietVar('PROD', 'false');
    assert.equal(storedProd(), 'false');

    writeSecretsFile({ PROD: 'yes' });
    setProfileFile('prod');
    quietVar('PROD', 'true');
    assert.equal(storedProd(), 'true');
});

test('mode changes respect the workspace lease and normalized variable name', async () => {
    reset();
    setProfileFile('qa');
    assert.throws(() => quietVar(' PROD ', 'true'), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
    assert.equal(storedProd(), undefined);
    const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');
    const lease = locks.createWorkspaceMutationLease({ operation: 'deployment' });
    try {
        assert.throws(() => setActiveProfile('prod'), codeIs('PLOINKY_WORKSPACE_MUTATION_BUSY'));
        assert.throws(() => quietVar('PROD', 'false'), codeIs('PLOINKY_WORKSPACE_MUTATION_BUSY'));
        assert.equal(getActiveProfile(), 'qa');
        assert.equal(storedProd(), undefined);
    } finally {
        assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
    }
});

test('production inspection preserves an empty or unreadable store', () => {
    reset();
    const file = path.join(workspace, '.ploinky', 'data', '.secrets');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const contents of ['', '  ', 'damaged']) {
        fs.writeFileSync(file, contents);
        assert.throws(() => readProd());
        assert.equal(fs.readFileSync(file, 'utf8'), contents);
    }
});

test('AC5: consistency compares the requested profile with the requested or stored PROD', () => {
    reset();
    setProfileFile('qa');
    assert.doesNotThrow(() => assertProdProfileConsistency());
    writeSecretsFile({ PROD: 'true' });
    assert.throws(() => assertProdProfileConsistency(), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
    assert.throws(() => assertProdProfileConsistency({ requestedProfile: 'qa' }), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
    assert.doesNotThrow(() => assertProdProfileConsistency({ requestedProfile: 'prod' }));
    assert.doesNotThrow(() => assertProdProfileConsistency({ requestedProfile: 'PROD ' }));
    assert.doesNotThrow(() => assertProdProfileConsistency({ requestedProd: false }));
    assert.throws(() => assertProdProfileConsistency({ requestedProd: true }), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
});

test('AC6: the Router takes PROD only from the capture, never from .env, the store or process.env', () => {
    reset();
    setProfileFile('prod');
    writeSecretsFile({ PROD: 'true' });
    fs.writeFileSync('.env', 'PROD=false\n');
    process.env.PROD = 'false';
    writeCapture({ schema: 1, prod: true, routes: {} });
    assert.equal(buildRouterEnv().PROD, 'true');
    assert.equal(buildRouterEnv({ managedBox: true }).PROD, 'true');

    // Stored true, capture false: the Router still sees the capture.
    writeCapture({ schema: 1, prod: false, routes: {} });
    assert.equal(buildRouterEnv().PROD, 'false');
    // Stored false, .env and process.env true: still the capture.
    writeSecretsFile({ PROD: 'false' });
    fs.writeFileSync('.env', 'PROD=true\n');
    process.env.PROD = 'true';
    assert.equal(buildRouterEnv().PROD, 'false');
});

test('AC6: an absent, corrupt or invalid capture is PROD true for the Router and the agents', () => {
    reset();
    setProfileFile('default');
    assert.equal(fs.existsSync(PROD_GATES_FILE), false);
    assert.equal(buildRouterEnv().PROD, 'true');
    assert.equal(getProfileEnvVars('a', 'r', 'default').PROD, 'true');
    assert.deepEqual(
        { unavailable: true, reason: 'absent' },
        { ...readCapturedProdGates() },
    );
    for (const bad of ['{not json', '[]', '{"schema":2,"prod":false,"routes":{}}', '{"schema":1,"prod":"false","routes":{}}',
        '{"schema":1,"prod":false}', '{"schema":1,"prod":false,"routes":{"a":{"tools":[1]}}}']) {
        writeCapture(bad);
        assert.equal(readCapturedProdGates().unavailable, true, bad);
        assert.equal(readCapturedProdGates().reason, 'corrupt', bad);
        assert.equal(buildRouterEnv().PROD, 'true', bad);
        assert.equal(getProfileEnvVars('a', 'r', 'default').PROD, 'true', bad);
    }
    // A directory in place of the file is unavailable, not an exception.
    fs.rmSync(PROD_GATES_FILE, { force: true });
    fs.mkdirSync(PROD_GATES_FILE);
    assert.equal(readCapturedProdGates().unavailable, true);
    assert.equal(buildRouterEnv().PROD, 'true');
    fs.rmSync(PROD_GATES_FILE, { recursive: true });
});

test('AC6: the capture is re-read when the file is replaced', () => {
    reset();
    writeCapture({ schema: 1, prod: false, routes: {} });
    assert.equal(readCapturedProdGates().prod, false);
    // A rename replaces the inode, so the change is seen immediately.
    const next = `${PROD_GATES_FILE}.next`;
    fs.writeFileSync(next, JSON.stringify({ schema: 1, prod: true, routes: {} }));
    fs.renameSync(next, PROD_GATES_FILE);
    assert.equal(readCapturedProdGates().prod, true);
    assert.equal(buildRouterEnv().PROD, 'true');
});

test('agent injection: PROD in the agent environment is the captured value, not the stored or process value', () => {
    reset();
    writeSecretsFile({ PROD: 'true' });
    process.env.PROD = 'true';
    writeCapture({ schema: 1, prod: false, workspaceProfile: 'qa', routes: {} });
    const off = getProfileEnvVars('agent-x', 'repo-x', 'qa', { containerName: 'c', containerId: 'c' });
    assert.equal(off.PROD, 'false');
    assert.equal(off.PLOINKY_PROFILE, 'qa');
    assert.equal(off.PLOINKY_PROFILE_ENV, 'qa');
    writeCapture({ schema: 1, prod: true, workspaceProfile: 'prod', routes: {} });
    const on = getProfileEnvVars('agent-x', 'repo-x', 'prod', { containerName: 'c', containerId: 'c' });
    assert.equal(on.PROD, 'true');
    assert.equal(on.PLOINKY_PROFILE_ENV, 'prod');
    writeCapture({ schema: 1, prod: false, workspaceProfile: 'dev', routes: {} });
    // PD13: default and dev are the development environment.
    assert.equal(getProfileEnvVars('a', 'r', 'default').PLOINKY_PROFILE_ENV, 'development');
    assert.equal(getProfileEnvVars('a', 'r', 'dev').PLOINKY_PROFILE_ENV, 'development');
    assert.equal(getProfileEnvVars('a', 'r', 'dev').PLOINKY_PROFILE, 'dev');
});

test('a manifest env named PROD is a validation error, as is a wildcard that would expand it', () => {
    reset();
    writeSecretsFile({ PROD: 'true', OTHER_VALUE: 'x' });
    writeManifest('r', 'with-prod-env', { profiles: { default: { env: ['PROD'] } } });
    const result = validateProfile('r/with-prod-env', 'default');
    assert.equal(result.valid, false);
    assert.match(result.issues.join('\n'), /PROD.*reserved/);
    writeManifest('r', 'with-prod-object', { profiles: { default: { env: [{ name: 'PROD', value: 'false' }] } } });
    assert.equal(validateProfile('r/with-prod-object', 'default').valid, false);
    writeManifest('r', 'with-wildcard', { profiles: { default: { env: ['*'] } } });
    const wildcard = validateProfile('r/with-wildcard', 'default');
    assert.equal(wildcard.valid, true, wildcard.issues.join('\n'));
    assert.equal(Object.hasOwn(wildcard.config.env ?? {}, 'PROD'), false);
});

test('start and whole restart run the consistency check before their first mutation', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../cli/commands/cli.js', import.meta.url)), 'utf8');
    const startCase = source.slice(source.indexOf("case 'start': {"), source.indexOf("case 'sso':"));
    assert.ok(startCase.includes('assertProdProfileConsistency({ requestedProfile: startParsed.profile || undefined })'));
    assert.ok(startCase.indexOf('assertProdProfileConsistency(') < startCase.indexOf('setActiveProfile('));
    assert.ok(startCase.indexOf('assertProdProfileConsistency(') < startCase.indexOf('await startWorkspace('));
    const restartWhole = source.slice(source.indexOf("restart: start is not configured. Run: start <staticAgent> <port>'"));
    const assertAt = restartWhole.indexOf('assertProdProfileConsistency();');
    assert.ok(assertAt > 0);
    for (const mutation of ['resolvePersistedRouterPort();', 'settleWorkspaceBeforeRestart()', 'inactivateEdgeRoutingGeneration(', 'killRouterIfRunning();', 'stopConfiguredAgents()']) {
        assert.ok(assertAt < restartWhole.indexOf(mutation), mutation);
    }
});

test('profile assert is inspect-only and exits non-zero on a mismatch', async () => {
    reset();
    setProfileFile('qa');
    writeSecretsFile({ PROD: 'true' });
    const { handleProfileCommand } = await import('../../cli/commands/profileCommands.js');
    const before = fs.readFileSync(path.join(workspace, '.ploinky', 'data', '.secrets'), 'utf8');
    await assert.rejects(handleProfileCommand(['assert']), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
    await assert.rejects(handleProfileCommand(['assert', '--profile', 'qa']), codeIs('PLOINKY_PROD_PROFILE_MISMATCH'));
    await assert.doesNotReject(handleProfileCommand(['assert', '--profile', 'prod']));
    await assert.doesNotReject(handleProfileCommand(['assert', '--profile=PROD']));
    await assert.rejects(handleProfileCommand(['assert', '--profile']), /needs a value/);
    await assert.rejects(handleProfileCommand(['assert', '--bogus']), /Usage/);
    assert.equal(fs.readFileSync(PROFILE_PATH, 'utf8').trim(), 'qa');
    assert.equal(fs.readFileSync(path.join(workspace, '.ploinky', 'data', '.secrets'), 'utf8'), before);
});

test('profile show prints the stored and the captured PROD', async () => {
    reset();
    setProfileFile('prod');
    writeSecretsFile({ PROD: 'true' });
    writeCapture({ schema: 1, prod: false, routes: {} });
    const { handleProfileCommand } = await import('../../cli/commands/profileCommands.js');
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
        await handleProfileCommand(['show']);
    } finally {
        console.log = originalLog;
    }
    const text = lines.join('\n');
    assert.match(text, /^PROD: true$/m);
    assert.match(text, /^PROD \(active\): false$/m);
});


test('role-pinned agents receive the workspace environment', () => {
    reset();
    setProfileFile('prod');
    const env = getProfileEnvVars('agent', 'repo', 'embedded');
    assert.equal(env.PLOINKY_PROFILE, 'embedded');
    assert.equal(env.PLOINKY_PROFILE_ENV, 'prod');
    setProfileFile('qa');
    assert.equal(getProfileEnvVars('agent', 'repo', 'embedded').PLOINKY_PROFILE_ENV, 'qa');
});

test('profile command refuses an unknown selection', async () => {
    const { handleProfileCommand } = await import('../../cli/commands/profileCommands.js');
    await assert.rejects(handleProfileCommand(['staging']), /Invalid profile/);
    await assert.rejects(handleProfileCommand(['']), /Invalid profile/);
});


test('core profile assert skips workspace initialization and repository bootstrap', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-profile-assert-'));
    try {
        const main = new URL('../../cli/main.js', import.meta.url).href;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e',
            `const { runCoreCli } = await import(${JSON.stringify(main)}); await runCoreCli(['profile', 'assert']);`], {
            cwd: scratch, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: scratch }, encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(fs.readdirSync(scratch), []);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
