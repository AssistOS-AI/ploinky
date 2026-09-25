// `fs` for bwrapServiceManager.js under the bwrap host shim (not a test file):
// identical except that /proc/<pid>/status is answered from real liveness on
// hosts without procfs.
import realFs from 'node:fs';

export * from 'node:fs';

const PROC_STATUS = /^\/proc\/(\d+)\/status$/;

function readFileSync(file, ...rest) {
    const match = typeof file === 'string' && !realFs.existsSync('/proc/self') ? PROC_STATUS.exec(file) : null;
    if (match) {
        try { process.kill(Number(match[1]), 0); } catch {
            const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
            error.code = 'ENOENT';
            throw error;
        }
        return 'Name:\tbwrap\nState:\tS (sleeping)\n';
    }
    return realFs.readFileSync(file, ...rest);
}

export { readFileSync };
export default new Proxy(realFs, {
    get(target, property, receiver) {
        return property === 'readFileSync' ? readFileSync : Reflect.get(target, property, receiver);
    },
});
