// Fixed gated transport worker. Command payload travels only over inherited IPC.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const [identity, gatePath] = process.argv.slice(2);
let released = false, stopping = false;
const stop = () => {
    if (stopping) return;
    stopping = true;
    try { process.kill(-process.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 250);
};
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
const gateTimer = setTimeout(stop, 2000);
process.on('message', message => {
    if (stopping || released) return;
    if (!message || message.type !== 'release' || message.identity !== identity || !process.connected) { stop(); return; }
    let fd;
    try {
        fd = fs.openSync(gatePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
            || stat.size !== identity.length || fs.readFileSync(fd, 'utf8') !== identity) throw Error('Closed gate');
        fs.unlinkSync(gatePath);
    } catch { stop(); return; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    released = true;
    clearTimeout(gateTimer);
    const { binary, args, cwd, env } = message;
    try {
        const child = spawn(binary, args, { cwd, env, shell: false, detached: false, stdio: ['inherit', 'inherit', 'inherit'] });
        child.on('error', error => {
            if (process.connected) process.send({ type: 'spawnError', code: error.code || 'SPAWN_ERROR' }, () => process.exit(125));
            else stop();
        });
        child.on('exit', (status, signal) => {
            if (stopping) return;
            if (process.connected) process.send({ type: 'targetExit', status, signal });
            // Keep the disconnect watchdog alive until ordinary descendants have
            // ended too. A leader's early exit cannot transfer custody to nobody.
            const query = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
                encoding: 'utf8', timeout: 250, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
            });
            if (query.error || query.signal || query.status !== 0) {
                if (process.connected) process.send({ type: 'workerError', code: 'OWNERSHIP_QUERY_FAILED' });
                stop(); return;
            }
            let descendants = false;
            for (const line of query.stdout.trim().split('\n').filter(Boolean)) {
                const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
                if (!row) {
                    if (process.connected) process.send({ type: 'workerError', code: 'OWNERSHIP_QUERY_FAILED' });
                    descendants = true; break;
                }
                if (Number(row[2]) === process.pid && ![process.pid, query.pid].includes(Number(row[1])) && !row[3].startsWith('Z')) descendants = true;
            }
            if (descendants) { stop(); return; }
            if (signal) {
                process.removeAllListeners(signal);
                process.kill(process.pid, signal);
            } else process.exit(status ?? 125);
        });
    } catch { process.exit(125); }
});
if (!/^[a-f0-9]{32}$/.test(identity || '') || !gatePath || !process.connected) stop();
else process.send({ type: 'ready', identity });
