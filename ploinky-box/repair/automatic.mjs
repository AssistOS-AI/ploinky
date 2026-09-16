import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { resolveBoxImageReference } from '../constants.mjs';
import { collectHostDiagnostics } from '../diagnose/host.mjs';
import { inspectBindingPermissions } from './bindingPermissions.mjs';
import { sanitizeAuthorityDiagnostic } from '../../cli/sandbox/authorityCommandDiagnostics.mjs';

const TIMEOUT_MS = 10_000;
const clean = (value) => sanitizeAuthorityDiagnostic(String(value ?? ''), { limit: 2000 });
const pass = (result) => result?.ok === true && result.status === 0;

function json(result) {
    try {
        if (!pass(result) || String(result.stdout).length > 1024 * 1024) return null;
        return JSON.parse(result.stdout);
    } catch { return null; }
}

export function pullableImageReference(value) {
    if (typeof value !== 'string' || value.length >= 512) return false;
    // Podman interprets these prefixes as image transports, including local
    // archives/directories. They must never pass as registry hosts with ports.
    if (/^(?:containers-storage|dir|docker|docker-archive|docker-daemon|oci|oci-archive|ostree|sif):/i.test(value)) return false;
    const slash = value.indexOf('/');
    if (slash < 1) return false;
    const authority = value.slice(0, slash);
    const match = /^(\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(authority);
    if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return false;
    const host = match[1];
    if (host.startsWith('[')) {
        if (isIP(host.slice(1, -1)) !== 6) return false;
    } else {
        if (host.length > 253 || host.split('.').some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return false;
        // A bare namespace/repository uses Podman's short-name resolution,
        // which cannot identify one registry for unattended repair.
        if (!host.includes('.') && host.toLowerCase() !== 'localhost' && match[2] === undefined) return false;
    }
    const [named, digest, ...extra] = value.slice(slash + 1).split('@');
    if (extra.length || (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest))) return false;
    const colon = named.lastIndexOf(':');
    const repository = colon < 0 ? named : named.slice(0, colon);
    const tag = colon < 0 ? null : named.slice(colon + 1);
    if (tag !== null && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag)) return false;
    return repository.split('/').every((component) => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(component));
}

function selectedMachineIdentity(selected, record) {
    const uri = selected.URI ?? selected.uri;
    const identityPath = selected.Identity ?? selected.identity ?? '';
    if (typeof uri !== 'string' || !uri || typeof identityPath !== 'string'
        || typeof record.Created !== 'string' || !record.Created) return null;
    const ssh = record.SSHConfig;
    const resources = record.Resources;
    // Hash connection destinations and key paths; diagnostics never expose
    // them. State and LastUp are intentionally excluded because startup changes them.
    const values = [record.Name, record.Created, record.ConfigDir?.Path, record.Rootful,
        record.UserModeNetworking, record.Rosetta, ssh?.IdentityPath, ssh?.Port, ssh?.RemoteUsername,
        resources?.CPUs, resources?.DiskSize, resources?.Memory,
        selected.Name ?? selected.name, uri, identityPath];
    return Object.freeze({ name: record.Name, fingerprint: createHash('sha256').update(JSON.stringify(values)).digest('hex') });
}

function matchesMachine(expected, observed) {
    return typeof expected?.name === 'string' && /^[a-f0-9]{64}$/.test(expected.fingerprint || '')
        && observed?.name === expected.name && observed.fingerprint === expected.fingerprint;
}

