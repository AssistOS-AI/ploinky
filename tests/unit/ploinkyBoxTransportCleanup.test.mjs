import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeTransportPair } from '../../ploinky-box/entrypoint/transport.mjs';

// Post-commit cleanup of the transport pair. Once both files are committed the
// pair is the result: a failure to delete a `.backup` prior-inode link is a
// warning (never a thrown error or a rollback), and the next committed write
// removes the leftover links instead of accumulating them.

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-transport-cleanup-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const transportFile = path.join(root, 'run', 'ploinky', 'box-transport.json');
    const containersConf = path.join(root, 'home', 'containers', 'containers.conf');
    for (const target of [transportFile, containersConf]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `prior ${path.basename(target)}\n`, { mode: 0o600 });
    }
    return { transportFile, containersConf };
}

const listing = paths => [paths.transportFile, paths.containersConf]
    .map(target => fs.readdirSync(path.dirname(target)).sort());

const failingBackupUnlink = {
    ...fs,
    unlinkSync(target) {
        if (String(target).endsWith('.backup')) throw Object.assign(new Error('backup unlink failed'), { code: 'EIO' });
        return fs.unlinkSync(target);
    },
};

test('a backup that cannot be deleted after both transport files commit is a warning, not a failure', (t) => {
    const paths = fixture(t);
    const result = writeTransportPair({
        transport: { address: '10.88.0.17', interface: 'eth0' },
        ...paths,
        fsApi: failingBackupUnlink,
    });
    assert.equal(result.transportFile, paths.transportFile);
    assert.equal(result.containersConf, paths.containersConf);
    assert.equal(result.warnings.length, 2, 'both leftover backups are named');
    for (const warning of result.warnings) assert.match(warning, /transport backup .*\.backup could not be removed: backup unlink failed/);
    assert.equal(fs.readFileSync(paths.transportFile, 'utf8'), '{"address":"10.88.0.17","interface":"eth0"}\n');
    assert.equal(fs.readFileSync(paths.containersConf, 'utf8'), '[containers]\ndefault_sysctls=[]\n');
    for (const target of [paths.transportFile, paths.containersConf]) assert.equal(fs.statSync(target).nlink, 1);
    const [run, conf] = listing(paths);
    assert.equal(run.filter(entry => entry.endsWith('.backup')).length, 1);
    assert.equal(conf.filter(entry => entry.endsWith('.backup')).length, 1);
});

test('the next committed transport write removes backups an earlier write left behind', (t) => {
    const paths = fixture(t);
    writeTransportPair({ transport: { address: '10.88.0.17', interface: 'eth0' }, ...paths, fsApi: failingBackupUnlink });
    // An unrelated file that only resembles a backup is left alone.
    const unrelated = path.join(path.dirname(paths.transportFile), '.box-transport.json.notatoken.0.backup');
    fs.writeFileSync(unrelated, 'keep\n');
    const result = writeTransportPair({ transport: { address: '10.88.0.18', interface: 'eth0' }, ...paths });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(listing(paths), [
        ['.box-transport.json.notatoken.0.backup', 'box-transport.json'],
        ['containers.conf'],
    ]);
    assert.equal(fs.readFileSync(paths.transportFile, 'utf8'), '{"address":"10.88.0.18","interface":"eth0"}\n');
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep\n');
});
