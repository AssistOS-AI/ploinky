// `child_process` for bwrapServiceManager.js under the bwrap host shim (not a
// test file): identical except that spawning /usr/bin/bwrap runs $FAKE_BWRAP.
// When $FAKE_BWRAP_SPAWN_LOG is set, every such spawn is also appended to it
// from the spawning process, as soon as the child exists. A test that reads the
// log therefore never races the fake's first line of its own startup.
import childProcess from 'node:child_process';
import fs from 'node:fs';

export * from 'node:child_process';
export default childProcess;

export function spawn(command, ...rest) {
    const redirected = command === '/usr/bin/bwrap' && process.env.FAKE_BWRAP;
    const target = redirected ? process.env.FAKE_BWRAP : command;
    const child = childProcess.spawn(target, ...rest);
    if (redirected && process.env.FAKE_BWRAP_SPAWN_LOG && child.pid) {
        fs.appendFileSync(
            process.env.FAKE_BWRAP_SPAWN_LOG,
            `${JSON.stringify({ pid: child.pid, argv: Array.isArray(rest[0]) ? rest[0] : [] })}\n`,
        );
    }
    return child;
}
