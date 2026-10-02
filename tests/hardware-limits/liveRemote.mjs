// Remote dispatch uses a fixed Node runner and already-staged private input
// files (liveStage.mjs stages them). No host-key bypass or arbitrary remote
// command: every argument is a validated fixed word.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runBoundedProcess } from './liveProcess.mjs';

const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const safePath = value => typeof value === 'string' && /^\/[A-Za-z0-9/_.-]+$/.test(value) && path.normalize(value) === value;
const ip = value => typeof value === 'string' && value.split('.').length === 4
    && value.split('.').every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);

export { safePath };

export function validateRemoteTarget(run) {
    if (!/^[a-f0-9]{32}$/.test(run.runId)) throw new Error('Invalid remote run identity');
    const target = run.target.remote;
    const fields = ['sshBinary', 'sshDigest', 'address', 'hostKeyAlias', 'user', 'knownHosts', 'knownHostsDigest', 'identityFile', 'runPath', 'authorizationPath'];
    if (!target || Object.keys(target).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(target, key))) throw new Error('Incomplete pinned remote target');
    if (!safePath(target.sshBinary) || !safePath(target.knownHosts) || !safePath(target.runPath) || !safePath(target.authorizationPath)
        || !(target.identityFile === null || safePath(target.identityFile)) || !ip(target.address)
        || !/^[A-Za-z0-9.-]{1,255}$/.test(target.hostKeyAlias) || !/^[a-z_][a-z0-9_-]{0,63}$/.test(target.user)
        || !/^sha256:[a-f0-9]{64}$/.test(target.sshDigest) || !/^sha256:[a-f0-9]{64}$/.test(target.knownHostsDigest)) throw new Error('Invalid pinned remote target');
    if (!safePath(run.target.execution?.node?.path) || !safePath(run.target.execution?.source?.root)) throw new Error('Remote Node/source path cannot be represented without a shell expansion');
    if (run.target.ssh?.expectedAddress !== target.address || run.target.ssh?.expectedHostKeyAlias !== target.hostKeyAlias) throw new Error('Remote SSH address/host-key alias mismatch');
    return target;
}

export function assertRemoteArrival(run, connection = process.env.SSH_CONNECTION) {
    const target = validateRemoteTarget(run);
    const fields = String(connection || '').trim().split(/\s+/);
    if (fields.length !== 4 || fields[2] !== target.address || !/^[1-9][0-9]*$/.test(fields[3])) throw new Error('Remote arrival address not proved by SSH_CONNECTION');
    return true;
}

// The fixed SSH options: batch mode, strict host key under the pinned alias
// and known-hosts file, no agent, X11 or port forwarding, no config file.
export function sshOptions(target) {
    const args = ['-T', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-o', 'UpdateHostKeys=no',
        '-o', 'HostKeyAlias=' + target.hostKeyAlias, '-o', 'UserKnownHostsFile=' + target.knownHosts,
        '-o', 'GlobalKnownHostsFile=/dev/null', '-l', target.user];
    if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes');
    return args;
}

export function assertLocalSshPins(target) {
    for (const [file, digest] of [[target.sshBinary, target.sshDigest], [target.knownHosts, target.knownHostsDigest]]) {
        if (fs.realpathSync(file) !== file || sha(fs.readFileSync(file)) !== digest) throw new Error('Local SSH or known-hosts pin changed');
    }
}

export async function dispatchRemoteRun({ run, action, cwd, signal, manifestDigest, processProvider = runBoundedProcess, authorizationPath = null }) {
    const target = validateRemoteTarget(run);
    if (!['provision', 'live', 'cleanup'].includes(action)) throw new Error('Invalid fixed remote action');
    if (authorizationPath !== null && !safePath(authorizationPath)) throw new Error('Invalid remote authorization path');
    if (!/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) throw new Error('Missing remote manifest digest binding');
    assertLocalSshPins(target);
    const args = sshOptions(target);
    args.push(target.address, run.target.execution.node.path,
        path.join(run.target.execution.source.root, 'tests/hardware-limits/verify.mjs'), action,
        '--run', target.runPath, '--authorization', authorizationPath || target.authorizationPath, '--remote-local', run.runId, '--expected-manifest-digest', manifestDigest);
    const result = await processProvider(target.sshBinary, args, {
        cwd, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK },
        deadlineMs: 1530000, maxBytes: 1048576, signal,
    });
    if (result.signal || result.errorCode || result.timedOut || result.truncated || result.cancelled || result.settlementForced || ![0,1,2,3].includes(result.status)) {
        throw new Error('Remote command incomplete; retain manifest and reconcile the bounded remote runner before retrying');
    }
    let report; try { report = JSON.parse(result.stdout); } catch { throw new Error('Remote report missing or incomplete'); }
    if (report.runId !== run.runId || report.exitCode !== result.status || !Array.isArray(report.cases)
        || !['PASS','FAIL','BLOCKED','SKIPPED'].includes(report.verdict)) throw new Error('Remote report identity/status mismatch');
    return report;
}
