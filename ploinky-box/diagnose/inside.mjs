import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeAuthorityDiagnostic } from '../../cli/sandbox/authorityCommandDiagnostics.mjs';
import { readBoxWorkspaceRoot } from '../contract/workspace-root.mjs';
import { createProcessRunner } from '../process.mjs';
import { NESTED_PODMAN_SECCOMP_BOX_PATH } from '../seccomp.mjs';

const OWNER_LABEL = 'io.assistos.ploinky.diagnose-run';
const SCRIPT_PATH = '/opt/ploinky/ploinky-box/diagnose/inside.mjs';
const ID_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const PROBE_TIMEOUT = 30_000;
const PULL_TIMEOUT = 240_000;
const NESTED_TIMEOUT = 360_000;
const STORAGE_NEXT = 'Inspect the reported overlay driver and fuse-overlayfs settings. Check host AppArmor denials for fuse-overlayfs/fusermount3; keep profiles enforced and allow only the denied diagnostic storage path before retrying.';
const NETWORK_NEXT = 'Check host AppArmor/audit logs for pasta opening /run/netns/netns-*. Nested container-root networking needs read access to those namespace files and their directory. Also verify /dev/net/tun, DNS and registry HTTPS access; do not disable confinement.';
const FILESYSTEM_PROBE = `const fs=require('node:fs');const p='/diagnose/';fs.writeFileSync(p+'created','ploinky diagnose');fs.renameSync(p+'created',p+'renamed');if(fs.readFileSync(p+'renamed','utf8')!=='ploinky diagnose')throw Error('Read after rename differed');fs.unlinkSync(p+'renamed');console.log('Mounted scratch write, rename, read and unlink passed');`;
const NETWORK_PROBE = `const dns=require('node:dns').promises;(async()=>{const endpoint=new URL(process.argv[1]);await dns.lookup(endpoint.hostname);const r=await fetch(endpoint,{signal:AbortSignal.timeout(10000)});if(![200,401].includes(r.status))throw Error('Registry HTTPS returned '+r.status);await r.body?.cancel();console.log('Registry DNS and HTTPS passed for '+endpoint.host+' ('+r.status+')');})().catch(e=>{console.error(e.message);process.exitCode=1;});`;

function clean(value) {
    return sanitizeAuthorityDiagnostic(String(value ?? ''), { limit: 2_000 });
}

function parseJson(result) {
    try { return JSON.parse(result.stdout); } catch { return null; }
}

function imageReference(value) {
    return typeof value === 'string' && value.length < 512
        && /^[a-z0-9][a-z0-9._:-]*\/[a-z0-9][a-z0-9/._:-]*(?:@sha256:[a-f0-9]{64})?$/.test(value);
}

function registryEndpoint(imageRef) {
    if (!imageReference(imageRef)) return null;
    const registry = imageRef.split('/')[0];
    try { return new URL(`https://${registry === 'docker.io' ? 'registry-1.docker.io' : registry}/v2/`).href; }
    catch { return null; }
}

function containerFailureNext(result) {
    const diagnostic = `${result.stderr || ''}\n${result.stdout || ''}`;
    if (/pasta|netns|network namespace|DNS|ENOTFOUND|resolve host/i.test(diagnostic)) return NETWORK_NEXT;
    if (/mkdir|mount|overlay|fuse|chown|storage|pivot_root|no space left/i.test(diagnostic)) return STORAGE_NEXT;
    return 'Inspect the reported OCI runtime error and matching host security audit entry. Verify the supported runtime, device and profile settings without relaxing confinement.';
}

