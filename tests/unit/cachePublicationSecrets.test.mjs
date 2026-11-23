import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cwd = process.cwd();
const savedEnv = { ...process.env };
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cache-secrets-'));
const handle = 'publication/example-invalid-purge';
const token = `fake-unit-test-${randomUUID()}`;

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
process.env.PLOINKY_MASTER_KEY = randomUUID();
// Stop .env discovery at the fixture and exercise the inherited-env fallback.
fs.writeFileSync('.env', '');
process.env[handle] = token;

const vars = await import('../../cli/utils/security/secretVars.js');
const { getSecret, getSecrets, validateSecrets } = await import('../../cli/utils/security/secretInjector.js');
const { handleVarsCommand, handleEchoCommand } = await import('../../cli/commands/envVarCommands.js');
const { buildRouterEnv } = await import('../../cli/commands/workspaceUtil.js');
const { planRuntimeResources } = await import('../../cli/utils/runtime/runtimeResourcePlanner.js');
const { buildLifecycleHookEnv } = await import('../../cli/utils/runtime/lifecycleHooks.js');
const { createEncryptedCloudflareSecretStore } = await import('../../ploinky-box/cloudflared/publicationController.mjs');
const { purgeCacheHost } = await import('../../cli/server/cdn/cachePurge.js');
const { configureCachePurge } = await import('../../cli/server/cdn/cachePurgeConfig.js');
const { writeSecretsFile, readSecretsFile } = await import('../../cli/utils/security/encryptedSecretsFile.js');
writeSecretsFile({
    [handle]: token,
    CACHE_TEST_ALIAS: '$CACHE_TEST_INTERMEDIATE',
    CACHE_TEST_INTERMEDIATE: `$${handle}`,
    CACHE_TEST_SAFE: 'visible',
    CACHE_TEST_SAFE_ALIAS: '$CACHE_TEST_SAFE',
});

test('controller and Router read the encrypted publication handle without exposing its value', async () => {
    assert.ok(createEncryptedCloudflareSecretStore().readAll()[handle] === token);
    assert.ok(vars.hasSecretHandle(handle) === true);
    assert.equal(vars.hasSecretHandle('publication/missing'), false);
    assert.equal(vars.hasSecretHandle('toString'), false);
    const stored = fs.readFileSync('.ploinky/data/.secrets', 'utf8');
    assert.equal(stored.includes(token), false);
    const host = 'purge.example.test';
    const generation = { publicationState: 'ready', compiled: { hosts: { [host]: {} } } };
    configureCachePurge({ host, zoneId: 'e'.repeat(32), secretHandle: handle }, {
        loadActive: () => ({ generation }), withLock: callback => callback(),
    });
    const result = await purgeCacheHost({ host, by: 'test-operator', generation, assertCurrent() {} }, {
        api: { async purgeHosts({ apiToken }) { assert.ok(apiToken === token); } },
    });
    assert.deepEqual(result, { host, outcome: 'accepted' });
    for (const file of ['cache-purge.json', 'cache-purge-results/' + host + '.json']) {
        assert.ok(!fs.readFileSync(path.join('.ploinky/data', file), 'utf8').includes(token));
    }
});

test('agent secret injection treats publication handles as missing in every source', () => {
    const fileHandle = 'publication/cache-file';
    const envFileHandle = 'publication/cache-env-file';
    writeSecretsFile({ ...readSecretsFile(), [fileHandle]: token });
    fs.writeFileSync('.env', envFileHandle + '=fixture\n');
    const denied = [handle, fileHandle, envFileHandle];
    for (const name of denied) assert.ok(getSecret(name) === undefined);
    assert.equal(getSecret('CACHE_TEST_SAFE'), 'visible');
    const names = [...denied, 'CACHE_TEST_SAFE'];
    const secrets = getSecrets(names);
    assert.deepEqual(Object.keys(secrets), ['CACHE_TEST_SAFE']);
    assert.equal(secrets.CACHE_TEST_SAFE, 'visible');
    assert.deepEqual(validateSecrets(names), {
        valid: false, missing: denied, source: { CACHE_TEST_SAFE: '.secrets file' },
    });
});

test('agent variable and persistent-secret lookups cannot read or replace a protected handle or alias', () => {
    for (const name of [handle, 'CACHE_TEST_ALIAS']) {
        assert.throws(() => vars.resolveVarValue(name), { code: 'PLOINKY_PUBLICATION_SECRET_RESERVED' });
        assert.ok(vars.ensurePersistentSecret(name) === '');
    }
    const stored = readSecretsFile();
    assert.ok(stored[handle] === token);
    assert.ok(stored.CACHE_TEST_ALIAS === '$CACHE_TEST_INTERMEDIATE');
});

test('agent profiles cannot inject publication handles through their separate required-secrets list', () => {
    for (const name of [handle, 'CACHE_TEST_ALIAS']) {
        const profileConfig = { secrets: [name] };
        const denied = { code: 'PLOINKY_PUBLICATION_SECRET_RESERVED' };
        assert.throws(() => vars.buildEnvFlags({}, profileConfig), denied);
        assert.throws(() => vars.buildEnvMap({}, profileConfig), denied);
        assert.throws(() => buildLifecycleHookEnv({
            agentName: 'fixture', repoName: 'fixture', profileName: 'fixture',
            profileConfig, agentPath: workspace,
        }), denied);
    }
    const safe = buildLifecycleHookEnv({
        agentName: 'fixture', repoName: 'fixture', profileName: 'fixture',
        profileConfig: { secrets: ['CACHE_TEST_SAFE'] }, agentPath: workspace,
    });
    assert.ok(safe.CACHE_TEST_SAFE === 'visible');
});

