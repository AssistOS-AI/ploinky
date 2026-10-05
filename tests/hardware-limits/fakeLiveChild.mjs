// A fresh process for the crash-resume tests: it loads the run manifest from
// disk, runs provisioning or cleanup against the file-backed fake world, and,
// when a crash point is named, exits abruptly at that exact persist boundary
// as a killed runner would. Test support only.
import fs from 'node:fs';
import { executeCleanupRun, validateProfile } from './liveHarness.mjs';
import { provisionRun } from './liveFixture.mjs';
import { writePrivateJson } from './fixtures.mjs';
import { CRASH_EXIT, createFakeWorld } from './fakeLiveEngine.mjs';

const step = (run, id) => run.cleanup.steps.find(entry => entry.id === id);
// Each crash point is a predicate over the in-memory manifest and whether the
// process dies after the matching persist reached disk or just before it.
const POINTS = {
    'before-destroy': { after: true, when: run => step(run, 'destroy-box')?.state === 'intent' },
    'after-destroy': { after: true, when: run => step(run, 'destroy-box')?.state === 'complete' },
    'after-removal-intent': { after: true, when: run => step(run, 'workspace-removal')?.state === 'intent' && !step(run, 'workspace-removal').quarantine },
    'after-rename': { after: true, when: run => Boolean(step(run, 'workspace-removal')?.quarantine) && step(run, 'workspace-removal').state === 'intent' },
    'after-removal': { after: false, when: run => step(run, 'workspace-removal')?.state === 'complete' },
    'workspace-before-receipt': { after: false, when: run => run.operations.some(op => op.kind === 'workspace-create' && op.state === 'observed') },
};

const [mode, runPath, statePath, contextPath, crash = ''] = process.argv.slice(2);
const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
const point = crash ? POINTS[crash] : null;
if (crash && !point) throw new Error(`unknown crash point ${crash}`);
const persist = () => {
    if (point && !point.after && point.when(run)) process.exit(CRASH_EXIT);
    writePrivateJson(runPath, run);
    if (point && point.after && point.when(run)) process.exit(CRASH_EXIT);
};
const processProvider = createFakeWorld({ statePath, node: context.node, engine: context.engine, host: context.host });
const report = mode === 'provision'
    ? await provisionRun({ run, persist, processProvider, portProbe: async () => ({ tcp: true, udp: true }), hostIdentity: context.hostIdentity, remoteArrival: context.remoteArrival, validateProfile })
    : await executeCleanupRun({ run, persist, processProvider, hostIdentity: context.hostIdentity });
process.stdout.write(JSON.stringify(report));