export function inspectSelectedMachine({ runner, platform = process.platform, env = process.env } = {}) {
    const check = { id: 'repair.machine.state', label: 'Automatic Podman Machine startup', status: 'warn',
        code: 'MACHINE_UNVERIFIED', repairEligible: false,
        detail: 'The selected rootless Podman Machine could not be verified.',
        next: 'Inspect podman machine list and podman system connection list. Select the intended existing rootless Machine; repair never creates a VM or switches connections.' };
    if (platform !== 'darwin' || env.CONTAINER_HOST || env.PODMAN_HOST) return { check };
    const connections = json(runner.query('podman', ['system', 'connection', 'list', '--format', 'json'], { timeoutMs: TIMEOUT_MS }));
    const defaults = Array.isArray(connections) ? connections.filter((item) => (item.Default ?? item.default) === true) : [];
    const selected = defaults.length === 1 ? defaults[0] : null;
    if (!selected || (selected.IsMachine ?? selected.isMachine) !== true) return { check };
    const selectedName = selected.Name ?? selected.name;
    const machines = json(runner.query('podman', ['machine', 'list', '--format', 'json'], { timeoutMs: TIMEOUT_MS }));
    const matching = Array.isArray(machines) ? machines.filter((item) => item.Name === selectedName) : [];
    const machine = matching.length === 1 ? matching[0] : null;
    if (!machine || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(machine.Name)) return { check };
    const command = { file: 'podman', args: ['machine', 'inspect', machine.Name] };
    const inspected = json(runner.query(command.file, command.args, { timeoutMs: TIMEOUT_MS }));
    const record = Array.isArray(inspected) && inspected.length === 1 ? inspected[0] : null;
    if (!record || record.Name !== machine.Name || record.Rootful !== false) return { check: { ...check, command } };
    const machineIdentity = selectedMachineIdentity(selected, record);
    if (!machineIdentity) return { check: { ...check, command } };
    if (record.State === 'running') return { machineName: machine.Name, machineIdentity, check: { ...check, status: 'pass', code: 'MACHINE_RUNNING',
        machineIdentity,
        detail: 'The selected rootless Podman Machine is already running.', next: undefined, command } };
    if (record.State !== 'stopped') return { check: { ...check, detail: `Machine state is ${clean(record.State)}; automatic startup is unavailable.`, command } };
    return { machineName: machine.Name, machineIdentity, check: { ...check, status: 'fail', code: 'MACHINE_STOPPED_ELIGIBLE', repairEligible: true,
        machineName: machine.Name, machineIdentity, detail: `Selected rootless Machine ${machine.Name} is stopped.`,
        next: 'Run ploinky repair to start this existing rootless Machine as your normal user.', command } };
}

export function collectRepairAssessments({
    identity, host, runner, env = process.env, platform = process.platform,
    homeDirectory = os.homedir(), fsApi = fs, uid = process.getuid?.(),
} = {}) {
    const checks = inspectBindingPermissions({ identity, homeDirectory, fsApi, uid });
    const hostChecks = host?.checks || [];
    if (platform === 'darwin' && hostChecks.find((check) => check.id === 'host.podman.version')?.status === 'pass'
        && hostChecks.some((check) => check.id === 'host.machine.state' && check.status === 'fail')) {
        checks.push(inspectSelectedMachine({ runner, env, platform }).check);
    }
    if (host?.engineUsable && host.engineInfo) {
        const imageRef = resolveBoxImageReference(env);
        if (!pullableImageReference(imageRef)) {
            checks.push({ id: 'repair.image.cache', label: 'Configured Box image download', status: 'skip',
                code: 'LOCAL_IMAGE_REFERENCE', repairEligible: false,
                detail: 'The configured image is not a pullable registry reference; no automatic download is proposed.' });
        } else {
            const command = { file: 'podman', args: ['image', 'exists', imageRef] };
            const result = runner.query(command.file, command.args, { timeoutMs: TIMEOUT_MS });
            const missing = !result.error && result.status === 1;
            checks.push({ id: 'repair.image.cache', label: 'Configured Box image cache', command, exitCode: result.status,
                status: pass(result) ? 'pass' : missing ? 'warn' : 'fail',
                code: pass(result) ? 'IMAGE_CACHED' : missing ? 'IMAGE_CACHE_MISSING' : 'IMAGE_CACHE_UNAVAILABLE', repairEligible: missing,
                detail: pass(result) ? 'The configured Box image is already cached.'
                    : missing ? `Image ${clean(imageRef)} is not cached; repair can download it without restarting any container.`
                        : clean(result.stderr || result.error?.message || 'Image cache could not be inspected.'),
                ...(missing ? { next: 'Run ploinky repair to download the configured image as your current user.' } : {}) });
        }
    }
    return checks;
}