test('runtime-resource templates refuse publication handles and protected aliases before ambient fallback', () => {
    const resources = template => ({ runtime: { resources: { env: { TARGET: template } } } });
    process.env.CACHE_TEST_ALIAS = token;
    process.env.CACHE_TEST_AMBIENT = 'ambient-fixture';
    try {
        for (const name of [handle, 'CACHE_TEST_ALIAS']) {
            assert.throws(() => planRuntimeResources(resources(`{{var:${name}}}`)), {
                code: 'PLOINKY_PUBLICATION_SECRET_RESERVED',
            });
            assert.ok(planRuntimeResources(resources(`{{secret:${name}}}`)).env.TARGET === '');
        }
        assert.ok(planRuntimeResources(resources('{{var:CACHE_TEST_SAFE_ALIAS}}')).env.TARGET === 'visible');
        for (const kind of ['var', 'secret']) {
            const plan = planRuntimeResources(resources(`{{${kind}:CACHE_TEST_AMBIENT}}`));
            assert.ok(plan.env.TARGET === 'ambient-fixture');
        }
    } finally {
        delete process.env.CACHE_TEST_ALIAS;
        delete process.env.CACHE_TEST_AMBIENT;
    }
});

test('the Watchdog and Router environment excludes publication credentials from all merged sources', () => {
    // The .env fixture needs only a marker to detect a missed source.
    fs.writeFileSync('.env', 'publication/from-env-file=fixture\n');
    const routerEnv = buildRouterEnv({ managedBox: true });
    assert.ok(!Object.hasOwn(routerEnv, handle));
    assert.ok(!Object.hasOwn(routerEnv, 'publication/from-env-file'));
    assert.ok(!Object.values(routerEnv).includes(token));
    assert.ok(routerEnv.CACHE_TEST_SAFE === 'visible');
});

test('manifest env, profile overrides and wildcard expansion exclude publication credentials', () => {
    for (const manifest of [
        { env: [handle, { name: 'DIRECT', varName: handle }, 'CACHE_TEST_ALIAS', 'CACHE_TEST_SAFE_ALIAS'] },
        { env: { DIRECT: { name: handle }, INDIRECT: { varName: 'CACHE_TEST_ALIAS' }, CACHE_TEST_SAFE_ALIAS: {} } },
        { env: ['*'] },
        { env: ['publication/*', 'CACHE_TEST_*'] },
    ]) {
        for (const profile of [undefined, { env: manifest.env }]) {
            const map = vars.buildEnvMap(manifest, profile);
            const flags = vars.buildEnvFlags(manifest, profile);
            assert.ok(map.CACHE_TEST_SAFE_ALIAS === 'visible');
            assert.ok(flags.includes('-e CACHE_TEST_SAFE_ALIAS="visible"'));
            for (const name of [handle, 'DIRECT', 'INDIRECT', 'CACHE_TEST_ALIAS', 'CACHE_TEST_INTERMEDIATE']) {
                assert.ok(!Object.hasOwn(map, name));
                assert.ok(!flags.some(flag => flag.startsWith(`-e ${name}=`)));
            }
            assert.ok(!Object.values(map).includes(token));
            assert.ok(!flags.some(flag => flag.includes(token)));
        }
    }
    assert.equal(vars.expandEnvWildcard('*').includes(handle), false);
    assert.equal(vars.expandEnvWildcard('publication/*').includes(handle), false);
});

test('a publication alias cannot provide a required value or an explicit generated-secret override', () => {
    const manifest = { env: [
        { name: 'REQUIRED', varName: 'CACHE_TEST_ALIAS', required: true },
        { name: 'GENERATED', varName: 'CACHE_TEST_ALIAS', sharedGeneratedSecret: true, explicitOverride: true },
        { name: 'DEPENDENT', varName: 'CACHE_TEST_SAFE', sharedGeneratedSecret: true, explicitOverrideRequires: [handle] },
    ] };
    const env = vars.buildEnvMap(manifest, null, { deriveWorkspaceSecret: () => 'derived-fixture' });
    assert.ok(!Object.hasOwn(env, 'REQUIRED'));
    assert.ok(!Object.hasOwn(env, 'GENERATED'));
    assert.ok(env.DEPENDENT === 'derived-fixture');
    assert.throws(() => vars.buildEnvFlags(manifest), { code: 'PLOINKY_ENV_REQUIRED_MISSING' });
});

test('both expose forms refuse direct and transitive references and preserve ordinary aliases', () => {
    for (const expose of [
        [{ name: 'DIRECT', ref: handle }, { name: 'INDIRECT', ref: 'CACHE_TEST_ALIAS' },
            { name: 'SAFE', ref: 'CACHE_TEST_SAFE_ALIAS' }],
        { DIRECT: `$${handle}`, INDIRECT: '$CACHE_TEST_ALIAS', SAFE: '$CACHE_TEST_SAFE_ALIAS' },
    ]) {
        const manifest = { expose };
        const env = vars.buildEnvMap(manifest);
        assert.deepEqual(Object.keys(env), ['SAFE']);
        assert.ok(env.SAFE === 'visible');
        const flags = vars.buildEnvFlags(manifest);
        assert.ok(flags.length === 1 && flags[0] === '-e SAFE="visible"');
    }
});

test('echo and vars output never contain the publication token', t => {
    let includedToken = false;
    let includedSafe = false;
    t.mock.method(console, 'log', (...args) => {
        const line = args.join(' ');
        includedToken ||= line.includes(token);
        includedSafe ||= line.includes('CACHE_TEST_SAFE=visible');
    });
    handleVarsCommand();
    for (const name of [handle, `$${handle}`, '$CACHE_TEST_ALIAS']) handleEchoCommand([name]);
    assert.equal(includedSafe, true);
    assert.equal(includedToken, false);
});
