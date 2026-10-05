import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceError, LIMITS, need, validateManifest, boxName } from './manifest_codex.mjs';
import { runOwnedCommand } from './host_command_codex.mjs';
import { engineInfoArgs, parseEngineInfo, engineIdentityOf, boxInspectArgs, parseBoxInspect, boxIdentityArgs, parseBoxIdentity, imageInspectArgs, parseImageInspect, gpuWiringIdentityOf, gpuGrantLabelValid } from './engine_codex.mjs';

// A read-only writer of the R1 and R2 release manifests. It derives every field of the generation from exact reads (engine
// info, the Box by its exact ID, the same Box by its name, the image, the workspace) and from the validated functional manifest,
// then lets the live observer prove the complete result against the running deployment before anything is written. The file is
// created exclusively; nothing is deployed, started, stopped, repaired or removed, and no command of kind `mutation` is ever used.
export const WRITER_BUDGET_MS = 90000;
const ROLES = Object.freeze({ R1: { file: 'release', activation: false }, R2: { file: 'release2', activation: true } });
const HEX64 = /^[a-f0-9]{64}$/;
const normalize = value => new Date(Date.parse(value)).toISOString();

export function createReleaseManifestWriter({ base, deps, env, io = fs, clock, observerFor, run = runOwnedCommand }) {
    need(base && deps && env && clock && typeof clock.mono === 'function' && typeof observerFor === 'function' && typeof run === 'function', 'writer-adapters');
    const read = (operation, argv, deadlineMs = 30000) => run({ operation, kind: 'read', argv, cwd: base.workspace.path, env, deadlineMs, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 64 * 1024 }, deps);
    return Object.freeze({
        async write({ role, runId, boxId, evidenceRoot, grant, activation = null }) {
            const started = clock.mono(), within = () => need(clock.mono() - started <= WRITER_BUDGET_MS, 'writer-deadline');
            need(Object.hasOwn(ROLES, role) && typeof runId === 'string' && HEX64.test(boxId) && typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot) && grant && typeof grant === 'object'
                && (ROLES[role].activation ? Array.isArray(activation) : activation === null), 'writer-input');
            const target = base.evidence[ROLES[role].file];
            try { io.lstatSync(target); throw new AcceptanceError('release-manifest-exists'); } catch (error) { if (error instanceof AcceptanceError) throw error; if (error?.code !== 'ENOENT') throw new AcceptanceError('evidence-unreadable'); }
            const engine = base.engine.path;
            const info = parseEngineInfo((await read('writer-engine-info', engineInfoArgs(engine))).stdout);
            need(engineIdentityOf({ info, path: engine, uid: base.host.uid }) === base.engine.identity && info.rootless === true, 'writer-engine-binding'); within();
            // The Box by its exact ID: the container name, image and labels are recorded from this one inspection.
            const box = parseBoxInspect((await read('writer-box-inspect', boxInspectArgs(engine, boxId))).stdout);
            need(box.id === boxId && boxName(box.name) && box.running === true, 'writer-box-binding');
            need(gpuGrantLabelValid(box), 'live-box-contract');
            need(typeof box.labels.imageRef === 'string' && box.labels.imageRef !== '' && box.labels.imageRef.length <= 256, 'writer-box-binding');
            need(box.imageId === base.box.imageId, 'release-candidate-mismatch');
            // The same container looked up by that name must be the same ID: a name and an ID of different containers are refused.
            const named = parseBoxIdentity((await read('writer-box-by-name', boxIdentityArgs(engine, box.name))).stdout);
            need(named.id === box.id && named.name === box.name, 'writer-box-binding'); within();
            const image = parseImageInspect((await read('writer-image-inspect', imageInspectArgs(engine, box.imageId))).stdout);
            need(image.id === box.imageId, 'writer-image-binding'); within();
            const stat = io.lstatSync(base.workspace.path);
            need(stat.isDirectory() && !stat.isSymbolicLink() && io.realpathSync(base.workspace.path) === base.workspace.path, 'live-workspace-alias');
            const startedAt = normalize(box.startedAt), stem = runId, root = evidenceRoot;
            const draft = structuredClone(base);
            Object.assign(draft, { runId, activation: ROLES[role].activation ? structuredClone(activation) : null });
            draft.evidence = { root, functional: `${root}/functional_codex.json`, release: `${root}/release_codex.json`, release2: `${root}/release2_codex.json`, release1Record: `${root}/release1_codex.json`, receipt: `${root}/receipt_codex.json`, sourceManifest: `${root}/sources_codex.json` };
            draft.box = { id: box.id, name: box.name, imageId: box.imageId, imageRef: box.labels.imageRef, startedAt, imageCreatedAt: image.createdAt, activeGeneration: 'provisional-generation', running: true, initialized: true, pendingActivation: false, recoveryBarrier: false };
            draft.workspace = { ...base.workspace, dev: stat.dev, ino: stat.ino, uid: stat.uid };
            draft.engine = { ...base.engine, gpuWiringIdentity: gpuWiringIdentityOf(box.labels) };
            draft.publications = box.publications.map(row => ({ ...row }));
            draft.negativeScopes = { optional: `${base.workspace.path}/UpdateE2E-${stem}`, required: `${base.workspace.path}/UpdateE2E-${stem}` };
            draft.grant = { ...grant };
            draft.epochs = { ...structuredClone(base.epochs), functional: { boxId: box.id, generation: 'provisional-generation', startedAt, candidateCommit: base.candidate.commit, imageId: box.imageId } };
            // The edge generation is whatever the running Box reports through the observer; nothing else is read from it for the draft.
            const generation = (await observerFor(draft).observe()).activeGeneration; need(typeof generation === 'string' && generation !== '', 'writer-generation'); within();
            draft.box.activeGeneration = generation; draft.epochs.functional.generation = generation;
            const manifest = validateManifest(draft);
            // The positive proof: the complete manifest, with the exact name and ID, admitted against the running deployment.
            await observerFor(manifest).admit(); within();
            const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`); need(bytes.length <= LIMITS.manifestBytes, 'writer-manifest-size');
            let fd; try { fd = io.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
            catch (error) { throw new AcceptanceError(error?.code === 'EEXIST' ? 'release-manifest-exists' : 'evidence-write'); }
            try { let offset = 0; while (offset < bytes.length) { const count = io.writeSync(fd, bytes, offset, bytes.length - offset); need(count > 0, 'evidence-write'); offset += count; } } finally { io.closeSync(fd); }
            return Object.freeze({ role, path: target, boxId: manifest.box.id, boxName: manifest.box.name, imageRef: manifest.box.imageRef, generation, gpuGrantLabelPresent: manifest.engine.gpuWiringIdentity !== gpuWiringIdentityOf({}), elapsedMs: clock.mono() - started });
        },
    });
}
