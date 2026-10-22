#!/usr/bin/env node
// Step 0 spike of BOX_STATE_IN_WORKSPACE_PLAN_R2: can in-Box processes and nested agents
// reach or change what a read-only empty-directory mask hides at `<ws>/.ploinky-box`?
// Probes N3, N4, N4b, N4c, N11, N21, plus P1 (pre-existing: today's `.ploinky/data` guard).
//
// Fidelity: the Box `create` argv comes from this checkout's own `containerCreateArgs`; the
// probe injects only the mask volume, the N21 checkout shadow, `--timeout`, a probe label and
// free host ports. AgentLib is rendered in image mode so the workspace bind has no other
// submount (a local-mode alias shadow would make non-recursive binds fail on the control too).
// The Box starts through the real `startContainerAndWaitReady`, so its self-checks passed.
//
// Oracle, judged on the host and never by errno alone: a sentinel file with a random name and
// content sits in the real `.ploinky-box/` (and `.ploinky/data/`) before the Box exists. A row
// is FORGEABLE when the name or token shows up in any output, or when the real tree (lstat walk
// plus sha256) differs before/after. Every attack is followed by a read of the sentinel through
// the attacked view, so the control (same argv without the mask) proves the oracle can see it.
// "Attack effective" says whether the attack itself worked on the control; for rmdir, `mv $W
// $W.x`, umount, --move and remount it cannot, so there the control only proves the readback
// channel, and the positive-control lines show the same commands working on an unlocked mount.
//
// Verdicts: DENIED (target exposed nothing, control exposed), FORGEABLE, else INCONCLUSIVE.
// DENIED_LOCK is for rows whose attack cannot succeed on any control (rmdir or mv of a
// mountpoint, umount, --move, remount): it needs the target errno to be in the row's declared
// set AND the same verb to return rc=0 in a positive control run in the same execution context
// (Box, Box+unshare, nested, nested+unshare); anything less is INCONCLUSIVE. For rmdir and mv the
// positive control uses a plain directory, because a mountpoint is EBUSY even when unlocked.
// NOT_APPLICABLE only for the case-alias rows (N11.*, P1.2, P1.3), and only when the host and
// every probed Box prove the upper-case and U+212A spellings of a marker file give ENOENT; the
// rows still run, so a leak stays FORGEABLE. A resolving or unclear probe runs them as usual.
// HS: a read-write bind whose source is under `.ploinky-box/` (plan D1's hardware store, which the
// product's hardware wiring binds the same way); its control widens the bind source to
// `.ploinky-box/` itself so the oracle can see the sentinel through that path.
// A masked target row that leaves drift in the real tree is FORGEABLE: nothing is restored, the
// remaining rows are skipped, the scratch workspace is kept, and the run exits 1.
// Exit: 0 all DENIED, DENIED_LOCK or NOT_APPLICABLE, 1 any FORGEABLE, 2 any INCONCLUSIVE,
// 3 harness failure, 64 usage. Cleanup removes only directories this run created, and refuses a
// --workspace that is `/`, $HOME, the repository root, or an ancestor of them.
//
// Usage: node hostStateMaskProbe.mjs [--steps N3,N11,...] [--platform mac|linux]
//   [--workspace NEWDIR] [--image REF] [--nested-image REF] [--json FILE] [--keep]
//   [--unmasked-target]  renders the target without the mask (rows should turn FORGEABLE)
//   [--self-test]        implies --unmasked-target; exits 0 only if every mask-dependent row
//                        (all but P1, N21, HS and the lock-only rows) is FORGEABLE or NOT_APPLICABLE

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { AGENTLIB_STABLE_MOUNT_PATH, imageSourceIdentity } from '../../../agentlib/contract.mjs';
import { resolveBoxImageReference } from '../../../ploinky-box/constants.mjs';
import { normalizeBoxAgentLib } from '../../../ploinky-box/contract/agentlib.mjs';
import { selectedBoxNetworkMode } from '../../../ploinky-box/contract/network.mjs';
import {
    boxWorkspaceExecOptions,
    boxWorkspacePath,
    boxWorkspaceVolume,
} from '../../../ploinky-box/contract/workspace-root.mjs';
import { discoverBoxOwnership } from '../../../ploinky-box/engine/discovery.mjs';
import { buildWorkspaceIdentity } from '../../../ploinky-box/identity.mjs';
import {
    containerCreateArgs,
    readContainerIdFromCidfile,
    startContainerAndWaitReady,
} from '../../../ploinky-box/lifecycle/container.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from '../../../ploinky-box/process.mjs';
import { NESTED_PODMAN_SECCOMP_BOX_PATH } from '../../../ploinky-box/seccomp.mjs';
import { inspectWorkspaceDataPaths } from '../../../ploinky-box/workspace-data.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const DEFAULT_NESTED_IMAGE = 'docker.io/library/alpine:3.22';
const BOX_TIMEOUT_SECONDS = 3600;
const PROBE_LABEL = 'io.assistos.ploinky-box-probe.run';
const STEP_ORDER = ['N3', 'N4', 'N4b', 'N4c', 'N21', 'HS', 'P1', 'N11'];
const MASK_DEPENDENT = ['N3', 'N4', 'N4b', 'N4c', 'N11'];
const HS_DESTINATION = '/run/ploinky/hardware-limits';
const DEFAULT_STEPS = {
    mac: ['N3', 'N4', 'N11', 'P1', 'HS'],
    linux: ['N3', 'N4', 'N4b', 'N4c', 'N11', 'N21', 'P1', 'HS'],
};
const KELVIN = '\u212A';
// Mirrors renderContainerSecurityArgs for containerSecurity.nestedPodman
// (cli/sandbox/runtimeCapabilities.js:1033-1041).
const NESTED_PODMAN_PROFILE = [
    '--cap-add', 'SYS_ADMIN', '--cap-add', 'NET_ADMIN',
    '--device', '/dev/fuse', '--device', '/dev/net/tun',
    '--security-opt', 'label=disable',
    '--security-opt', `seccomp=${NESTED_PODMAN_SECCOMP_BOX_PATH}`,
];
const ERRNOS = [
    ['EROFS', /Read-only file system/i],
    ['EBUSY', /busy/i],
    ['ENOTEMPTY', /not empty/i],
    ['EINVAL', /Invalid argument|not mounted|not a mount ?point|wrong fs type|can't unmount/i],
    ['EPERM', /Operation not permitted|must be superuser/i],
    ['EACCES', /Permission denied|permission denied/],
    ['ENOENT', /No such file or directory/i],
];

class HarnessError extends Error {}

function note(message) {
    process.stderr.write(`[probe] ${message}\n`);
}

function usageError(message) {
    process.stderr.write(`usage error: ${message}\nsee the header of ${import.meta.filename}\n`);
    process.exit(64);
}

function parseArgs(argv) {
    const options = { keep: false, nestedImage: DEFAULT_NESTED_IMAGE };
    const valued = {
        '--steps': 'steps', '--platform': 'platform', '--workspace': 'workspace',
        '--image': 'image', '--nested-image': 'nestedImage', '--json': 'json',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--keep') options.keep = true;
        else if (arg === '--unmasked-target') options.unmaskedTarget = true;
        else if (arg === '--self-test') options.unmaskedTarget = options.selfTest = true;
        else if (valued[arg] && index + 1 < argv.length) options[valued[arg]] = argv[++index];
        else usageError(arg);
    }
    const host = { darwin: 'mac', linux: 'linux' }[process.platform];
    options.platform ||= host;
    if (options.platform !== host) usageError(`--platform ${options.platform} does not match ${process.platform}`);
    const requested = (options.steps ? options.steps.split(',') : DEFAULT_STEPS[options.platform]).map((s) => s.trim());
    const unknown = requested.filter((step) => !STEP_ORDER.includes(step));
    if (unknown.length) usageError(`unknown step ${unknown.join(',')}`);
    options.steps = STEP_ORDER.filter((step) => requested.includes(step));
    return options;
}

// ---------------------------------------------------------------- engine ----

const runner = createProcessRunner({ env: buildEngineProcessEnvironment(process.env) });

function podman(args, timeoutMs = 120_000) {
    return runner.query('podman', args, { timeoutMs });
}

function podmanOk(args, timeoutMs) {
    const result = podman(args, timeoutMs);
    if (!result.ok) {
        const detail = (result.stderr || result.error?.message || '').trim().slice(0, 400);
        throw new HarnessError(`podman ${args.slice(0, 3).join(' ')} failed: ${detail}`);
    }
    return result.stdout.trim();
}

function commandOutput(command, args) {
    const result = runner.query(command, args, { timeoutMs: 60_000 });
    return `${result.stdout}${result.ok ? '' : result.stderr}`.trim();
}

function freePort(kind) {
    return new Promise((resolve, reject) => {
        const socket = kind === 'udp' ? dgram.createSocket('udp4') : net.createServer();
        socket.once('error', reject);
        const address = kind === 'udp' ? [0, '0.0.0.0'] : [0, '127.0.0.1'];
        socket[kind === 'udp' ? 'bind' : 'listen'](...address, () => {
            const { port } = socket.address();
            socket.close(() => resolve(port));
        });
    });
}

function ensureImage(reference, pulled) {
    let inspected = podman(['image', 'inspect', '--format', 'json', reference]);
    if (!inspected.ok) {
        note(`pulling ${reference}`);
        podmanOk(['pull', reference], 1_800_000);
        pulled.add(reference);
        inspected = podman(['image', 'inspect', '--format', 'json', reference]);
    }
    const image = JSON.parse(inspected.stdout)[0];
    return {
        reference, id: image.Id, digest: image.Digest, repoDigests: image.RepoDigests, arch: image.Architecture,
    };
}

// ------------------------------------------------------------- host oracle ----

function lineFor(stat, target) {
    const kind = stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : stat.isSymbolicLink() ? 'l' : '?';
    const sha = stat.isFile() && stat.size < 8 * 1024 * 1024
        ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') : '-';
    const size = stat.isDirectory() ? 0 : stat.size;
    return `${kind}\t${(stat.mode & 0o7777).toString(8)}\t${size}\t${sha}`;
}

// One line per entry: type, mode, size, sha256; the two mask-relevant directories
// also carry dev:ino so a replaced directory is visible.
function walk(root, withIdentity = false) {
    const lines = new Map();
    const visit = (target, relative) => {
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch {
            lines.set(relative || '.', 'ABSENT');
            return;
        }
        const identity = withIdentity && (relative === '' || relative === 'empty') ? `\t${stat.dev}:${stat.ino}` : '';
        lines.set(relative || '.', lineFor(stat, target) + identity);
        if (!stat.isDirectory()) return;
        for (const name of fs.readdirSync(target).sort()) {
            visit(path.join(target, name), path.posix.join(relative, name));
        }
    };
    visit(root, '');
    return lines;
}

function snapshot(ctx) {
    const top = new Map();
    for (const name of fs.readdirSync(ctx.W)) {
        top.set(name, fs.lstatSync(path.join(ctx.W, name)).isDirectory() ? 'd' : 'f');
    }
    return {
        top, host: walk(ctx.paths.host, true), data: walk(ctx.paths.data), checkout: walk(ctx.paths.checkout),
    };
}

function diffMaps(before, after, label, ignoreIdentity) {
    const out = [];
    const core = (line) => (ignoreIdentity ? line.split('\t').slice(0, 4).join('\t') : line);
    for (const [key, value] of after) {
        if (!before.has(key)) out.push(`+${label}/${key}`);
        else if (core(before.get(key)) !== core(value)) out.push(`~${label}/${key}`);
    }
    for (const key of before.keys()) if (!after.has(key)) out.push(`-${label}/${key}`);
    return out;
}

function diffSnapshots(before, after, ignoreIdentity = false) {
    return [
        ...diffMaps(before.top, after.top, 'ws'),
        ...diffMaps(before.host, after.host, '.ploinky-box', ignoreIdentity),
        ...diffMaps(before.data, after.data, '.ploinky/data'),
        ...diffMaps(before.checkout, after.checkout, 'checkout'),
    ];
}

function writeSeedFiles(ctx) {
    const { host, data, checkout } = ctx.paths;
    fs.writeFileSync(path.join(host, ctx.sentinel.hostName), `${ctx.sentinel.hostToken}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(data, ctx.sentinel.dataName), `${ctx.sentinel.dataToken}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(checkout, 'README'), 'fake checkout\n');
    fs.writeFileSync(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

function seed(ctx) {
    const { host, data, checkout } = ctx.paths;
    fs.mkdirSync(path.join(host, 'empty'), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    if (ctx.options.steps.includes('HS')) fs.mkdirSync(ctx.paths.store, { recursive: true });
    writeSeedFiles(ctx);
    fs.chmodSync(host, 0o700);
    fs.chmodSync(path.join(host, 'empty'), 0o555);
}

function keepOnly(dir, keep) {
    for (const name of fs.readdirSync(dir)) {
        if (!keep.includes(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
}

// Puts the real trees back to the seeded state after a row. While a masked Box
// runs, `.ploinky-box` and `empty/` are never renamed or removed (plan D1), and
// the checkout directory (a bind source in the shadow Box) keeps its inode.
function restore(ctx, masked) {
    const drift = diffSnapshots(ctx.baseline, snapshot(ctx));
    if (!drift.length) return false;
    const { host, data, checkout } = ctx.paths;
    keepOnly(ctx.W, [...ctx.baseline.top.keys()]);
    if (!fs.existsSync(host)) {
        if (masked) throw new HarnessError('masked .ploinky-box vanished; no restore under a live mask');
        fs.mkdirSync(path.join(host, 'empty'), { recursive: true });
        fs.chmodSync(host, 0o700);
        fs.chmodSync(path.join(host, 'empty'), 0o555);
    }
    keepOnly(host, ['empty', 'hardware-limits']);
    if (ctx.options.steps.includes('HS')) fs.mkdirSync(ctx.paths.store, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    // The Box entrypoint itself writes `.ploinky/data/master-key`; keep what the baseline had.
    keepOnly(data, [...ctx.baseline.data.keys()].filter((key) => key !== '.' && !key.includes('/')));
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    keepOnly(checkout, ['README', '.git']);
    keepOnly(path.join(checkout, '.git'), ['HEAD']);
    writeSeedFiles(ctx);
    // Unmasked: a recreated directory legitimately has a new inode. Masked: it must not.
    const remaining = diffSnapshots(ctx.baseline, snapshot(ctx), !masked);
    if (remaining.length) throw new HarnessError(`host tree not restorable: ${remaining.join(' ')}`);
    if (!masked) ctx.baseline = snapshot(ctx);
    return drift;
}

// ------------------------------------------------------ case-name resolution ----

// Do the upper-case and U+212A (Kelvin) spellings of a marker file resolve to it? Only a
// proven ENOENT for both spellings, on the host and in every probed Box, makes the alias rows
// NOT_APPLICABLE; a resolving or unclear answer keeps them as ordinary rows.
function classify(code, message) {
    if (code === 0) return 'resolves';
    return /No such file or directory/i.test(message) ? 'absent' : 'unclear';
}

function hostFsType(W) {
    if (process.platform === 'linux') return commandOutput('stat', ['-f', '-c', '%T', W]);
    const device = commandOutput('sh', ['-c', `df -P ${W} | tail -1 | cut -d' ' -f1`]);
    return commandOutput('sh', ['-c', `mount | grep -F "${device} on " | head -1 | sed 's/.*(\\(.*\\))/\\1/'`]);
}

function seedCaseMarker(ctx) {
    const name = `.probe-kelvin-${crypto.randomBytes(4).toString('hex')}`;
    const variants = { upper: name.toUpperCase(), kelvin: name.replace('k', KELVIN) };
    fs.writeFileSync(path.join(ctx.W, name), 'case marker\n');
    const host = {};
    for (const [label, variant] of Object.entries(variants)) {
        try {
            fs.lstatSync(path.join(ctx.W, variant));
            host[label] = 'resolves';
        } catch (error) {
            host[label] = error.code === 'ENOENT' ? 'absent' : 'unclear';
        }
    }
    const markerOk = fs.existsSync(path.join(ctx.W, name));
    if (!markerOk) host.upper = 'unclear';
    ctx.caseProbe = { name, variants, host, hostFs: hostFsType(ctx.W), boxes: [] };
}

function probeCaseInBox(ctx, box) {
    const { name, variants } = ctx.caseProbe;
    const check = (label, file) => `out=$(stat -c %n "${ctx.W}/${file}" 2>&1); echo "[case] ${label} rc=$? $out"`;
    const script = [check('marker', name), check('upper', variants.upper), check('kelvin', variants.kelvin),
        `echo "[case] fs $(stat -f -c %T ${ctx.W}) | $(df -T ${ctx.W} | tail -1)"`].join('; ');
    const text = execInBox(ctx, box, script, 60).stdout;
    const answer = {};
    for (const label of ['marker', 'upper', 'kelvin']) {
        const match = text.match(new RegExp(`\\[case\\] ${label} rc=(\\d+) (.*)`));
        answer[label] = match ? classify(Number(match[1]), match[2]) : 'unclear';
    }
    if (answer.marker !== 'resolves') answer.upper = answer.kelvin = 'unclear';
    const fsInfo = (text.match(/\[case\] fs (.*)/) || [])[1] || '?';
    ctx.caseProbe.boxes.push({ variant: box.variant, upper: answer.upper, kelvin: answer.kelvin, fs: fsInfo });
}

// NOT_APPLICABLE needs every answer to be a proven ENOENT; anything else returns null.
function caseNotApplicable(ctx) {
    const { host, boxes, hostFs } = ctx.caseProbe;
    const all = [host.upper, host.kelvin, ...boxes.flatMap((b) => [b.upper, b.kelvin])];
    if (!boxes.length || all.some((answer) => answer !== 'absent')) return null;
    return `host upper/kelvin=${host.upper}/${host.kelvin} fs=${hostFs}; ${boxes
        .map((b) => `${b.variant} Box upper/kelvin=${b.upper}/${b.kelvin} fs=${b.fs}`).join('; ')}`;
}

// -------------------------------------------------------------- Box lifecycle ----

// Removes each injected argument group from the variant and proves the rest is
// exactly what `containerCreateArgs` rendered.
function withoutInjections(argv, groups) {
    const rest = [...argv];
    for (const group of groups) {
        const at = rest.findIndex((_, index) => group.every((value, offset) => rest[index + offset] === value));
        if (at < 0) throw new HarnessError(`injected argument group missing: ${group.join(' ')}`);
        rest.splice(at, group.length);
    }
    return rest;
}

function execInBox(ctx, box, script, timeoutSeconds) {
    const result = runner.query('podman', [
        'container', 'exec', '--user', 'podman', ...boxWorkspaceExecOptions(ctx.W), box.cid,
        'timeout', '-s', 'KILL', String(timeoutSeconds), 'sh', '-c', script,
    ], { timeoutMs: (timeoutSeconds + 30) * 1000 });
    return {
        status: result.status,
        stdout: `${result.stdout}${result.stderr}`,
        timedOut: result.status === 137 || Boolean(result.error),
    };
}

function renderArgv(ctx, variant, cidfile, ports) {
    const { mask, shadow, hs } = ctx.variants[variant];
    const rendered = containerCreateArgs({
        identity: ctx.identity,
        dataFingerprints: inspectWorkspaceDataPaths({ identity: ctx.identity }).fingerprints,
        agentLib: ctx.agentLib,
        imageId: ctx.imageId,
        imageRef: ctx.image.reference,
        hostPort: ports.tcp,
        mediaHostPort: ports.udp,
        routerBinding: null,
        repositoryRoot,
        cidfile,
        hostKind: ctx.engine.hostKind,
        networkMode: selectedBoxNetworkMode(ctx.engine),
    });
    const groups = [['--timeout', String(BOX_TIMEOUT_SECONDS)], ['--label', `${PROBE_LABEL}=${ctx.runId}`]];
    const argv = [...rendered];
    argv.splice(2, 0, ...groups.flat());
    const workspaceBind = boxWorkspaceVolume(ctx.W);
    const bind = argv.findIndex((arg, index) => arg === '--volume' && argv[index + 1] === workspaceBind);
    if (bind < 0 || argv.filter((arg) => arg === workspaceBind).length !== 1) {
        throw new HarnessError('workspace bind not found exactly once in the rendered argv');
    }
    const volumes = [];
    if (mask) volumes.push(['--volume', `${ctx.paths.host}/empty:${ctx.paths.host}:ro`]);
    if (shadow) volumes.push(['--volume', `${ctx.paths.checkout}:${boxWorkspacePath(ctx.W, '.runtime/ploinky')}:ro`]);
    if (hs) volumes.push(['--volume', `${hs === 'store' ? ctx.paths.store : ctx.paths.host}:${HS_DESTINATION}`]);
    argv.splice(bind + 2, 0, ...volumes.flat());
    groups.push(...volumes);
    if (JSON.stringify(withoutInjections(argv, groups)) !== JSON.stringify(rendered)) {
        throw new HarnessError('variant argv differs from the rendered argv beyond the injections');
    }
    ctx.argv[variant] = { argv, injected: groups.map((group) => group.join(' ')) };
    return argv;
}

function checkMounts(ctx, variant, mounts) {
    const { mask, shadow, hs } = ctx.variants[variant];
    const expected = [
        [ctx.paths.host, mask, false, '/empty'],
        [boxWorkspacePath(ctx.W, '.runtime/ploinky'), shadow, false, '/.runtime/ploinky'],
        [HS_DESTINATION, Boolean(hs), true, hs === 'store' ? '.ploinky-box/hardware-limits/x/store' : '.ploinky-box'],
    ];
    for (const [destination, wanted, rw, sourceEnd] of expected) {
        const mount = mounts.find((entry) => entry.Destination === destination);
        if (Boolean(mount) !== wanted || (mount && (mount.RW !== rw || !mount.Source.endsWith(sourceEnd)))) {
            throw new HarnessError(`${variant} Box mount ${destination} does not match: ${JSON.stringify(mount)}`);
        }
    }
}

async function createBox(ctx, variant) {
    const cidfile = path.join(ctx.evidenceDir, `${variant}.cid`);
    const argv = renderArgv(ctx, variant, cidfile, { tcp: await freePort('tcp'), udp: await freePort('udp') });
    note(`creating ${variant} Box (${JSON.stringify(ctx.variants[variant])})`);
    podmanOk(argv, 300_000);
    const cid = readContainerIdFromCidfile(cidfile);
    ctx.cids.push(cid);
    const log = { buffer: '', write(chunk) { this.buffer += String(chunk); } };
    await startContainerAndWaitReady(ctx.engine, cid, runner, { stdout: log, stderr: log, timeoutMs: 300_000 });
    const box = { variant, cid, mask: ctx.variants[variant].mask };
    const mounts = JSON.parse(podmanOk(['container', 'inspect', '--format', '{{json .Mounts}}', cid]));
    checkMounts(ctx, variant, mounts);
    const rel = (target) => path.posix.relative(ctx.W, target) || '.';
    box.mounts = mounts.filter((mount) => mount.Destination.startsWith(ctx.W))
        .map((mount) => `${rel(mount.Destination)} <- ${rel(mount.Source)} rw=${mount.RW}`);
    const info = '{{.Host.Kernel}} oci={{.Host.OCIRuntime.Name}} {{.Host.OCIRuntime.Version}}';
    box.env = execInBox(ctx, box, `uname -a; podman --version; podman info --format '${info}' | head -1; id -u`, 90)
        .stdout.trim().split('\n');
    const load = execInBox(ctx, box, `podman load -i ${ctx.W}/.probe-nested-image.tar`, 300);
    if (load.status !== 0) throw new HarnessError(`nested image load failed in ${variant}: ${load.stdout.slice(-300)}`);
    box.nestedImage = execInBox(
        ctx, box, `podman image inspect --format '{{.Digest}} {{.Id}}' ${ctx.nestedImage.id}`, 60,
    ).stdout.trim();
    probeCaseInBox(ctx, box);
    ctx.baseline = snapshot(ctx);
    return box;
}

function removeBox(ctx, box) {
    podmanOk(['container', 'rm', '--force', '--time', '0', box.cid], 120_000);
    ctx.cids.splice(ctx.cids.indexOf(box.cid), 1);
    ctx.removed.push(box.cid);
}

// ------------------------------------------------------------------- rows ----

const b64 = (script) => Buffer.from(script, 'utf8').toString('base64');
// Passing scripts through base64 keeps every nesting layer free of quoting.
const shell = (script) => `sh -c "$(echo ${b64(script)} | base64 -d)"`;
const innerScript = (attack, back) => (
    `{ ${attack}; } 2>&1; echo "[attack-rc] $?"; echo "[readback]"; { ${back}; } 2>&1; echo "[done]"`
);

function buildRows(ctx) {
    const { W } = ctx;
    const H = `${W}/.ploinky-box`;
    const look = (dir) => `ls -A ${dir}; cat ${dir}/sentinel-*`;
    const lookAll = (dir, tag) => `${look(dir)}; touch ${dir}/pwn-${tag}; ls -A ${dir}; ls -A /mnt`;
    const rows = [];
    const add = (step, id, plan, spec) => rows.push({
        step, id: `${step}.${id}`, plan, expect: '', box: { target: 'target', control: 'control' }, ...spec,
    });
    const n3 = [
        ['1', 'mv $W/.ploinky-box $W/x', `mv ${H} ${W}/x`, `${look(H)}; ls -A ${W}/x`, 'EBUSY'],
        ['2', 'rmdir $W/.ploinky-box', `rmdir ${H}`, look(H), 'EBUSY', { verb: 'rmdir', errnos: ['EBUSY'] }],
        ['3', 'touch $W/.ploinky-box/f', `touch ${H}/f`, look(H), 'EROFS'],
        ['4', 'mkdir $W/.ploinky-box/d', `mkdir ${H}/d`, look(H), 'EROFS'],
        ['5', 'ls -A $W/.ploinky-box', `ls -A ${H}`, look(H), 'empty'],
        ['6', 'mv $W $W.x', `mv ${W} ${W}.x`, look(H), 'EBUSY', { verb: 'mv', errnos: ['EBUSY', 'EACCES'] }],
    ];
    const n4b = [
        ['1', 'umount $W/.ploinky-box', `umount ${H}`, 'EINVAL', { verb: 'umount', errnos: ['EINVAL', 'EPERM'] }],
        ['2', 'umount -l $W/.ploinky-box', `umount -l ${H}`, 'EINVAL',
            { verb: 'umount -l', errnos: ['EINVAL', 'EPERM'] }],
        ['3', 'mount --move $W/.ploinky-box /mnt', `mount --move ${H} /mnt`, 'EINVAL',
            { verb: 'mount --move', errnos: ['EINVAL', 'EPERM'] }],
        ['4', 'mount -o remount,rw,bind $W/.ploinky-box', `mount -o remount,rw,bind ${H}`, 'EPERM',
            { verb: 'remount', errnos: ['EPERM', 'EACCES', 'EINVAL'] }],
    ];
    const volume = `-v ${W}:${W}`;
    const profile = NESTED_PODMAN_PROFILE.join(' ');
    const lockOf = (lock, context) => (lock ? { lock: { ...lock, context } } : {});
    for (const [id, plan, attack, back, expect, lock] of n3) {
        add('N3', id, plan, { attack, back, expect, ...lockOf(lock, 'box') });
    }
    add('N4', '1', 'podman run -v $W:$W alpine ls -A $W/.ploinky-box', {
        nested: { volume }, attack: `ls -A ${H}`, back: look(H), expect: 'empty',
    });
    add('N4', '2', 'podman run --mount type=bind,src=$W,dst=/w,bind-nonrecursive=true alpine true', {
        nested: { volume: `--mount type=bind,src=${W},dst=/w,bind-nonrecursive=true` },
        attack: 'true',
        back: look('/w/.ploinky-box'),
        expect: 'create fails (named errno)',
        // A pull or load failure in the nested engine must not count as the expected refusal.
        createFail: /invalid argument|operation not permitted|permission denied/i,
    });
    add('N4', '3', 'unshare -Urm sh -c "mount --bind $W /mnt"', {
        unshare: true, attack: `mount --bind ${W} /mnt`, back: look('/mnt/.ploinky-box'), expect: 'EINVAL',
    });
    add('N4', '4', 'unshare -Urm sh -c "mount --rbind $W /mnt && ls -A /mnt/.ploinky-box"', {
        unshare: true,
        attack: `mount --rbind ${W} /mnt && ls -A /mnt/.ploinky-box`,
        back: look('/mnt/.ploinky-box'),
        expect: 'empty',
    });
    for (const [id, plan, attack, expect, lock] of n4b) {
        add('N4b', id, `unshare -Urm sh -c "${plan}"`, {
            unshare: true, attack, back: lookAll(H, `n4b${id}`), expect, ...lockOf(lock, 'unshare'),
        });
    }
    for (const [id, plan, attack, back, expect, lock] of n3) {
        add('N4c', `n3.${id}`, `[nestedPodman] ${plan}`, {
            nested: { volume, profile }, attack, back, expect, ...lockOf(lock, 'nested'),
        });
    }
    for (const [id, plan, attack, expect, lock] of n4b) {
        add('N4c', `n4b.${id}`, `[nestedPodman] unshare -Urm sh -c "${plan}"`, {
            nested: { volume, profile }, unshare: true, attack, back: lookAll(H, `n4c${id}`), expect,
            ...lockOf(lock, 'nested+unshare'),
        });
        add('N4c', `direct.${id}`, `[nestedPodman, no unshare] ${plan}`, {
            nested: { volume, profile }, attack, back: lookAll(H, `direct${id}`), expect, ...lockOf(lock, 'nested'),
        });
    }
    const aliases = [
        ['1', `${W}/.PLOINKY-HOST`, 'ls -A'],
        ['2', `${W}/.ploin${KELVIN}y-host`, 'ls -A'],
        ['3', `${W}/.Ploinky-Host`, 'touch'],
    ];
    for (const [id, alias, verb] of aliases) {
        const named = path.basename(alias).replace(KELVIN, '<U+212A>');
        const plan = verb === 'touch' ? 'touch $W/.Ploinky-Host/f' : `ls -A $W/${named}`;
        for (const where of ['box', 'nested']) {
            // A fresh file name per row (plan: `f`): a guest cache of a name the host just
            // deleted can fake success.
            const attack = verb === 'touch' ? `touch ${alias}/f-${where}` : `ls -A ${alias}`;
            add('N11', `${where}.${id}`, where === 'box' ? plan : `[nested agent] ${plan}`, {
                ...(where === 'nested' ? { nested: { volume } } : {}),
                attack, back: look(alias), expect: 'ENOENT or empty', aliasRow: true,
            });
        }
    }
    // The alias lookups above can rename the mount point's dentry (mountinfo then shows the alias
    // spelling); a canonical write afterwards proves the mask still covers the real name.
    add('N11', 'post', 'touch $W/.ploinky-box/f (canonical name, after the alias lookups)', {
        attack: `touch ${H}/f-post`, back: look(H), expect: 'EROFS',
    });
    const checkout = `${W}/.runtime/ploinky`;
    const shadowBoxes = { target: 'target21', control: 'target' };
    add('N21', '1', 'touch $W/.runtime/ploinky/x', {
        attack: `touch ${checkout}/x`, back: `ls -A ${checkout}`, expect: 'EROFS', box: shadowBoxes,
    });
    add('N21', '2', 'touch $W/.runtime/ploinky/.git/x', {
        attack: `touch ${checkout}/.git/x`, back: `ls -A ${checkout}/.git`, expect: 'EROFS', box: shadowBoxes,
    });
    // HS: the read-write store bind lives under `.ploinky-box/`; nothing reachable through it may
    // reach the sentinel one to three levels above its source.
    const store = HS_DESTINATION;
    const hsBoxes = { target: 'targetHS', control: 'controlHS' };
    const hsAttacks = [
        ['1', `ls -A ${store}`, `ls -A ${store}`],
        ['2', `cd ${store} && ls -A .. ../.. ../../..; cat ../../sentinel-*`,
            `cd ${store} && ls -A .. ../.. ../../..; cat ../../sentinel-* ../../../sentinel-*`],
        ['3', `realpath ${store}/../..; cat $(realpath ${store})/../../sentinel-*`,
            `realpath ${store}/../..; ls -A "$(realpath ${store})"/../../..; cat "$(realpath ${store})"/../../sentinel-*`],
    ];
    for (const [id, plan, attack] of hsAttacks) {
        for (const where of ['box', 'nested']) {
            add('HS', `${where}.${id}`, where === 'box' ? plan : `[nested agent, -v ${store}] ${plan}`, {
                ...(where === 'nested' ? { nested: { volume: `-v ${store}:${store}` } } : {}),
                attack, back: look(store), expect: 'no sentinel', box: hsBoxes,
            });
        }
    }
    // P1 emulates cli/utils/runtime/controllerStateGuards.js: the `.ploinky` parent is
    // pinned read-only and an empty read-only guard source covers `.ploinky/data`.
    const guard = `/tmp/probe-guard-${ctx.runId}`;
    const pin = `${volume} -v ${W}/.ploinky:${W}/.ploinky:ro`;
    for (const [id, name] of [['1', '.ploinky'], ['2', '.PLOINKY'], ['3', `.ploin${KELVIN}y`]]) {
        const view = `${W}/${name}/data`;
        add('P1', id, `guard emulation: ls -A $W/${name.replace(KELVIN, '<U+212A>')}/data`, {
            nested: {
                volume: pin,
                guardVolume: `-v ${guard}/data:${W}/.ploinky/data:ro`,
                preamble: `mkdir -p ${guard}/data && chmod 0555 ${guard}/data; `,
            },
            attack: `ls -A ${view}`,
            back: look(view),
            expect: id === '1' ? 'empty (guard works)' : 'pre-existing; may leak on a case-insensitive fs',
            box: { target: 'target', control: 'target' },
            guarded: true,
            aliasRow: id !== '1',
        });
    }
    return rows;
}

function composeScript(ctx, row, mode) {
    let script = innerScript(row.attack, row.back);
    if (row.unshare) script = `unshare -Urm ${shell(script)} 2>&1; echo "[unshare-rc] $?"`;
    if (!row.nested) return script;
    const cidfile = `/tmp/probe-${ctx.runId}-${row.id}.cid`;
    const { volume: base, guardVolume } = row.nested;
    const volume = mode === 'target' && row.guarded ? `${base} ${guardVolume}` : base;
    const args = [
        '--rm', '--pull=never', '--network', 'none', '--timeout', '120', '--cidfile', cidfile,
        row.nested.profile || '', volume,
    ];
    return `${row.nested.preamble || ''}podman run ${args.join(' ')} ${ctx.nestedImage.id} `
        + `${shell(script)} 2>&1; echo "[run-rc] $?"; [ -f ${cidfile} ] && echo "[nested-cid] $(cat ${cidfile})"`;
}

function evaluate(ctx, row, run, before, after) {
    const text = run.stdout;
    const rcOf = (tag) => (text.match(new RegExp(`\\[${tag}\\] (\\d+)`)) || [])[1];
    const attackPart = text.split('[readback]')[0];
    const secrets = Object.values(ctx.sentinel);
    const hostDiff = diffSnapshots(before, after);
    const errnos = ERRNOS.filter(([, pattern]) => pattern.test(attackPart)).map(([name]) => name);
    const summary = attackPart.replace(/\[[a-z-]+\][^\n]*\n?/g, '').replace(/\s+/g, ' ').trim()
        .replaceAll(ctx.sentinel.hostName, '<S>').replaceAll(ctx.sentinel.dataName, '<S>').slice(0, 90);
    const readbackRan = text.includes('[readback]') && text.includes('[done]');
    return {
        rc: rcOf('attack-rc') ?? rcOf('unshare-rc') ?? rcOf('run-rc') ?? '?',
        errnos,
        summary,
        leaked: secrets.some((secret) => text.includes(secret)),
        hostDiff,
        hostChanged: hostDiff.length > 0,
        reached: readbackRan,
        createFailMatched: Boolean(row.createFail?.test(attackPart)) && !text.includes('[readback]'),
        timedOut: run.timedOut,
        attackEffective: rcOf('attack-rc') === '0',
        raw: text.slice(0, 6000),
    };
}

async function runRow(ctx, box, row, mode) {
    const before = snapshot(ctx);
    const run = execInBox(ctx, box, composeScript(ctx, row, mode), row.nested ? 240 : 90);
    return evaluate(ctx, row, run, before, snapshot(ctx));
}

// Positive control for the lock-only rows, run in the row's own execution context. Mount verbs
// run on a tmpfs the caller mounted itself (unlocked); rmdir and mv run on a plain directory,
// since a mountpoint is EBUSY even when unlocked. rc=0 shows the verb works in that context, so
// a locked-mount errno against the mask is the kernel's answer and not a missing tool or syscall.
const PC_VERBS = [
    ['rmdir', 'rmdir /tmp/pc/r'], ['mv', 'mv /tmp/pc/m /tmp/pc/m2'], ['umount', 'umount /tmp/pc/a'],
    ['umount -l', 'umount -l /tmp/pc/b'], ['mount --move', 'mount --move /tmp/pc/c /tmp/pc/e'],
    ['remount', 'mount -o remount,rw,bind /tmp/pc/d'],
];

function positiveControl(ctx, box, context) {
    const mounts = context !== 'box';
    const setup = 'mkdir -p /tmp/pc/a /tmp/pc/b /tmp/pc/c /tmp/pc/d /tmp/pc/e /tmp/pc/r /tmp/pc/m'
        + (mounts ? '; for d in a b c d; do mount -t tmpfs tmpfs /tmp/pc/$d; done' : '');
    const verbs = PC_VERBS.filter(([verb]) => mounts || ['rmdir', 'mv'].includes(verb));
    let script = [setup, ...verbs.map(([verb, command]) => `${command} 2>&1; echo "[pc] ${verb} rc=$?"`)].join('; ');
    if (context.endsWith('unshare')) script = `unshare -Urm ${shell(script)} 2>&1`;
    if (context.startsWith('nested')) {
        const args = ['--rm', '--pull=never', '--network', 'none', '--timeout', '120', ...NESTED_PODMAN_PROFILE];
        script = `podman run ${args.join(' ')} ${ctx.nestedImage.id} ${shell(script)} 2>&1`;
    }
    const text = execInBox(ctx, box, script, 240).stdout;
    const rcs = {};
    for (const match of text.matchAll(/\[pc\] (.+?) rc=(\d+)/g)) rcs[match[1]] = match[2];
    ctx.positive[context] = rcs;
    const shown = Object.entries(rcs).map(([verb, rc]) => `${verb} rc=${rc}`).join(', ') || 'no output';
    ctx.environment.push([`positive control (${context})`, shown]);
}

function lockProblem(ctx, row, target) {
    const { verb, context, errnos } = row.lock;
    const rc = ctx.positive[context]?.[verb];
    if (rc !== '0') return `positive control for '${verb}' in ${context} returned rc=${rc ?? 'none'}, not 0`;
    if (!target.errnos.some((errno) => errnos.includes(errno))) {
        return `target errno [${target.errnos.join('+') || 'none'}] is not in [${errnos.join(',')}]`;
    }
    return null;
}

function judge(target, control, { notApplicable = null, lock = undefined } = {}) {
    if (target.leaked || target.hostChanged) {
        const changed = target.hostChanged ? `changed ${target.hostDiff.join(' ')}` : '';
        return ['FORGEABLE', [target.leaked ? 'sentinel readable' : '', changed].filter(Boolean).join('; ')];
    }
    // The alias spellings provably do not exist on this filesystem; the row ran and exposed nothing.
    if (notApplicable && target.reached && !target.timedOut) return ['NOT_APPLICABLE', notApplicable];
    if (target.skipped) return ['INCONCLUSIVE', 'skipped after a masked write-through'];
    if (target.timedOut || !(target.reached || target.createFailMatched)) {
        return ['INCONCLUSIVE', 'target neither reached the readback nor showed a matching create failure'];
    }
    if (!control) return ['INCONCLUSIVE', 'control not run'];
    if (control.timedOut || !control.reached) return ['INCONCLUSIVE', 'control did not reach the readback'];
    if (!control.leaked && !control.hostChanged) return ['INCONCLUSIVE', 'control did not expose the sentinel'];
    if (lock === undefined) return ['DENIED', ''];
    return lock ? ['INCONCLUSIVE', lock] : ['DENIED_LOCK', 'errno in the declared set; positive control rc=0'];
    return ['DENIED', ''];
}

// ----------------------------------------------------------------- report ----

const cell = (text) => String(text).replaceAll('|', '/').replace(/\n/g, ' ');
const resultCell = (r) => {
    if (!r) return 'not run';
    const flags = `${r.timedOut ? 'TIMEOUT ' : ''}${r.reached ? '' : 'no-readback '}`;
    return `rc=${r.rc} ${r.errnos.join('+') || '-'} ${flags}"${r.summary}"`;
};
const oracleCell = (r) => {
    if (!r) return 'n/a';
    return `tree ${r.hostChanged ? `CHANGED ${r.hostDiff.join(' ')}` : 'unchanged'}; `
        + `sentinel ${r.leaked ? 'SEEN' : 'not seen'}`;
};

function printReport(ctx, results) {
    const out = ['## Environment', '', '| item | value |', '| --- | --- |'];
    for (const [key, value] of ctx.environment) out.push(`| ${key} | ${cell(value)} |`);
    out.push('', '## Rendered argv (containerCreateArgs of this checkout plus the listed injections only)', '');
    for (const [variant, { argv, injected }] of Object.entries(ctx.argv)) {
        out.push(`${variant} injections: ${injected.join(' | ')}`, `${variant} argv: ${JSON.stringify(argv)}`, '');
    }
    out.push(
        '## Results', '',
        '| step | command | target result | host oracle on target | control result | host oracle on control '
            + '| control exposes / attack effective | verdict |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const { row, target, control, verdict, why } of results) {
        const yesNo = (flag, no = 'no') => (flag ? 'yes' : no);
        const exposes = control
            ? `${yesNo(control.leaked || control.hostChanged, 'NO')} / ${yesNo(control.attackEffective)}` : 'n/a';
        const label = `${row.id}${row.step === 'P1' ? ' (pre-existing)' : ''}`;
        out.push(`| ${label} | ${cell(row.plan)} | ${cell(resultCell(target))} (plan: ${cell(row.expect)}) `
            + `| ${cell(oracleCell(target))} | ${cell(resultCell(control))} | ${cell(oracleCell(control))} `
            + `| ${exposes} | **${verdict}**${why ? ` ${cell(why)}` : ''} |`);
    }
    return out.join('\n');
}

// ------------------------------------------------------------------- main ----

function exitCodeFor(results) {
    if (results.some((r) => r.verdict === 'FORGEABLE')) return 1;
    return results.some((r) => r.verdict === 'INCONCLUSIVE') || !results.length ? 2 : 0;
}

// Self-test: with the mask removed from the target, every mask-dependent row must turn FORGEABLE
// (a proven-inapplicable alias row cannot). Lock-only rows, P1, N21 and HS do not depend on it.
function selfTestCode(results) {
    const needed = results.filter(({ row }) => MASK_DEPENDENT.includes(row.step) && !row.lock);
    const failing = needed.filter(({ verdict }) => !['FORGEABLE', 'NOT_APPLICABLE'].includes(verdict));
    note(`self-test: ${needed.length - failing.length}/${needed.length} mask-dependent rows FORGEABLE or NOT_APPLICABLE`
        + (failing.length ? `; not forgeable: ${failing.map(({ row }) => row.id).join(', ')}` : ''));
    return failing.length || !needed.length ? 1 : 0;
}

function removeTree(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}

function newContext(options) {
    const part = (prefix, bytes) => `${prefix}-${crypto.randomBytes(bytes).toString('hex')}`;
    const root = options.workspace ? null : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-hsmp-')));
    const W = options.workspace ? path.resolve(options.workspace) : path.join(root, 'workspace');
    return {
        options, W,
        // Paths this run created itself; cleanup removes nothing else.
        createdRoot: root, createdW: null, createdEvidence: null, preserve: false, writeThrough: null,
        positive: {},
        runId: crypto.randomBytes(5).toString('hex'),
        evidenceDir: `${W}.probe-evidence`,
        cids: [], removed: [], argv: {}, environment: [], pulled: new Set(),
        sentinel: {
            hostName: part('sentinel', 8), hostToken: part('token', 16),
            dataName: part('sentinel', 8), dataToken: part('token', 16),
        },
        variants: {
            target: { mask: !options.unmaskedTarget, shadow: false, hs: null },
            control: { mask: false, shadow: false, hs: null },
            target21: { mask: !options.unmaskedTarget, shadow: true, hs: null },
            targetHS: { mask: !options.unmaskedTarget, shadow: false, hs: 'store' },
            controlHS: { mask: false, shadow: false, hs: 'widened' },
        },
        paths: {
            host: path.join(W, '.ploinky-box'),
            store: path.join(W, '.ploinky-box', 'hardware-limits', 'x', 'store'),
            data: path.join(W, '.ploinky', 'data'),
            checkout: path.join(W, '.runtime', 'ploinky'),
        },
    };
}

// Removes only what this run recorded: its Box cids, the image it pulled for the nested
// probes, and its own scratch directories.
function cleanup(ctx) {
    const { options, W } = ctx;
    const report = [`recorded Box cids: ${[...ctx.removed, ...ctx.cids].join(', ') || 'none'}`];
    for (const cid of ctx.cids) {
        const removed = podman(['container', 'rm', '--force', '--time', '0', cid], 120_000);
        report.push(`${cid.slice(0, 12)} ${removed.ok ? 'removed' : `NOT removed: ${removed.stderr.trim()}`}`);
    }
    const label = `${PROBE_LABEL}=${ctx.runId}`;
    const left = podman(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}} {{.Names}}']);
    const count = left.ok ? left.stdout.trim().split('\n').filter(Boolean).length : 'unknown';
    report.push(`containers still labelled ${label}: ${count}`);
    if (ctx.nestedImage && ctx.pulled.has(ctx.nestedImage.reference)) {
        const removed = podman(['image', 'rm', ctx.nestedImage.reference]).ok;
        report.push(`nested image ${ctx.nestedImage.reference} (pulled by this run): ${removed ? 'removed' : 'kept'}`);
    }
    const owned = [ctx.createdEvidence, ctx.createdW, ctx.createdRoot].filter(Boolean);
    if (ctx.preserve || options.keep) {
        const why = ctx.preserve ? 'masked write-through evidence' : '--keep';
        report.push(`scratch kept (${why}): ${owned.join(', ') || 'none'}`);
    } else {
        for (const target of owned) {
            report.push(`removed own scratch ${target}: ${removeTree(target) && !fs.existsSync(target)}`);
        }
        const hint = owned.length ? '' : ' (not created by this run; untouched)';
        report.push(`workspace ${W} exists after cleanup: ${fs.existsSync(W)}${hint}`);
    }
    return report;
}

function preflight(ctx) {
    const { options, W } = ctx;
    for (const guarded of [os.homedir(), fs.realpathSync(os.homedir()), repositoryRoot, '/']) {
        if (guarded === W || guarded.startsWith(`${W}/`)) {
            throw new HarnessError(`refusing workspace ${W}: it is or contains ${guarded}`);
        }
    }
    if (fs.existsSync(W)) throw new HarnessError(`workspace ${W} must not exist; the probe creates and removes it`);
    if (fs.existsSync(ctx.evidenceDir)) throw new HarnessError(`${ctx.evidenceDir} already exists`);
    if (!/^[A-Za-z0-9_./-]+$/.test(W)) throw new HarnessError(`workspace path ${W} needs quoting this probe lacks`);
    for (let dir = path.dirname(W); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.ploinky'))) throw new HarnessError(`${dir} has a .ploinky marker`);
    }
    fs.mkdirSync(W);
    ctx.createdW = W;
    fs.mkdirSync(ctx.evidenceDir);
    ctx.createdEvidence = ctx.evidenceDir;
    if (options.platform === 'mac') {
        const visible = podman(['machine', 'ssh', `ls -d ${W}`]);
        if (!visible.ok) throw new HarnessError(`workspace not shared into the Podman VM: ${visible.stderr.trim()}`);
    }
    seedCaseMarker(ctx);
    fs.mkdirSync(path.join(W, '.ploinky', 'box', 'dependencies'), { recursive: true });
    fs.mkdirSync(path.join(W, '.ploinky', 'box', 'images'), { recursive: true });
    ctx.identity = buildWorkspaceIdentity(W, { markerFound: true });
    const discovered = discoverBoxOwnership(ctx.identity, { runner, env: process.env });
    if (discovered.state !== 'absent' || !discovered.engine) {
        throw new HarnessError(`engine or ownership not usable: ${discovered.state} ${discovered.message}`);
    }
    ctx.engine = discovered.engine;
    ctx.image = ensureImage(options.image || resolveBoxImageReference(), ctx.pulled);
    ctx.imageId = ctx.image.id.startsWith('sha256:') ? ctx.image.id : `sha256:${ctx.image.id}`;
    ctx.agentLib = normalizeBoxAgentLib({
        sourceDir: AGENTLIB_STABLE_MOUNT_PATH,
        sourceRelativePath: 'image',
        mode: 'image',
        supplyingImageId: ctx.imageId,
        sourceId: imageSourceIdentity(ctx.imageId),
    });
    ctx.nestedImage = ensureImage(options.nestedImage, ctx.pulled);
    podmanOk(['save', '--format', 'docker-archive', '-o', path.join(W, '.probe-nested-image.tar'),
        ctx.nestedImage.reference], 300_000);
}

function recordEnvironment(ctx) {
    const { options, engine, image, nestedImage } = ctx;
    const vm = options.platform === 'mac' ? podman(['machine', 'ssh', 'uname -a']).stdout.trim() : 'n/a (native Linux)';
    const server = podmanOk(['version', '--format', '{{.Server.Version}}']);
    const revision = commandOutput('git', ['-C', repositoryRoot, 'rev-parse', '--short', 'HEAD']);
    ctx.environment.push(
        ['run id / platform / steps', `${ctx.runId} / ${options.platform} / ${options.steps.join(',')}`],
        ['host uname -a', commandOutput('uname', ['-a'])],
        ['Podman machine VM uname -a', vm],
        ['outer podman client / server', `${podmanOk(['--version'])} / server ${server}`],
        ['engine', `hostKind=${engine.hostKind} rootlessNetworkCmd=${engine.rootlessNetworkCmd}`],
        ['Box image', `${image.reference} id=${ctx.imageId} repoDigests=${(image.repoDigests || []).join(',')} `
            + `arch=${image.arch} pulled-by-this-run=${ctx.pulled.has(image.reference)}`],
        ['nested image', `${nestedImage.reference} digest=${nestedImage.digest} id=${nestedImage.id} `
            + '(saved to <ws>/.probe-nested-image.tar, loaded per Box; nested runs: --pull=never --network none)'],
        ['workspace', `${ctx.W} (AgentLib mode image)`],
        ['host case probe (upper / Kelvin name)', `${ctx.caseProbe.host.upper} / ${ctx.caseProbe.host.kelvin}; `
            + `fs ${ctx.caseProbe.hostFs}`],
        ['repository mounted at /opt/ploinky', `${repositoryRoot} @ ${revision}`],
    );
}

async function runVariant(ctx, variant, work, outcome) {
    const box = await createBox(ctx, variant);
    ctx.environment.push([`${variant} Box`, `cid ${box.cid.slice(0, 12)}; mounts under ws: ${box.mounts.join('; ')}; `
        + `in-Box: ${box.env.join(' | ')}; nested image in Box: ${box.nestedImage}`]);
    if (variant === 'target') {
        const locked = work.filter(({ row, mode }) => row.lock && mode === 'target');
        const contexts = new Set(locked.map(({ row }) => row.lock.context));
        for (const context of contexts) positiveControl(ctx, box, context);
    }
    const mountinfo = () => commandOutput('podman', ['container', 'exec', box.cid, 'sh', '-c',
        'grep -i host/empty /proc/self/mountinfo | cut -d" " -f1-6']).replace(/\n/g, ' ; ') || 'none';
    let mountBefore = null;
    let mountMid = null;
    for (const { row, mode } of work) {
        note(`${row.id} on ${variant} Box (${mode} column)`);
        if (row.step === 'N11' && variant === 'target' && mountBefore === null) mountBefore = mountinfo();
        if (row.id === 'N11.post' && variant === 'target') mountMid = mountinfo();
        const result = await runRow(ctx, box, row, mode);
        outcome.get(row.id)[mode] = result;
        // A masked target row that changed the real tree is a write-through: touch nothing more.
        if (mode === 'target' && box.mask && result.hostChanged) {
            ctx.writeThrough = { row: row.id, diff: result.hostDiff };
            ctx.preserve = true;
            break;
        }
        result.restored = restore(ctx, box.mask);
    }
    if (mountBefore !== null) {
        const label = 'mask mount (mountinfo fields 1-6) before N11 / after the alias rows / after N11.post';
        ctx.environment.push([label, `${mountBefore} / ${mountMid} / ${mountinfo()}`]);
    }
    removeBox(ctx, box);
}

async function main() {
    const ctx = newContext(parseArgs(process.argv.slice(2)));
    let results = [];
    let code = 3;
    pendingCleanup = () => cleanup(ctx);
    try {
        preflight(ctx);
        recordEnvironment(ctx);
        seed(ctx);
        ctx.baseline = snapshot(ctx);
        const rows = buildRows(ctx).filter((row) => ctx.options.steps.includes(row.step))
            .sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step));
        const outcome = new Map(rows.map((row) => [row.id, { row, target: null, control: null }]));
        for (const variant of Object.keys(ctx.variants)) {
            const work = rows.flatMap((row) => ['target', 'control']
                .filter((mode) => row.box[mode] === variant).map((mode) => ({ row, mode })));
            if (work.length && !ctx.writeThrough) await runVariant(ctx, variant, work, outcome);
        }
        const missing = {
            reached: false, timedOut: false, leaked: false, hostChanged: false, hostDiff: [], skipped: true,
        };
        results = [...outcome.values()].map((entry) => {
            const options = {
                notApplicable: entry.row.aliasRow ? caseNotApplicable(ctx) : null,
                lock: entry.row.lock && entry.target ? lockProblem(ctx, entry.row, entry.target) : undefined,
            };
            const [verdict, why] = judge(entry.target || missing, entry.control, options);
            return { ...entry, verdict, why };
        });
        code = ctx.options.selfTest ? selfTestCode(results) : exitCodeFor(results);
        if (ctx.writeThrough) {
            note(`MASKED WRITE-THROUGH in ${ctx.writeThrough.row}: ${ctx.writeThrough.diff.join(' ')}`);
        }
        process.stdout.write(`${printReport(ctx, results)}\n`);
    } catch (error) {
        process.stderr.write(`[probe] harness failure: ${error.stack || error.message}\n`);
        code = 3;
    } finally {
        pendingCleanup = null;
        const report = cleanup(ctx);
        process.stdout.write(`\n## Cleanup\n\n${report.map((line) => `- ${line}`).join('\n')}\n\n## Exit\n\n${code}\n`);
        if (ctx.options.json) {
            const document = {
                code, environment: ctx.environment, argv: ctx.argv, results, cleanup: report,
                writeThrough: ctx.writeThrough,
            };
            fs.writeFileSync(ctx.options.json, JSON.stringify(document, null, 2));
        }
    }
    return code;
}

let pendingCleanup = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        pendingCleanup?.();
        process.exit(130);
    });
}
process.exitCode = await main();