function validateNestedReport(report, { registryKnown }) {
    if (![0, 1].includes(report?.exitCode) || !Array.isArray(report.checks) || !report.checks.length || report.checks.length > 200) return false;
    const byId = new Map();
    for (const check of report.checks) {
        if (!check || typeof check.id !== 'string' || !/^nested-engine\.[a-z0-9-]+$/.test(check.id) || byId.has(check.id)
            || !['pass', 'fail', 'skip', 'warn'].includes(check.status) || typeof check.label !== 'string' || typeof check.detail !== 'string'
            || (check.command && (typeof check.command.file !== 'string' || !Array.isArray(check.command.args) || !check.command.args.every((arg) => typeof arg === 'string')))) return false;
        byId.set(check.id, check);
    }
    const failed = report.checks.some((check) => check.status === 'fail');
    if (report.exitCode === 1) return failed;
    if (failed) return false;
    const commands = { 'podman-info': 'info', 'agent-create': 'create', 'agent-start': 'start', 'agent-exec': 'exec', 'agent-filesystem': 'exec', 'agent-remove': 'rm' };
    for (const id of ['podman-info', 'podman-settings', 'agent-create', 'agent-start', 'agent-exec', 'agent-filesystem', 'agent-remove']) {
        const check = byId.get(`nested-engine.${id}`);
        if (check?.status !== 'pass' || (commands[id] && (check.command?.file !== 'podman' || check.command.args[0] !== commands[id]))) return false;
    }
    const network = byId.get('nested-engine.agent-network');
    return registryKnown ? network?.status === 'pass' && network.command?.file === 'podman' && network.command.args[0] === 'exec' : network?.status === 'skip';
}

