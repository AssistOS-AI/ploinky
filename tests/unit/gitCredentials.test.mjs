import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A temporary workspace outside the Box: the master key comes from the
// environment, exactly as for a host runtime.
const originalEnv = {
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
};
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-git-credentials-')));
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const {
    GIT_CREDENTIALS_SCHEMA,
    decryptGitCredentials,
    encryptGitCredentials,
    ensureGitCredentialsDir,
    gitCredentialsKey,
    gitCredentialsKeyHex,
    readGitCredentials,
    resolveGitCredentialsDir,
    withGitCredentialEnv,
} = await import('../../cli/utils/git/gitCredentials.js');
const { deriveSubkey } = await import('../../cli/utils/security/masterKey.js');
const { runGit, runGitWithoutCredentials } = await import('../../cli/utils/git/gitExec.js');
const { runGitCommand } = await import('../../cli/utils/gitCommand.js');
const { gitLookupEnv } = await import('../../cli/utils/dependencies/store/gitPins.mjs');
const { controllerGuardTargets } = await import('../../cli/utils/runtime/controllerStateGuards.js');
const { AGENT_DATA_POLICY_CODE } = await import('../../cli/utils/runtime/agentDataPathPolicy.js');

const TOKEN = 'ghp_unitTestTokenValue0123456789';
const credentialsDir = path.join(workspace, '.data', '.private', '.git-credentials');
const mirrorFile = path.join(credentialsDir, 'credentials.json');
const expectedHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

// Writes a mirror exactly as the contract describes it, independently of
// encryptGitCredentials, so the reader is checked against the format itself.
function writeContractMirror(payload, key = gitCredentialsKey(), { aad = GIT_CREDENTIALS_SCHEMA } = {}) {
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const envelope = {
        schema: 'ploinky-git-credentials-v1',
        alg: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
    };
    fs.writeFileSync(mirrorFile, JSON.stringify(envelope), { mode: 0o600 });
    return envelope;
}

const validPayload = { host: 'github.com', username: 'x-access-token', token: TOKEN, updatedAt: '2026-11-10T00:00:00.000Z' };

function policyFailure(fn) {
    assert.throws(fn, error => error?.code === AGENT_DATA_POLICY_CODE);
}

test.afterEach(() => {
    fs.rmSync(mirrorFile, { force: true });
});

