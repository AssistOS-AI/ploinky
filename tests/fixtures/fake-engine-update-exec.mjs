import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    buildUpdateResult,
    createOperationRecord,
    UPDATE_REPORT_CONTEXT_ENV,
    UPDATE_REPORT_NONCE_ENV,
    writeUpdateReport,
} from '../../cli/commands/updateOutcome.js';

// A stand-in engine client for `<engine> container exec ... ploinky-local update`.
// It plays the in-Box core: it publishes one valid report for the nonce and
// context it was given, optionally leaves a real detached descendant running
// (a writer that outlives the command), and exits with the report's status.
//
// The engine environment is allowlisted by the supervisor, so the launcher
// script passes the fixture settings as FAKE_ENGINE_* variables itself.

const args = process.argv.slice(2);
const execEnv = {};
for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--env') continue;
    const pair = String(args[index + 1] || '');
    const split = pair.indexOf('=');
    execEnv[pair.slice(0, split)] = pair.slice(split + 1);
}
const entry = args.indexOf('/opt/ploinky/bin/ploinky-local');
const coreArgv = entry >= 0 ? args.slice(entry + 1) : [];
const nonce = execEnv[UPDATE_REPORT_NONCE_ENV];
const context = JSON.parse(execEnv[UPDATE_REPORT_CONTEXT_ENV]);
const workspace = process.env.FAKE_ENGINE_WORKSPACE;

fs.appendFileSync(process.env.FAKE_ENGINE_LOG, `${JSON.stringify({ pid: process.pid, coreArgv, nonce })}\n`);

const pidFile = process.env.FAKE_ENGINE_DETACHED_PID_FILE;
if (pidFile) {
    const writer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        env: { [UPDATE_REPORT_NONCE_ENV]: nonce },
    });
    writer.unref();
    fs.writeFileSync(pidFile, String(writer.pid));
}

const result = buildUpdateResult({
    command: coreArgv,
    records: [createOperationRecord({
        phase: 'registered-repository', id: 'fixture-repo', outcome: 'unchanged', required: true,
    })],
    context,
});
writeUpdateReport(path.join(workspace, '.ploinky'), nonce, result);
process.exit(result.exitCode);
