import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceError, LIMITS, need, parseStrictJson, word } from './manifest.mjs';
import { PHASE_CAPS_MS } from './contracts.mjs';
import { runOwnedCommand } from './host_command.mjs';
import { readBoundedRegularFile } from './worker.mjs';

// U6 runs the existing continuation scenarios through the tightened runner as one owned child. The runner admits the
// live deployment itself, supervises its two updates, restores its guarded fixtures and writes one sanitized
// observation file; this port only launches it, then validates that file strictly and projects public evidence.
const RUNNER_RELATIVE = 'tests/e2e/updateContinueOnError/run.mjs';
const OBSERVATION_BYTES = 4 * 1024 * 1024;
const bool = value => value === true;

export function validateObservations(value, manifest, { generation } = {}) {
    need(value && typeof value === 'object' && value.runId === manifest.runId && value.result === 'passed' && value.coverage === 'continuation-only' && value.workspace === manifest.workspace.path
        && value.cleanup?.result === 'passed' && value.passes && typeof value.passes === 'object', 'continuation-observations');
    const optional = value.passes['optional-errors'], required = value.passes['unknown-required-scope'];
    need(optional && required && optional.exitCode === 1 && required.exitCode === 1 && !optional.uncertain && !required.uncertain, 'continuation-exit');
    need(typeof optional.generation?.before === 'string' && optional.generation.before === generation && optional.generation.before !== optional.generation.after && typeof optional.generation.after === 'string' && bool(optional.generation.graphReady), 'continuation-optional-activation');
    need(required.generation?.before === optional.generation.after && required.generation.after === required.generation.before && bool(required.generation.pendingActivation) && required.pendingActivation, 'continuation-required-deferral');
    return Object.freeze({ phase: 'U6', optional: { exit: 1, activation: 'restarted', graphReady: true, generationChanged: true }, required: { exit: 1, activation: 'deferred', generationPreserved: true, pendingActivation: true },
        cleanup: 'passed', coverage: 'continuation-only' });
}

export function createNegativePort({ manifest, manifestPath, deps, env, io = fs }) {
    need(manifest && typeof manifestPath === 'string' && path.isAbsolute(manifestPath) && deps && env, 'negative-port-adapters');
    const artifacts = path.join(manifest.evidence.root, 'continuation'), runner = path.join(manifest.candidate.root, RUNNER_RELATIVE);
    const scenario = manifest.negativeScopes.optional, sourceParent = path.join(manifest.workspace.path, `.update-e2e-${manifest.runId}`);
    let ran = false;
    return Object.freeze({
        artifacts,
        async run({ generation, check }) {
            // The manifest's generation predates U4; the runner must admit against the generation this run has itself admitted.
            need(!ran && word(generation), 'negative-already-run'); ran = true; check();
            await runOwnedCommand({ operation: 'continuation-run', kind: 'continuation', cwd: manifest.workspace.path, env, deadlineMs: PHASE_CAPS_MS.U6 - 60000, collect: false, tap: { push: () => true, end() {} },
                argv: [manifest.host.node.path, runner, '--workspace', manifest.workspace.path, '--manifest', manifestPath, '--artifacts', artifacts, '--ploinky', manifest.candidate.cliPath, '--generation', generation] }, deps);
            check();
            let parsed; try { parsed = parseStrictJson(readBoundedRegularFile(path.join(artifacts, 'observations_codex.json'), OBSERVATION_BYTES, io), OBSERVATION_BYTES); } catch (error) { throw new AcceptanceError('continuation-observations'); }
            return validateObservations(parsed, manifest, { generation });
        },
        // The runner restores its own guarded fixtures; this proves nothing of it remains after the run.
        async restore({ writersQuiescent }) {
            need(writersQuiescent === true && ran, 'negative-restore-refused');
            for (const target of [scenario, sourceParent]) { let present = true; try { io.lstatSync(target); } catch (error) { if (error?.code === 'ENOENT') present = false; else throw new AcceptanceError('negative-restore-unknown'); } need(!present, 'negative-fixture-remains'); }
            let remaining; try { remaining = io.readdirSync(path.join(manifest.workspace.path, '.ploinky', 'repos')); } catch { throw new AcceptanceError('negative-restore-unknown'); }
            need(!remaining.some(name => name.includes(`UpdateE2E`) && name.endsWith(manifest.runId)), 'negative-fixture-remains');
            return true;
        },
    });
}
