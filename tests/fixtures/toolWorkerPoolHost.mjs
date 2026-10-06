// Host process for the toolWorkerPool "host SIGKILL" test: it owns a pool,
// starts two long calls (two workers, each with a tool child in its group)
// and stays alive until the test kills it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolWorkerPool } from '../../Agent/server/toolWorkerPool.mjs';

const [loadsLog, pidDir] = process.argv.slice(2);
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toolWorkerFixture.mjs');

const pool = new ToolWorkerPool('host-fixture', {
    command: process.execPath,
    args: [fixture],
    env: { FIXTURE_LOADS_LOG: loadsLog },
    size: 2,
    callTimeoutMs: 60_000,
    log: () => {},
});

for (const name of ['a', 'b']) {
    pool.call({
        toolName: 'fixture_tool',
        payload: { input: { mode: 'hang', ms: 60_000, pidFile: path.join(pidDir, `${name}.pids`) } },
    });
}
setInterval(() => {}, 1000);
