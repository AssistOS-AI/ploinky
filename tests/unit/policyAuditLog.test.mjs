import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { PolicyAuditLog } = await import(`../../cli/server/policy/PolicyAuditLog.js?t=${Date.now()}`);

test('PolicyAuditLog accepts an explicit audit directory path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-audit-'));
    try {
        const log = new PolicyAuditLog({ dir: tempDir });
        log.record({ user: 'user:admin', command: 'mcp.policy.set', ok: true });

        const auditFile = path.join(tempDir, 'policy-audit.log');
        const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
        assert.equal(lines.length, 1);

        const record = JSON.parse(lines[0]);
        assert.equal(record.user, 'user:admin');
        assert.equal(record.command, 'mcp.policy.set');
        assert.equal(record.ok, true);
        assert.equal(typeof record.ts, 'string');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
