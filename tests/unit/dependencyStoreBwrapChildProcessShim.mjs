// `child_process` for bwrapServiceManager.js under the bwrap host shim (not a
// test file): identical except that spawning /usr/bin/bwrap runs $FAKE_BWRAP.
import childProcess from 'node:child_process';

export * from 'node:child_process';
export default childProcess;

export function spawn(command, ...rest) {
    const target = command === '/usr/bin/bwrap' && process.env.FAKE_BWRAP ? process.env.FAKE_BWRAP : command;
    return childProcess.spawn(target, ...rest);
}