/** Run only inside an isolated diagnostic Box, never a deployed workspace Box. */
export async function runInsideDiagnostics({
    runner = createProcessRunner(),
    imageRef,
    imageArchive,
    imageId: expectedImageId,
    nestedEngine = false,
    fsApi = fs,
    tempRoot = os.tmpdir(),
    dataRoot,
    runId = crypto.randomUUID(),
    progress = (message) => process.stderr.write(`${message}\n`),
} = {}) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new TypeError('Invalid diagnostic run identity');
    const prefix = nestedEngine ? 'nested-engine' : 'inner';
    const checks = [];
    const add = (id, label, status, detail, extra = {}) => {
        const check = { id: `${prefix}.${id}`, label, status, detail: clean(detail), ...extra };
        checks.push(check);
        return check;
    };
    const query = async (id, label, args, { file = 'podman', next, timeoutMs = PROBE_TIMEOUT, structuredOutput = false } = {}) => {
        progress(`[diagnose] ${label}`);
        let result;
        try { result = await runner.query(file, args, { timeoutMs }); }
        catch (error) { result = { ok: false, status: 1, stderr: error.message, error }; }
        const diagnostic = result.ok ? structuredOutput ? 'Structured command output captured for validation.' : result.stdout || result.stderr || 'Command succeeded.'
            : [result.error?.code, result.stderr || (!structuredOutput && result.stdout) || 'Command failed without diagnostic stderr.'].filter(Boolean).join(': ');
        const check = add(id, label, result.ok ? 'pass' : 'fail', diagnostic, {
            command: { file, args }, exitCode: result.status ?? 1, ...(!result.ok && next ? { next } : {}),
        });
        return { ...result, check };
    };
    const skip = (id, label, reason) => add(id, label, 'skip', reason);

    const hasExpectedIdentity = ID_PATTERN.test(String(expectedImageId));
    const localIdentity = ID_PATTERN.test(String(imageRef)) && hasExpectedIdentity
        && imageRef.replace(/^sha256:/, '') === expectedImageId.replace(/^sha256:/, '');
    if ((!imageReference(imageRef) && !localIdentity) || (expectedImageId !== undefined && !hasExpectedIdentity) || (imageArchive && !hasExpectedIdentity)) {
        add('image-reference', 'Diagnostic image reference', 'fail', 'Use a fully qualified registry reference, or an archived local image with its exact expected immutable ID.', { next: 'Run diagnose using the configured Box image and a verified archive.' });
        return { checks, exitCode: 1 };
    }
    const networkEndpoint = registryEndpoint(imageRef);

    let scratch;
    let dataScratch;
    let engineEnv;
    try {
        if (imageArchive && (typeof imageArchive !== 'string' || !path.isAbsolute(imageArchive) || /[\r\n:]/.test(imageArchive)
            || fsApi.realpathSync(imageArchive) !== path.resolve(imageArchive) || !fsApi.lstatSync(imageArchive).isFile())) {
            throw new Error('Diagnostic image archive must be an absolute regular file without symlinks or volume-option delimiters.');
        }
        scratch = fsApi.mkdtempSync(path.join(tempRoot, `ploinky-diagnose-${runId}-`));
        fsApi.chmodSync(scratch, 0o700);
        if (nestedEngine) {
            // This mode is invoked only in a new disposable container. Its graphroot
            // deliberately matches nestedPodman agents so pathname policy is exercised.
            const storageConf = path.join(scratch, 'storage.conf');
            const runRoot = path.join(scratch, 'runroot');
            fsApi.mkdirSync('/data/podman/storage', { recursive: true, mode: 0o700 });
            fsApi.mkdirSync(runRoot, { mode: 0o700 });
            fsApi.writeFileSync(storageConf, `[storage]\ndriver = "overlay"\ngraphroot = "/data/podman/storage"\nrunroot = "${runRoot}"\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n`, { mode: 0o600 });
            engineEnv = { ...process.env, CONTAINERS_STORAGE_CONF: storageConf, HOME: '/root', USER: 'root', _CONTAINERS_USERNS_CONFIGURED: '' };
            const underlying = runner;
            runner = { query: (file, args, options) => underlying.query(file, args, { ...options, env: engineEnv }) };
        }

        for (const file of ['node', 'npm', 'npx', 'bash', 'git', 'ss', 'nsenter', 'pasta', 'fuse-overlayfs', 'podman', 'cloudflared']) {
            await query(`tool-${file}`, `${prefix}: ${file} executable`, ['--version'], {
                file, next: `Use the supported Box image containing a working ${file} executable; rebuild the image if this tool is missing or incompatible.`,
            });
        }
        await query('identity', `${prefix}: process user and group`, ['-e', `if(process.getuid()!==${nestedEngine ? 0 : 1000}||process.getgid()!==${nestedEngine ? 0 : 1000})throw Error('Unexpected UID/GID '+process.getuid()+'/'+process.getgid());console.log('UID/GID '+process.getuid()+'/'+process.getgid());`], {
            file: 'node', next: 'Restore the canonical Box user and nestedPodman container user settings.',
        });
        for (const device of ['/dev/fuse', '/dev/net/tun']) {
            await query(`device-${path.basename(device)}`, `${prefix}: ${device} character device`, ['-e', "const fs=require('node:fs');const p=process.argv[1];if(!fs.statSync(p).isCharacterDevice())throw Error(p+' is not a character device');fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK);console.log(p+' is readable and writable');", device], {
                file: 'node', next: `Verify the host has ${device} and the canonical Box/nestedPodman --device arguments are intact. Inspect any host AppArmor or SELinux denial.`,
            });
        }
        const infoResult = await query('podman-info', `${prefix}: Podman driver and security information`, ['info', '--format', 'json'], { next: STORAGE_NEXT, structuredOutput: true });
        const info = parseJson(infoResult);
        if (infoResult.ok && info) {
            const observed = { driver: info.store?.graphDriverName, graphRoot: info.store?.graphRoot, graphOptions: info.store?.graphOptions, rootless: info.host?.security?.rootless, networkBackend: info.host?.networkBackend };
            infoResult.check.detail = clean(JSON.stringify(observed));
            const expected = observed.driver === 'overlay' && observed.rootless === !nestedEngine && observed.networkBackend === 'netavark';
            const mountProgram = JSON.stringify(observed.graphOptions ?? {});
            add('podman-settings', `${prefix}: expected Podman settings`, expected && mountProgram.includes('fuse-overlayfs') ? 'pass' : 'fail', JSON.stringify(observed), { ...(!(expected && mountProgram.includes('fuse-overlayfs')) ? { next: STORAGE_NEXT } : {}) });
        } else if (infoResult.ok) {
            add('podman-settings', `${prefix}: expected Podman settings`, 'fail', 'Podman returned invalid JSON; driver and confinement settings could not be verified.', { next: 'Check the podman info output and use the supported Podman version.' });
        } else skip('podman-settings', `${prefix}: expected Podman settings`, 'Podman info failed.');

        if (!nestedEngine) {
            for (const kind of ['uid', 'gid']) {
                const mapping = await query(`${kind}-mapping`, `inner: full ${kind.toUpperCase()} namespace mapping`, ['unshare', 'cat', `/proc/self/${kind}_map`], { next: 'Check the Box subuid/subgid ranges and newuidmap/newgidmap helpers; a login user namespace must provide the configured subordinate identity range.' });
                if (mapping.ok) {
                    const rows = String(mapping.stdout).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
                    const size = rows.reduce((total, row) => total + (row.length === 3 && row.every(Number.isSafeInteger) ? row[2] : 0), 0);
                    if (size !== 65_535) Object.assign(mapping.check, { status: 'fail', next: 'Restore the canonical Box mapping: 65534 subordinate IDs and 65535 total mapped IDs, including container root.' });
                }
            }
        }

        const imageLookup = expectedImageId || imageRef;
        let imageResult = await query('image-inspect', `${prefix}: inspect diagnostic image cache`, ['image', 'inspect', imageLookup], { next: imageArchive ? 'The isolated engine will load the verified image archive next.' : 'The isolated engine will try an explicit registry pull next.', structuredOutput: true });
        if (!imageResult.ok) {
            // An absent image is expected in a fresh diagnostic store, not a failed prerequisite.
            imageResult.check.status = 'skip';
            imageResult.check.detail = clean(`Image is not available in the isolated engine cache; ${imageArchive ? 'loading the verified archive' : 'checking an explicit pull'}. Cache diagnostic: ${imageResult.check.detail}`);
            const obtained = imageArchive
                ? await query('image-load', `${prefix}: load verified diagnostic image archive (up to 240 seconds)`, ['load', '--input', imageArchive], { timeoutMs: PULL_TIMEOUT, next: 'Check archive readability, disk capacity and the reported unpack/storage error. The archive must contain the verified Box image.' })
                : await query('image-pull', `${prefix}: pull diagnostic image (up to 240 seconds)`, ['pull', imageRef], { timeoutMs: PULL_TIMEOUT, next: 'Check registry connectivity, DNS, disk capacity and the reported unpack/storage error. Diagnose never changes registry credentials.' });
            if (obtained.ok) imageResult = await query('image-resolve', `${prefix}: resolve immutable diagnostic image`, ['image', 'inspect', imageLookup], { next: STORAGE_NEXT, structuredOutput: true });
        }
        const image = parseJson(imageResult);
        const imageId = Array.isArray(image) ? image[0]?.Id : image?.Id;
        if (!imageResult.ok || !ID_PATTERN.test(String(imageId)) || (hasExpectedIdentity && imageId.replace(/^sha256:/, '') !== expectedImageId.replace(/^sha256:/, ''))) {
            add('image-identity', `${prefix}: immutable diagnostic image`, 'fail', 'No matching verified immutable image identity was available.', { next: 'Resolve the image load/pull/inspect failure before testing container operations.' });
            skip('container-probe', `${prefix}: create, start and exec`, 'Diagnostic image unavailable.');
            return { checks, exitCode: 1 };
        }
        imageResult.check.detail = `Verified immutable diagnostic image ${imageId}.`;

        async function inspectOwned(reference, imageIdentity) {
            let result;
            try { result = await runner.query('podman', ['inspect', '--type', 'container', reference], { timeoutMs: PROBE_TIMEOUT }); }
            catch { return null; }
            const parsed = parseJson(result || {});
            const container = Array.isArray(parsed) ? parsed[0] : null;
            if (!result.ok || !ID_PATTERN.test(String(container?.Id)) || container?.Config?.Labels?.[OWNER_LABEL] !== runId
                || String(container.Image).replace(/^sha256:/, '') !== imageIdentity.replace(/^sha256:/, '')
                || (ID_PATTERN.test(reference) && container.Id !== reference)) return null;
            return container.Id;
        }

        async function probeContainer(kind, extraArgs, operations) {
            const name = `ploinky-diagnose-${runId}-${kind}`;
            let id;
            try {
                const created = await query(`${kind}-create`, `${prefix}: create ${kind} container`, [
                    'create', '--name', name, '--label', `${OWNER_LABEL}=${runId}`, '--pull=never', '--init', '--user', '0:0',
                    '--network', 'pasta', '--ipc', 'none', '--volume', `${scratch}:/diagnose:rw`, ...extraArgs,
                    '--entrypoint', '/bin/sh', imageId, '-c', 'exec sleep infinity',
                ], { next: STORAGE_NEXT });
                if (!created.ok) created.check.next = containerFailureNext(created);
                id = await inspectOwned(created.ok ? String(created.stdout).trim() : name, imageId);
                if (!id) {
                    add(`${kind}-identity`, `${prefix}: ${kind} container identity`, 'fail', 'Could not verify a container with this diagnostic run label and immutable image; no unverified container will be mutated.', { next: `Inspect only the diagnostic container named ${name}; do not prune other containers.` });
                    return;
                }
                if (!created.ok) return;
                const started = await query(`${kind}-start`, `${prefix}: start ${kind} container with pasta`, ['start', id]);
                if (!started.ok) {
                    started.check.next = containerFailureNext(started);
                    skip(`${kind}-exec`, `${prefix}: ${kind} execution`, 'Container start failed.');
                    return;
                }
                await operations(id, async () => {
                    if (!await inspectOwned(id, imageId)) throw new Error('Diagnostic container identity changed before exec; refusing mutation.');
                });
            } catch (error) {
                add(`${kind}-probe`, `${prefix}: ${kind} lifecycle probe`, 'fail', error.message, { next: 'Inspect the diagnostic failure and retry after resolving its cause.' });
            } finally {
                const ownedId = await inspectOwned(id || name, imageId);
                if (ownedId) await query(`${kind}-remove`, `${prefix}: remove owned ${kind} container and its mounts`, ['rm', '--force', '--time', '5', ownedId], { next: STORAGE_NEXT });
                else if (id) add(`${kind}-remove`, `${prefix}: remove owned ${kind} container`, 'fail', 'Cleanup refused because immutable container identity could not be revalidated.', { next: `Inspect diagnostic container ${id}; no other container was removed.` });
            }
        }

        await probeContainer('agent', [], async (id, revalidate) => {
            await revalidate();
            await query('agent-exec', `${prefix}: execute in the agent container`, ['exec', id, '/bin/true'], { next: 'Inspect the OCI runtime error and the host security audit log.' });
            await revalidate();
            await query('agent-filesystem', `${prefix}: mounted workspace filesystem operations`, ['exec', id, 'node', '-e', FILESYSTEM_PROBE], { next: STORAGE_NEXT });
            if (networkEndpoint) {
                await revalidate();
                await query('agent-network', `${prefix}: registry DNS and HTTPS from the container`, ['exec', id, 'node', '-e', NETWORK_PROBE, networkEndpoint], { next: NETWORK_NEXT });
            } else skip('agent-network', `${prefix}: registry DNS and HTTPS from the container`, 'The selected image is local and has no registry reference; no registry endpoint can be inferred. Pasta container creation and start were tested.');
        });

        if (!nestedEngine) {
            // Agent data is a workspace bind in deployment. Keep this graphroot
            // on the same filesystem instead of adding an artificial FUSE-on-FUSE layer.
            const selectedDataRoot = dataRoot ?? readBoxWorkspaceRoot(process.env);
            dataScratch = fsApi.mkdtempSync(path.join(selectedDataRoot, `ploinky-diagnose-data-${runId}-`));
            fsApi.chmodSync(dataScratch, 0o700);
            await probeContainer('engine', [
                '--cap-add', 'SYS_ADMIN', '--cap-add', 'NET_ADMIN', '--device', '/dev/fuse', '--device', '/dev/net/tun',
                '--tmpfs', '/dev/shm:rw,size=64m,mode=1777',
                '--security-opt', 'label=disable', '--security-opt', `seccomp=${NESTED_PODMAN_SECCOMP_BOX_PATH}`,
                '--volume', '/opt/ploinky:/opt/ploinky:ro', '--env', 'HOME=/root', '--env', 'USER=root',
                '--volume', `${dataScratch}:/data:rw`,
                '--env', 'PLOINKY_DIAGNOSE_ISOLATED=1',
                ...(imageArchive ? ['--volume', `${imageArchive}:/diagnose-image.tar:ro`] : []),
            ], async (id, revalidate) => {
                await revalidate();
                const result = await query('engine-exec', 'inner: nestedPodman container-root storage and networking probe', [
                    'exec', id, 'node', SCRIPT_PATH, imageRef, '--nested-engine',
                    ...(imageArchive ? ['--image-archive', '/diagnose-image.tar'] : []),
                    ...(expectedImageId ? ['--image-id', expectedImageId] : []),
                ], { timeoutMs: NESTED_TIMEOUT, next: 'Inspect the individual nested container-root command failures below and follow their specific recovery guidance.', structuredOutput: true });
                const report = parseJson(result);
                if (validateNestedReport(report, { registryKnown: Boolean(networkEndpoint) })) {
                    checks.push(...report.checks.map((check) => ({
                        id: clean(check.id), label: clean(check.label), status: ['pass', 'fail', 'skip', 'warn'].includes(check.status) ? check.status : 'fail',
                        detail: clean(check.detail), ...(check.next ? { next: clean(check.next) } : {}),
                        ...(check.command?.file && Array.isArray(check.command.args) ? { command: { file: 'podman', args: ['exec', id, check.command.file, ...check.command.args.map(clean)] } } : {}),
                        ...(Number.isInteger(check.exitCode) ? { exitCode: check.exitCode } : {}),
                    })));
                    result.check.detail = 'Completed nested container-root diagnostics; individual commands are listed below.';
                    if (report.exitCode !== 0) result.check.status = 'fail';
                } else Object.assign(result.check, { status: 'fail', detail: 'Nested engine returned no complete, valid diagnostic report. ' + clean(result.stderr), next: 'Check the nested script output and installed source version; successful reports must include the actual container lifecycle checkpoints.' });
            });
        }
    } catch (error) {
        add('setup', `${prefix}: diagnostic scratch setup`, 'fail', error.message, { next: 'Check free space and writable temporary storage in the disposable diagnostic Box.' });
    } finally {
        if (dataScratch) {
            try { fsApi.rmSync(dataScratch, { recursive: true, force: true }); }
            catch (error) {
                if (['EACCES', 'EPERM'].includes(error.code)) {
                    await query('data-cleanup', `${prefix}: remove diagnostic data with its mapped user ownership`, ['unshare', 'node', '-e', "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true});", dataScratch], { next: 'Inspect the cleanup error for this diagnostic data directory; the original workspace data was not selected for removal.' });
                } else add('data-cleanup', `${prefix}: diagnostic data cleanup`, 'fail', error.message, { next: 'The owning temporary diagnostic workspace must be removed to finish cleanup.' });
            }
        }
        if (scratch) {
            try { fsApi.rmSync(scratch, { recursive: true, force: true }); }
            catch (error) { add('scratch-cleanup', `${prefix}: diagnostic scratch cleanup`, 'fail', error.message, { next: 'The owning temporary diagnostic Box must be removed to finish cleanup.' }); }
        }
    }
    return { checks, exitCode: checks.some((check) => check.status === 'fail') ? 1 : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [imageRef, ...args] = process.argv.slice(2);
    const options = { imageRef };
    let valid = true;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--nested-engine' && !options.nestedEngine) options.nestedEngine = true;
        else if (args[index] === '--image-archive' && !options.imageArchive && args[index + 1]) options.imageArchive = args[++index];
        else if (args[index] === '--image-id' && !options.imageId && args[index + 1]) options.imageId = args[++index];
        else valid = false;
    }
    if (process.env.PLOINKY_DIAGNOSE_ISOLATED !== '1') {
        process.stderr.write('Diagnostic probes require a dedicated isolated diagnose Box. Run ploinky diagnose from the host.\n');
        process.exitCode = 2;
    } else if (!valid) {
        process.stderr.write('Usage: inside.mjs IMAGE [--image-archive PATH --image-id SHA256_ID] [--nested-engine]\n');
        process.exitCode = 2;
    } else {
        const report = await runInsideDiagnostics(options);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        process.exitCode = report.exitCode;
    }
}
