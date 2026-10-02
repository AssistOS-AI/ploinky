import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateProbe } from '../hardware-limits/liveCaseCommands.mjs';
import { dispatchRemoteRun } from '../hardware-limits/liveRemote.mjs';
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
test('forced settlement rejects a nominally successful CUDA transport', () => {
    assert.throws(() => validateProbe({ status: 0, stdout: '{}', settlementForced: true }, { maxMiB: 128 }), /transport failed/);
});
test('forced settlement rejects valid remote PASS JSON', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-forced-'));
    t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    const ssh = path.join(root, 'ssh'), knownHosts = path.join(root, 'known_hosts');
    fs.writeFileSync(ssh, 'fixed fake binary'); fs.writeFileSync(knownHosts, 'fixed fake public host pin');
    const run = {runId:'a'.repeat(32),target:{
        remote:{sshBinary:ssh,sshDigest:digest('fixed fake binary'),address:'192.0.2.10',hostKeyAlias:'fixture',user:'fixture',knownHosts,knownHostsDigest:digest('fixed fake public host pin'),identityFile:null,runPath:'/tmp/run.json',authorizationPath:'/tmp/authorization.json'},
        ssh:{expectedAddress:'192.0.2.10',expectedHostKeyAlias:'fixture'},execution:{node:{path:'/usr/bin/node'},source:{root:'/opt/fixture'}},
    }};
    await assert.rejects(dispatchRemoteRun({run,action:'live',cwd:root,manifestDigest:digest('manifest'),processProvider:async()=>({status:0,stdout:JSON.stringify({runId:run.runId,exitCode:0,verdict:'PASS',cases:[]}),settlementForced:true})}),/incomplete/);
});
