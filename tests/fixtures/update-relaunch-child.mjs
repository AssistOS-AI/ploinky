import fs from 'node:fs';
import path from 'node:path';

import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { createUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { verifiedRecord } from '../helpers/fakeUpdateCore.mjs';
import { createUpdateBoxScenario } from '../helpers/updateBoxScenario.mjs';

// The relaunched CLI of a host self-update, as a real child process. It runs
// the production outer CLI entry (`runOuterCli`) with its defaults for the
// environment (process.env carries the handoff), the working directory and
// the handoff parent pid (process.ppid). Only the Box supervisor seams are
// fakes; the host state is file-backed and shared with the parent.

const root = process.env.FIXTURE_ROOT;
const workspace = process.env.FIXTURE_WORKSPACE;
const store = createUpdateHostState({ stateRoot: process.env.FIXTURE_STATE_ROOT });
const dirty = process.env.FIXTURE_CHILD_OUTCOME === 'dirty';
const scenario = createUpdateBoxScenario({
    root: path.join(root, 'child'),
    workspace,
    store,
    core: {
        records: () => (dirty
            ? [createOperationRecord({
                phase: 'workspace-repository', id: 'demo', outcome: 'skipped', attempted: false, required: true,
                code: 'dirty-worktree', reason: 'local changes were preserved',
            })]
            : [verifiedRecord()]),
    },
});

try {
    process.exitCode = await runOuterCli(process.argv.slice(2), {
        input: { isTTY: false },
        supervisor: scenario.supervisor,
        detectInsideBox: () => false,
        updateHostState: store,
        updateHostSource: async () => { throw new Error('the relaunched CLI must not pull the host checkout again'); },
        onUpdateResult: (summary) => {
            fs.writeFileSync(process.env.FIXTURE_RESULT, JSON.stringify({ ppid: process.ppid, result: summary.result }));
        },
    });
} catch (error) {
    process.stderr.write(`relaunch child failed: ${error?.code || ''} ${error?.message || error}\n`);
    process.exitCode = 70;
}