export async function pullMissingBoxImage({
    runner, env = process.env, platform = process.platform, progress = () => {},
    inspectHost = collectHostDiagnostics,
} = {}) {
    const host = inspectHost({ runner, env, platform });
    if (!host.engineUsable) return { status: 'skipped', detail: 'Host prerequisites changed; image download was not attempted.' };
    const imageRef = resolveBoxImageReference(env);
    if (!pullableImageReference(imageRef)) throw new Error('Automatic repair requires a qualified registry image reference.');
    const exists = runner.query('podman', ['image', 'exists', imageRef], { timeoutMs: TIMEOUT_MS });
    if (pass(exists)) return { status: 'skipped', detail: 'The image is already cached; no refresh was performed.' };
    if (exists.error || exists.status !== 1) throw new Error(clean(exists.stderr || exists.error?.message || 'Image availability could not be verified.'));
    const command = { file: 'podman', args: ['pull', imageRef] };
    progress(`Downloading ${clean(imageRef)} without changing running containers`);
    const result = typeof runner.stream === 'function'
        ? await runner.stream(command.file, command.args, { timeoutMs: 300_000, stdout: { write() {} }, stderr: { write() {} } })
        : runner.query(command.file, command.args, { timeoutMs: 300_000 });
    if (!pass(result)) return { status: 'failed', command, exitCode: result.status,
        detail: clean(result.stderr || result.error?.message || 'Image download failed.') };
    const verified = runner.query('podman', ['image', 'exists', imageRef], { timeoutMs: TIMEOUT_MS });
    if (!pass(verified)) return { status: 'failed', command, exitCode: verified.status, detail: 'Image download returned success but the image is not available.' };
    return { status: 'applied', command, exitCode: 0, detail: 'Configured image downloaded. Running containers were not restarted.' };
}

export async function startSelectedMachine({ runner, env = process.env, platform = process.platform, progress = () => {}, expectedMachine } = {}) {
    const before = inspectSelectedMachine({ runner, env, platform });
    if (!matchesMachine(expectedMachine, before.machineIdentity)) {
        return { status: 'skipped', detail: 'The assessed Machine or its connection/settings changed or could not be verified; no startup was attempted. Rerun ploinky repair.' };
    }
    if (before.check.code === 'MACHINE_RUNNING') return { status: 'skipped', detail: 'The selected Machine is already running.' };
    if (!before.check.repairEligible) return { status: 'skipped', detail: 'The selected stopped rootless Machine is no longer verified; no startup was attempted.' };
    const command = { file: 'podman', args: ['machine', 'start', before.machineName] };
    progress(`Starting the existing rootless Podman Machine ${before.machineName}`);
    const result = typeof runner.stream === 'function'
        ? await runner.stream(command.file, command.args, { timeoutMs: 180_000, stdout: { write() {} }, stderr: { write() {} } })
        : runner.query(command.file, command.args, { timeoutMs: 180_000 });
    if (!pass(result)) return { status: 'failed', command, exitCode: result.status,
        detail: clean(result.stderr || result.error?.message || 'Machine startup failed.') };
    const after = inspectSelectedMachine({ runner, env, platform });
    if (!matchesMachine(expectedMachine, after.machineIdentity) || after.check.code !== 'MACHINE_RUNNING') {
        return { status: 'failed', command, detail: 'Machine startup returned success, but the assessed rootless Machine is not confirmed running with its original connection and settings.' };
    }
    return { status: 'applied', command, exitCode: 0, detail: 'The selected rootless Machine is running; its connection and settings were preserved.' };
}
