import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertAgentHomeMigrationReady } from '../../cli/utils/runtime/agentHomeMigrationPolicy.js';
import { admitManifestRuntimeCapabilities } from '../../cli/sandbox/runtimeCapabilities.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-admission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const code = path.join(root, 'repo', 'app'); fs.mkdirSync(code, { recursive: true });
    fs.writeFileSync(path.join(code, 'home-migration.json'), JSON.stringify({ version: 1, legacyHomeKeys: ['legacy'] }));
    return { root, options: { workspaceRoot: root, manifestPath: path.join(code, 'manifest.json'), instanceName: 'app' } };
}
for (const kind of ['container', 'bwrap', 'seatbelt']) {
    test(`${kind} admission refuses unmigrated storage even when a new database already exists`, t => {
        const { root, options } = fixture(t);
        for (const key of ['legacy', 'app']) {
            fs.mkdirSync(path.join(root, '.data', 'agents', key), { recursive: true });
            fs.writeFileSync(path.join(root, '.data', 'agents', key, 'state.sqlite'), key);
        }
        assert.throws(() => admitManifestRuntimeCapabilities({}, { ...options, agentId: 'repo/app', runtimeKind: kind, insideBox: false }), /legacy storage still exists/);
        assert.equal(fs.readFileSync(path.join(root, '.data', 'agents', 'app', 'state.sqlite'), 'utf8'), 'app');
    });
}
test('fresh installations and migrated homes pass; aliases retaining the original home pass', t => {
    const { root, options } = fixture(t);
    assert.doesNotThrow(() => assertAgentHomeMigrationReady(options));
    fs.mkdirSync(path.join(root, '.data', 'agents', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.data', 'agents', 'legacy', 'state.sqlite'), 'original');
    assert.doesNotThrow(() => assertAgentHomeMigrationReady({ ...options, instanceName: 'legacy' }));
    fs.renameSync(path.join(root, '.data', 'agents', 'legacy'), path.join(root, '.data', 'agents', 'app'));
    assert.doesNotThrow(() => assertAgentHomeMigrationReady(options));
});
test('refuses flat legacy storage, dangling links, malformed metadata and pending migrations', t => {
    const { root, options } = fixture(t);
    fs.mkdirSync(path.join(root, '.data'), { recursive: true });
    fs.symlinkSync('/missing-target', path.join(root, '.data', 'legacy'));
    assert.throws(() => assertAgentHomeMigrationReady(options), /legacy storage/);
    fs.unlinkSync(path.join(root, '.data', 'legacy'));
    fs.writeFileSync(path.join(path.dirname(options.manifestPath), 'home-migration.json'), '{"version":1,"legacyHomeKeys":["../dpu-data"]}');
    assert.throws(() => assertAgentHomeMigrationReady(options), /invalid home/);
    fs.mkdirSync(path.join(root, '.ploinky'));
    fs.writeFileSync(path.join(root, '.ploinky', 'agent-home-migration-pending.json'), '{}');
    assert.throws(() => assertAgentHomeMigrationReady(options), /interrupted migration/);
});

test('launch admission stops before bootstrap can create a second database', t => {
    const { root, options } = fixture(t);
    fs.mkdirSync(path.join(root, '.data', 'agents', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.data', 'agents', 'legacy', 'state.sqlite'), 'original');
    const target = path.join(root, '.data', 'agents', 'app');
    assert.throws(() => {
        admitManifestRuntimeCapabilities({}, { ...options, agentId: 'repo/app', insideBox: false });
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'state.sqlite'), 'new');
    }, /legacy storage still exists/);
    assert.equal(fs.existsSync(target), false);
});
