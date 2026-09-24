import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tx from '../../cli/utils/skills/exportTransaction.mjs';
import * as legacy from './fixtures/legacySkillExports.mjs';
import { liveness, simulatedCrash } from './fixtures/skillExportConformanceScenarios.mjs';

function fixture(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-compat-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const folder = path.join(base, 'target');
    fs.mkdirSync(folder);
    const source = name => {
        const directory = path.join(base, 'sources', name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'SKILL.md'), `# ${name}\n`);
        return directory;
    };
    const agents = path.join(folder, '.agents');
    return { base, folder, source, agents, lock: path.join(agents, tx.EXPORT_LOCK), ledger: () => JSON.parse(fs.readFileSync(path.join(agents, tx.EXPORT_LEDGER), 'utf8')) };
}

// A process that has exited: same boot and PID namespace, affirmatively dead.
function deadIdentity() {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    return { ...tx.currentSkillExportIdentity(), pid: child.pid, start: '' };
}

test('the pre-transaction exporter fails with EEXIST while a transaction holds the lock', t => {
    const f = fixture(t);
    const held = tx.acquireSkillExportLock(f.folder);
    assert.throws(() => legacy.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [] }), /already active \(or interrupted; inspect lock\)/);
    assert.ok(fs.existsSync(path.join(f.lock, 'owner.json')), 'the old exporter leaves the new lock intact');
    held.release();
    legacy.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [] });
});

test('an ownerless lock from the pre-transaction exporter is preserved and reported', t => {
    const f = fixture(t);
    legacy.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'one', path: f.source('one') }] });
    fs.mkdirSync(f.lock);
    assert.throws(() => tx.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [], lock: { waitMs: 0 } }),
        error => error.code === 'SKILL_EXPORT_LOCK_OWNERLESS');
    assert.deepEqual(fs.readdirSync(f.lock), []);
    assert.ok(fs.existsSync(path.join(f.agents, 'skills', 'one')));
});

test('old exporters read marketplace ledger entries as foreign ownership and keep them', t => {
    const f = fixture(t);
    const alpha = f.source('alpha');
    tx.withSkillExportLocks([f.folder], ([handle]) => tx.publishSkillExports(handle, {
        owner: tx.MARKETPLACE_OWNER, policy: 'additive', sources: [{ name: 'alpha', path: alpha }],
    }));
    const result = legacy.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', mode: 'symlink', sources: [{ name: 'alpha', path: alpha }] });
    assert.equal(result.diagnostics[0].reason, 'owned-by-other-export');
    assert.equal(f.ledger().entries.alpha.owner, tx.MARKETPLACE_OWNER);
});

test('old code ignores a pending journal; recovery restores owned paths and preserves the ledger it rewrote', t => {
    const f = fixture(t);
    const replace = f.source('replace');
    tx.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'replace', path: replace }], lock: { liveness: liveness(100) } });
    fs.writeFileSync(path.join(replace, 'SKILL.md'), '# replace v2\n');
    assert.throws(() => tx.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'replace', path: replace }],
        lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-link') }), /simulated crash/);
    // A downgraded exporter is blocked by the abandoned transaction lock.
    assert.throws(() => legacy.syncManagedSkillExports({ folder: f.folder, owner: 'defaults:x', sources: [] }), /already active/);
    // An operator removes the lock by hand; the old exporter then runs.
    fs.rmSync(f.lock, { recursive: true });
    const old = legacy.syncManagedSkillExports({ folder: f.folder, owner: 'defaults:x', sources: [{ name: 'other', path: f.source('other') }] });
    assert.deepEqual(old.installed, ['other']);
    assert.ok(fs.existsSync(path.join(f.agents, tx.EXPORT_JOURNAL)), 'the old exporter neither reads nor removes the journal');
    assert.equal(f.ledger().entries.replace.digest !== tx.skillTreeDigest(path.join(f.agents, 'skills', 'replace')), true,
        'old code saw the uncommitted replacement as unowned output');

    const recovery = tx.withSkillExportLocks([f.folder], ([handle]) => handle.recovery, { liveness: liveness(300) });
    // Paths still match the transaction evidence, so they roll back; the
    // ledger committed by the other writer is kept and reported.
    assert.equal(recovery.status, 'rolled-back');
    assert.deepEqual(recovery.notes.map(item => item.reason), ['ledger-changed-by-another-writer-preserved']);
    assert.equal(fs.readFileSync(path.join(f.agents, 'skills', 'replace', 'SKILL.md'), 'utf8'), '# replace\n');
    assert.equal(f.ledger().entries.other.owner, 'defaults:x');
    assert.equal(f.ledger().entries.replace.digest, tx.skillTreeDigest(path.join(f.agents, 'skills', 'replace')));
    const next = tx.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'replace', path: replace }], lock: { liveness: liveness(300) } });
    assert.deepEqual(next.installed, ['replace']);
});

test('interrupted rollout: an old exporter stays blocked until a transaction-aware exporter recovers', t => {
    const f = fixture(t);
    const one = f.source('one');
    const dead = deadIdentity();
    if (!dead.boot || !dead.namespace) { t.skip('this platform exposes no boot or PID namespace identity'); return; }
    assert.throws(() => tx.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'one', path: one }],
        lock: { liveness: { current: () => dead } }, hooks: simulatedCrash(tx, 'after-link') }), /simulated crash/);
    assert.throws(() => legacy.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'one', path: one }] }), /already active/);
    assert.equal(tx.readSkillExportTransactionState(f.folder).pending.phase, 'prepared');
    const result = tx.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'one', path: one }], lock: { waitMs: 0 } });
    assert.equal(result.recovery.status, 'rolled-back');
    assert.deepEqual(result.installed, ['one']);
    assert.deepEqual(legacy.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [{ name: 'one', path: one }] }).unchanged, ['one']);
});
