import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate from any real .env walked up from the repo: run inside a temp cwd and
// drive derivation purely from process.env.PLOINKY_MASTER_KEY.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agentsecret-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const moduleSuffix = `?test=${Date.now()}`;
const {
    deriveAgentRequestSecret,
    deriveDerivedMasterKey,
    deriveSubkey,
    resolveMasterKey,
    MASTER_KEY_VAR,
} = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);

process.env[MASTER_KEY_VAR] = 'f'.repeat(64);

const AGENT_A = 'agent:AssistOSExplorer/dpuAgent';
const AGENT_B = 'agent:AssistOSExplorer/gitAgent';

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('deriveAgentRequestSecret is deterministic for the same agent id', () => {
    assert.equal(deriveAgentRequestSecret(AGENT_A), deriveAgentRequestSecret(AGENT_A));
});

test('deriveAgentRequestSecret yields different secrets for different agent ids', () => {
    assert.notEqual(deriveAgentRequestSecret(AGENT_A), deriveAgentRequestSecret(AGENT_B));
});

test('deriveAgentRequestSecret returns 32 bytes (64 hex chars) by default', () => {
    const hex = deriveAgentRequestSecret(AGENT_A);
    assert.equal(typeof hex, 'string');
    assert.equal(hex.length, 64);
    assert.match(hex, /^[0-9a-f]{64}$/);
});

test('deriveAgentRequestSecret({encoding:"buffer"}) returns a 32-byte Buffer matching the hex form', () => {
    const buf = deriveAgentRequestSecret(AGENT_A, { encoding: 'buffer' });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, 32);
    assert.equal(buf.toString('hex'), deriveAgentRequestSecret(AGENT_A));
});

test('per-agent secret is NOT the shared derived-master key', () => {
    assert.notEqual(deriveAgentRequestSecret(AGENT_A), deriveDerivedMasterKey().toString('hex'));
    // Nor the master key itself.
    assert.notEqual(deriveAgentRequestSecret(AGENT_A), resolveMasterKey().toString('hex'));
});

test('per-agent secret matches the canonical DS014 HKDF derivation (independent vector)', () => {
    // Recompute HKDF_SHA256(master, salt="", info="ploinky/agent-secret/<id>/v1", 32)
    // directly, without going through deriveAgentRequestSecret, as an independent check.
    const ikm = resolveMasterKey();
    const info = Buffer.from(`ploinky/agent-secret/${AGENT_A}/v1`, 'utf8');
    const expected = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32)).toString('hex');
    assert.equal(deriveAgentRequestSecret(AGENT_A), expected);
    // And that it equals the deriveSubkey path it is built on.
    assert.equal(deriveAgentRequestSecret(AGENT_A), deriveSubkey(`agent-secret/${AGENT_A}`).toString('hex'));
});

test('deriveAgentRequestSecret requires a non-empty agent id', () => {
    assert.throws(() => deriveAgentRequestSecret(''), /agentId is required/);
    assert.throws(() => deriveAgentRequestSecret(null), /agentId is required/);
    assert.throws(() => deriveAgentRequestSecret(undefined), /agentId is required/);
});