test.after(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('the mirror key is the git-credentials-v1 subkey, exposed as 64 lowercase hex characters', () => {
    const key = gitCredentialsKey();
    assert.equal(key.length, 32);
    assert.deepEqual(key, deriveSubkey('git-credentials-v1', 32));
    assert.match(gitCredentialsKeyHex(), /^[0-9a-f]{64}$/);
    assert.equal(gitCredentialsKeyHex(), key.toString('hex'));
});

test('a mirror encrypted with the derived key is read back from the default directory', () => {
    assert.equal(resolveGitCredentialsDir(workspace, { override: '' }), credentialsDir);
    writeContractMirror(validPayload);
    assert.deepEqual(readGitCredentials({ workspaceRoot: workspace, override: '' }), {
        host: 'github.com',
        username: 'x-access-token',
        token: TOKEN,
    });
    // The default workspace root follows PLOINKY_WORKSPACE_ROOT.
    assert.equal(readGitCredentials({ override: '' })?.token, TOKEN);
    // encryptGitCredentials produces the same format.
    const envelope = encryptGitCredentials(validPayload, gitCredentialsKey());
    assert.equal(decryptGitCredentials(envelope, gitCredentialsKey())?.token, TOKEN);
});

test('a missing, malformed, foreign or undecryptable mirror means no credentials', () => {
    const read = () => readGitCredentials({ workspaceRoot: workspace, override: '' });
    assert.equal(read(), null);

    writeContractMirror(validPayload, crypto.randomBytes(32));
    assert.equal(read(), null, 'wrong key');

    writeContractMirror(validPayload, gitCredentialsKey(), { aad: 'other-aad' });
    assert.equal(read(), null, 'wrong AAD');

    const envelope = writeContractMirror(validPayload);
    const tampered = { ...envelope, tag: Buffer.alloc(16).toString('base64') };
    fs.writeFileSync(mirrorFile, JSON.stringify(tampered));
    assert.equal(read(), null, 'tampered tag');

    fs.writeFileSync(mirrorFile, JSON.stringify({ ...envelope, schema: 'other' }));
    assert.equal(read(), null, 'foreign schema');

    fs.writeFileSync(mirrorFile, '{not json');
    assert.equal(read(), null, 'bad JSON');

    writeContractMirror({ ...validPayload, host: 'gitlab.com' });
    assert.equal(read(), null, 'non-GitHub host');

    writeContractMirror({ ...validPayload, token: 'abc\nInjected: header' });
    assert.equal(read(), null, 'header injection');

    writeContractMirror({ ...validPayload, token: '' });
    assert.equal(read(), null, 'empty token');

    assert.equal(decryptGitCredentials(null, gitCredentialsKey()), null);
    assert.equal(decryptGitCredentials(envelope, Buffer.alloc(3)), null);
});

test('credential env is appended after existing GIT_CONFIG entries and never changes the input', () => {
    const credentials = { host: 'github.com', username: 'x-access-token', token: TOKEN };
    const base = {
        PATH: '/usr/bin',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'a.b',
        GIT_CONFIG_VALUE_0: '1',
        GIT_CONFIG_KEY_1: 'c.d',
        GIT_CONFIG_VALUE_1: '2',
    };
    const result = withGitCredentialEnv(base, { credentials });
    assert.equal(result.GIT_CONFIG_COUNT, '3');
    assert.equal(result.GIT_CONFIG_KEY_0, 'a.b');
    assert.equal(result.GIT_CONFIG_KEY_1, 'c.d');
    assert.equal(result.GIT_CONFIG_KEY_2, 'http.https://github.com/.extraheader');
    assert.equal(result.GIT_CONFIG_VALUE_2, expectedHeader);
    assert.equal(base.GIT_CONFIG_COUNT, '2');
    assert.equal(base.GIT_CONFIG_KEY_2, undefined);

    const fresh = withGitCredentialEnv({ PATH: '/usr/bin' }, { credentials });
    assert.equal(fresh.GIT_CONFIG_COUNT, '1');
    assert.equal(fresh.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');

    assert.deepEqual(withGitCredentialEnv(base, { credentials: null }), base);

    // The dependency pin lookup keeps its two GitHub rewrites first.
    const lookup = gitLookupEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x.y', GIT_CONFIG_VALUE_0: 'z' }, { credentials });
    assert.equal(lookup.GIT_CONFIG_COUNT, '4');
    assert.equal(lookup.GIT_CONFIG_KEY_0, 'x.y');
    assert.equal(lookup.GIT_CONFIG_KEY_1, 'url.https://github.com/.insteadOf');
    assert.equal(lookup.GIT_CONFIG_KEY_2, 'url.https://github.com/.insteadOf');
    assert.equal(lookup.GIT_CONFIG_KEY_3, 'http.https://github.com/.extraheader');
    assert.equal(lookup.GIT_CONFIG_VALUE_3, expectedHeader);
});

test('git runners add the header through the environment only, and the self-update runner does not', () => {
    writeContractMirror(validPayload);
    const calls = [];
    const spawn = (command, argv, options) => {
        calls.push({ command, argv, env: options.env });
        return { status: 0, stdout: '', stderr: '' };
    };
    runGit(workspace, ['ls-remote', 'origin'], { spawn, env: { PATH: process.env.PATH } });
    runGitWithoutCredentials(workspace, ['ls-remote', 'origin'], { spawn, env: { PATH: process.env.PATH } });
    assert.equal(calls[0].env.GIT_CONFIG_VALUE_0, expectedHeader);
    assert.equal(calls[1].env.GIT_CONFIG_COUNT, undefined);
    for (const call of calls) assert.equal(JSON.stringify(call.argv).includes(TOKEN), false);

    // Real git sees the header as configuration, while argv carries no secret.
    const configured = runGitCommand(['config', '--get-all', 'http.https://github.com/.extraheader'], {
        stdio: 'pipe', cwd: workspace, encoding: 'utf8',
    });
    assert.equal(String(configured).trim(), expectedHeader);
    assert.throws(() => runGitCommand(['config', '--get-all', 'http.https://github.com/.extraheader'], {
        stdio: 'pipe', cwd: workspace, encoding: 'utf8', gitCredentials: false,
    }), error => !String(error.message).includes(TOKEN));
});

test('a failing git command never reports the token', () => {
    writeContractMirror(validPayload);
    const result = runGit(workspace, ['ls-remote', '--quiet', path.join(workspace, 'missing-remote')]);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.throws(
        () => runGitCommand(['-C', workspace, 'ls-remote', path.join(workspace, 'missing-remote')], { stdio: 'pipe' }),
        error => !String(error.message).includes(TOKEN) && !String(error.stderr || '').includes(TOKEN),
    );
});

test('the directory override stays inside the workspace and outside protected state', () => {
    assert.equal(resolveGitCredentialsDir(workspace, { override: '.data/git' }), path.join(workspace, '.data', 'git'));
    assert.equal(resolveGitCredentialsDir(workspace, { override: path.join(workspace, 'creds') }), path.join(workspace, 'creds'));
    assert.equal(
        resolveGitCredentialsDir(workspace, { override: '.data/.private/.git-credentials' }),
        credentialsDir,
    );

    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-git-credentials-outside-')));
    try {
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: '../escape' }));
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: outside }));
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: '.' }));
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: 'a/../../escape' }));
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: '.ploinky/data/git' }));
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: '.ploinky-box/git' }));
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: '.data/.private/otherAgent' }));
        fs.symlinkSync(outside, path.join(workspace, 'link-out'));
        policyFailure(() => resolveGitCredentialsDir(workspace, { override: 'link-out/creds' }));
        // An escaping override is "no credentials" for git, never a crash.
        assert.equal(readGitCredentials({ workspaceRoot: workspace, override: '../escape' }), null);
        assert.equal(withGitCredentialEnv({ A: '1' }, { workspaceRoot: workspace, override: '../escape' }).GIT_CONFIG_COUNT, undefined);
    } finally {
        fs.rmSync(path.join(workspace, 'link-out'), { force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('ensureGitCredentialsDir creates a private 0700 directory', () => {
    fs.rmSync(path.join(workspace, '.data'), { recursive: true, force: true });
    const dir = ensureGitCredentialsDir(workspace, { override: '' });
    assert.equal(dir, credentialsDir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(workspace, '.data', '.private')).mode & 0o777, 0o700);
});

test('runtime guards admit only the exact granted private directory', () => {
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const other = path.join(workspace, '.data', '.private', 'other');
    fs.mkdirSync(other, { recursive: true });
    const bind = hostPath => [{ hostPath, runtimePath: '/git-credentials' }];
    policyFailure(() => controllerGuardTargets(bind(credentialsDir), { workspaceRoot: workspace }));
    assert.deepEqual(controllerGuardTargets(bind(credentialsDir), {
        workspaceRoot: workspace,
        privateDataGrants: [credentialsDir],
    }), []);
    policyFailure(() => controllerGuardTargets(bind(other), {
        workspaceRoot: workspace,
        privateDataGrants: [credentialsDir],
    }));
    const privateRoot = path.join(workspace, '.data', '.private');
    policyFailure(() => controllerGuardTargets(bind(privateRoot), {
        workspaceRoot: workspace,
        privateDataGrants: [privateRoot],
    }));
});
