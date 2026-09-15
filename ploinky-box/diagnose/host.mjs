import fs from 'node:fs';
import path from 'node:path';

import {
    MINIMUM_HOST_PODMAN_VERSION, completeMapping, distributionFamily,
    executable, installInstruction, onPath, supportedVersion,
} from '../hostPrerequisites.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from '../process.mjs';
import { sanitizeAuthorityDiagnostic } from '../../cli/sandbox/authorityCommandDiagnostics.mjs';

const TIMEOUT_MS = 5_000;
const ROOTLESS_DOCS = 'https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md';
const INFO_COMMAND = Object.freeze({ file: 'podman', args: ['info', '--format', 'json'] });

function readText(fsApi, filename) {
    try {
        const value = fsApi.readFileSync(filename, 'utf8');
        return value.length <= 1_048_576 ? String(value) : null;
    } catch { return null; }
}

function parseJson(value) {
    try {
        if (String(value || '').length > 1_048_576) return null;
        return JSON.parse(value);
    } catch { return null; }
}

function booleanSetting(value) {
    return value === true ? 'enabled' : value === false ? 'disabled' : 'not reported';
}

// This is a source inspection, not an AppArmor policy evaluator. Includes are
// followed only below /etc/apparmor.d, with bounded depth and total file count.
function profileSource(fsApi, filename, seen = new Set(), depth = 0) {
    if (depth > 8 || seen.size >= 32 || seen.has(filename)) return '';
    seen.add(filename);
    const source = readText(fsApi, filename);
    if (source === null) return '';
    let result = source.replace(/^\s*#(?!include\b).*$/gm, '').replace(/\s+#.*$/gm, '');
    for (const match of result.matchAll(/^\s*#?include\s+(?:if\s+exists\s+)?<([^>]+)>/gm)) {
        const included = path.resolve('/etc/apparmor.d', match[1]);
        if (included.startsWith('/etc/apparmor.d/')) result += `\n${profileSource(fsApi, included, seen, depth + 1)}`;
    }
    return result;
}

function inspectAppArmor({ add, fsApi, host }) {
    const enabled = readText(fsApi, '/sys/module/apparmor/parameters/enabled')?.trim();
    add('host.apparmor', 'Host AppArmor', enabled === undefined ? 'warn' : 'pass',
        `Kernel AppArmor: ${enabled ?? 'not readable'}; Podman container AppArmor: ${booleanSetting(host?.security?.apparmorEnabled)}. Host helper profiles can apply even when Podman reports container AppArmor disabled.`,
        enabled === undefined ? 'Inspect /sys/module/apparmor/parameters/enabled with an administrator if a runtime probe reports permission denied.' : undefined);
    if (enabled === 'N') {
        add('host.apparmor.profiles', 'AppArmor helper profiles', 'skip', 'The host AppArmor module is disabled.');
        return;
    }
    const loaded = readText(fsApi, '/sys/kernel/security/apparmor/profiles');
    const active = loaded === null ? 'Loaded profile state is not readable by this account.'
        : loaded.split(/\r?\n/).filter((line) => /^(?:pasta|fusermount3)(?:\s|\/\/)/.test(line)).join('; ') || 'Neither helper profile appears in the readable loaded-profile list.';
    add('host.apparmor.loaded', 'Loaded helper profiles', loaded === null ? 'warn' : 'pass', active,
        loaded === null ? 'If a probe is denied, ask an administrator to inspect aa-status and journalctl -k for the named profile and path.' : undefined);

    const pastaPath = '/etc/apparmor.d/usr.bin.pasta';
    const pasta = profileSource(fsApi, pastaPath);
    const run = '(?:@\\{run\\}|/run|/var/run)';
    const namespaceDirectory = new RegExp(`(?:^|\\n)\\s*${run}/netns/\\s+[a-z]*r[a-z]*\\s*,`).test(pasta);
    const namespaceFiles = new RegExp(`(?:^|\\n)\\s*${run}/netns/netns-\\*\\s+[a-z]*r[a-z]*\\s*,`).test(pasta);
    const pastaRules = namespaceDirectory && namespaceFiles;
    add('host.apparmor.pasta', 'pasta namespace profile rules', pasta ? (pastaRules ? 'pass' : 'warn') : 'skip',
        pasta ? `${pastaPath}: ${pastaRules ? 'explicit non-owner namespace read rules found' : 'the narrow namespace directory/file read rules were not found'}. Source inspection does not prove that the loaded policy permits the runtime operation; alternate rules may also grant access.`
            : `${pastaPath} is absent or unreadable; no profile-source conclusion is possible.`,
        pasta && !pastaRules ? 'If the networking probe reports pasta cannot open /run/netns/netns-*: ask an administrator to review AppArmor denials and add @{run}/netns/ r, and @{run}/netns/netns-* r, to the pasta profile, validate it, and reload only that profile.' : undefined);
    const fusePath = '/etc/apparmor.d/fusermount3';
    const fuse = profileSource(fsApi, fusePath);
    const fuseRule = /(?:^|\n)\s*umount\s+\/data\/podman\/storage\/overlay\/\*\/merged\/\s*,/.test(fuse);
    add('host.apparmor.fusermount', 'fusermount overlay cleanup profile rule', fuse ? (fuseRule ? 'pass' : 'warn') : 'skip',
        fuse ? `${fusePath}: ${fuseRule ? 'the nested overlay cleanup rule was found' : 'the narrow nested overlay cleanup rule was not found'}. This checks installed source, not effective loaded permissions.`
            : `${fusePath} is absent or unreadable; no profile-source conclusion is possible.`,
        fuse && !fuseRule ? 'If cleanup is denied at /data/podman/storage/overlay/*/merged/: ask an administrator to review AppArmor denials and add umount /data/podman/storage/overlay/*/merged/, to the fusermount3 profile, validate it, and reload only that profile.' : undefined);
}

/** Collect bounded host facts and probes without installing or changing policy. */
export function collectHostDiagnostics({
    runner, env = process.env, platform = process.platform, fsApi = fs,
    uid = process.getuid?.(), execPath = process.execPath, nodeVersion = process.version,
} = {}) {
    const processRunner = runner || createProcessRunner({ env: buildEngineProcessEnvironment(env) });
    const checks = [];
    const sensitiveValues = Object.entries(env).filter(([name]) => /token|secret|password|credential|key|authorization|cookie/i.test(name))
        .map(([, value]) => value);
    const clean = (value) => sanitizeAuthorityDiagnostic(String(value ?? ''), { limit: 2_000, sensitiveValues });
    const add = (id, label, status, detail, next, command, exitCode) => {
        checks.push({ id, label, status, detail: clean(detail), ...(next ? { next: clean(next) } : {}),
            ...(command ? { command: { file: clean(command.file), args: command.args.map(clean) } } : {}),
            ...(Number.isInteger(exitCode) ? { exitCode } : {}) });
    };
    const probe = (file, args) => {
        try { return processRunner.query(file, args, { timeoutMs: TIMEOUT_MS }); }
        catch (error) { return { ok: false, error }; }
    };
    const failure = (result) => {
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(result?.error?.code || '') ? result.error.code : '';
        return [code, clean(result?.stderr || '')].filter(Boolean).join(': ') || `Command failed (exit ${result?.status ?? 'unknown'}).`;
    };
    const family = platform === 'linux' ? distributionFamily(fsApi) : '';
    const install = (packages) => installInstruction(family, packages);

    add('host.node.runtime', 'Running Node.js', /^v(?:2[2-9]|[3-9]\d|\d{3,})\./.test(nodeVersion) ? 'pass' : 'fail',
        `${nodeVersion} at ${execPath}; Node.js 22 or newer is required.`,
        /^v(?:2[2-9]|[3-9]\d|\d{3,})\./.test(nodeVersion) ? undefined : 'Install a supported Node.js LTS from https://nodejs.org/en/download and reopen your shell.');
    const node = probe('node', ['--version']);
    const nodeSupported = node.ok && /^v(?:2[2-9]|[3-9]\d|\d{3,})\./.test(String(node.stdout).trim());
    add('host.node.path', 'Node.js selected on PATH', nodeSupported ? 'pass' : 'fail',
        node.ok ? `${String(node.stdout || '').trim()}; the public ploinky launcher uses node from PATH.` : failure(node),
        nodeSupported ? undefined : 'Fix PATH so node --version selects Node.js 22 or newer; then rerun ploinky diagnose.',
        { file: 'node', args: ['--version'] }, node.status);
    const supportedPlatform = ['linux', 'darwin'].includes(platform);
    add('host.platform', 'Host platform', supportedPlatform ? 'pass' : 'fail', platform,
        supportedPlatform ? undefined : 'Run Ploinky in a Linux login environment with native rootless Podman, or on macOS with Podman Machine. Host checks cannot inspect a Linux VM from this platform.');
    const rootlessUser = platform !== 'linux' || uid !== 0;
    add('host.user', 'Rootless execution account', rootlessUser ? 'pass' : 'fail', `Host UID: ${uid ?? 'not available'}.`,
        rootlessUser ? undefined : 'Exit the root shell and run ploinky as a regular login account without sudo.');
    const remoteOverride = Boolean(String(env.CONTAINER_HOST || env.PODMAN_HOST || '').trim());
    add('host.endpoint', 'Podman endpoint environment', remoteOverride ? 'fail' : 'pass',
        remoteOverride ? 'CONTAINER_HOST or PODMAN_HOST configures a remote endpoint. Its value is withheld.' : 'No unsupported remote endpoint override is configured.',
        remoteOverride ? 'Unset CONTAINER_HOST and PODMAN_HOST; use native Podman on Linux or the default Podman Machine connection on macOS.' : undefined);

    const version = probe('podman', ['--version']);
    const versionOkay = version.ok && supportedVersion(String(version.stdout || ''));
    add('host.podman.version', 'Podman version', versionOkay ? 'pass' : 'fail',
        version.ok ? `${String(version.stdout || '').trim()}; required >= ${MINIMUM_HOST_PODMAN_VERSION}.` : failure(version),
        versionOkay ? undefined : `${install(['podman', 'catatonit'])} Select Podman ${MINIMUM_HOST_PODMAN_VERSION} or newer; see https://podman.io/docs/installation.`,
        { file: 'podman', args: ['--version'] }, version.status);

    if (platform === 'linux') {
        for (const name of ['newuidmap', 'newgidmap']) {
            const binary = onPath(fsApi, env, name);
            add(`host.helper.${name}`, name, binary ? 'pass' : 'fail', binary || 'Executable not found on PATH.', binary ? undefined : install(['uidmap']));
        }
        for (const [device, module] of [['/dev/fuse', 'fuse'], ['/dev/net/tun', 'tun']]) {
            let usable = false;
            try {
                usable = fsApi.statSync(device).isCharacterDevice();
                fsApi.accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
            } catch { usable = false; }
            add(`host.device.${module}`, device, usable ? 'pass' : 'fail',
                usable ? 'Readable/writable character device.' : 'A readable/writable character device is required for nested containers.',
                usable ? undefined : `Ask an administrator to load the ${module} module with sudo modprobe ${module} and grant device access through the host udev/group policy. Reconnect after group changes.`);
        }
        for (const [name, filename] of [
            ['max_user_namespaces', '/proc/sys/user/max_user_namespaces'],
            ['unprivileged_userns_clone', '/proc/sys/kernel/unprivileged_userns_clone'],
            ['apparmor_restrict_unprivileged_userns', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'],
        ]) {
            const value = readText(fsApi, filename)?.trim();
            const blocked = name !== 'apparmor_restrict_unprivileged_userns' && value === '0';
            add(`host.sysctl.${name}`, name, blocked ? 'fail' : value === undefined ? 'skip' : 'pass',
                `${filename}: ${value ?? 'not present or readable'}${name === 'apparmor_restrict_unprivileged_userns' ? '; enforcement is not itself a failure: runtime namespace probes determine access' : ''}.`,
                blocked ? `Ask an administrator to enable rootless Podman under the host namespace and AppArmor policy; see ${ROOTLESS_DOCS}.` : undefined);
        }
    } else add('host.linux.prerequisites', 'Linux host devices, IDs and policy', 'skip',
        'Local Linux device, subordinate-ID, sysctl and AppArmor checks do not apply here. These prerequisites must be inspected inside the Linux Podman Machine.');

    if (platform === 'darwin' && version.ok && !remoteOverride) {
        const args = ['system', 'connection', 'list', '--format', 'json'];
        const result = probe('podman', args);
        const parsed = result.ok ? parseJson(result.stdout) : null;
        const defaults = Array.isArray(parsed) ? parsed.filter((item) => (item?.Default ?? item?.default) === true) : [];
        const selected = defaults.length === 1 ? defaults[0] : null;
        const machine = (selected?.IsMachine ?? selected?.isMachine) === true;
        add('host.machine', 'Selected Podman Machine connection', machine ? 'pass' : 'fail',
            machine ? `Default Machine connection: ${selected.Name ?? selected.name ?? '(unnamed)'}. Engine reachability is checked by podman info.`
                : result.ok ? 'Exactly one default connection identified as a Podman Machine is required.' : failure(result),
            machine ? undefined : 'Use podman machine list and podman system connection list to select your running rootless Podman Machine; do not select an arbitrary remote engine.',
            { file: 'podman', args }, result.status);
        const listArgs = ['machine', 'list', '--format', 'json'];
        const listed = probe('podman', listArgs);
        const machines = listed.ok ? parseJson(listed.stdout) : null;
        const name = selected?.Name ?? selected?.name;
        const matching = machine && typeof name === 'string' && Array.isArray(machines)
            ? machines.find((item) => typeof item?.Name === 'string' && (name === item.Name || name === `${item.Name}-root`)) : null;
        add('host.machine.state', 'Selected Podman Machine state', matching ? (matching.Running === true ? 'pass' : 'fail') : 'warn',
            matching ? `${matching.Name}: ${matching.Running === true ? 'running' : 'not running'}.`
                : listed.ok ? 'The default connection could not be matched to a named Machine in podman machine list. No VM state is inferred.' : failure(listed),
            matching?.Running === true ? undefined : 'Inspect podman machine list and the default connection. Start the intended existing Machine with podman machine start <name> if it is stopped.',
            { file: 'podman', args: listArgs }, listed.status);
    }

    let engineInfo = null;
    if (!supportedPlatform || remoteOverride || !version.ok || !rootlessUser) {
        add('host.podman.info', 'Podman engine information', 'skip',
            'Blocked by the host platform, root account, unavailable Podman, or unsupported endpoint override.', undefined, INFO_COMMAND);
    } else {
        const result = probe(INFO_COMMAND.file, INFO_COMMAND.args);
        const parsed = result.ok ? parseJson(result.stdout) : null;
        engineInfo = parsed?.host && typeof parsed.host === 'object' && !Array.isArray(parsed.host) ? parsed : null;
        add('host.podman.info', 'Podman engine information', engineInfo ? 'pass' : 'fail',
            engineInfo ? 'Engine answered with structured information. Container functionality is tested separately.'
                : result.ok ? 'podman info returned malformed or incomplete JSON.' : failure(result),
            engineInfo ? undefined : `Run podman info --format json as your regular login user. Check the failed command detail, subordinate IDs, login session, and namespace/AppArmor policy; see ${ROOTLESS_DOCS}.`,
            INFO_COMMAND, result.status);
    }
    const host = engineInfo?.host;
    if (platform === 'linux') inspectAppArmor({ add, fsApi, host });
    if (!host) {
        for (const [id, label] of [['engine', 'Engine settings and selected helpers'], ['storage', 'Podman storage settings'], ['mapping', 'Rootless UID/GID mappings']]) {
            add(`host.${id}`, label, 'skip', 'Requires successful podman info; repair that command first.');
        }
        return { checks, engineInfo, engineUsable: false };
    }
    const native = host.os === 'linux' && host.serviceIsRemote === (platform === 'darwin');
    add('host.podman.native', 'Selected Podman engine', native ? 'pass' : 'fail',
        `Engine OS: ${host.os ?? 'not reported'}; remote: ${host.serviceIsRemote ?? 'not reported'}.`,
        native ? undefined : platform === 'darwin' ? 'Select a Podman Machine connection with podman system connection default <machine-connection>.' : 'Select the native Linux Podman engine; remote engines are unsupported.');
    add('host.podman.rootless', 'Engine rootless mode', host.security?.rootless === true ? 'pass' : 'fail',
        `Rootless: ${booleanSetting(host.security?.rootless)}.`, host.security?.rootless === true ? undefined : 'Select a rootless engine for your regular account; do not run ploinky or podman with sudo.');
    add('host.seccomp', 'Engine seccomp support', host.security?.seccompEnabled === true ? 'pass' : 'fail',
        `Support: ${booleanSetting(host.security?.seccompEnabled)}; engine default profile: ${host.security?.seccompProfilePath || 'not reported'}. Ploinky uses its own nested-Podman seccomp profile for the Box.`,
        host.security?.seccompEnabled === true ? undefined : 'Install the distribution Podman and OCI runtime packages with seccomp support.');
    add('host.selinux', 'Engine SELinux support', 'pass', `SELinux: ${booleanSetting(host.security?.selinuxEnabled)}. The Box contract uses label=disable for its nested-container mounts.`);
    add('host.cgroup', 'Cgroup and login session settings', 'pass',
        `Engine manager=${host.cgroupManager ?? 'not reported'}, version=${host.cgroupVersion ?? 'not reported'}, controllers=${Array.isArray(host.cgroupControllers) ? host.cgroupControllers.join(',') || '(none)' : 'not reported'}; XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR || '(unset)'}, user bus=${env.DBUS_SESSION_BUS_ADDRESS ? 'configured' : 'unset'}. These are context, not cgroup-delegation prerequisites for the Box.`);
    const store = engineInfo.store || {};
    add('host.storage', 'Podman storage driver and configuration', store.graphDriverName ? 'pass' : 'warn',
        `driver=${store.graphDriverName || 'not reported'}; graphRoot=${store.graphRoot || 'not reported'}; runRoot=${store.runRoot || 'not reported'}; configFile=${store.configFile || 'not reported'}; graphOptions=${JSON.stringify(store.graphOptions ?? {})}; graphStatus=${JSON.stringify(store.graphStatus ?? {})}. Existing storage is not changed.`,
        store.graphDriverName ? undefined : 'Inspect podman info --format json and the selected storage.conf; diagnose does not select a driver or migrate existing storage.');
    if (store.graphDriverName === 'vfs') add('host.storage.vfs', 'VFS storage driver', 'warn',
        'The selected VFS driver copies filesystem layers and may use substantial disk space. Its presence alone does not prove deployment failure.',
        'Use the container probes to identify failures. Do not change the storage driver over an existing store; plan any storage migration separately.');

    if (platform === 'darwin') {
        add('host.helpers', 'Selected engine helper paths', 'skip',
            'Helper paths reported by the engine are inside Podman Machine and cannot be validated against the macOS filesystem.');
    } else if (native) {
        const selectedBinary = (id, label, selected, packages) => {
            const valid = typeof selected === 'string' && path.isAbsolute(selected) && executable(fsApi, selected);
            add(`host.helper.${id}`, label, valid ? 'pass' : 'fail',
                selected ? `Selected executable: ${selected}${valid ? '' : '; missing or not executable'}.` : 'podman info did not identify a selected executable.',
                valid ? undefined : `${install(packages)} Check the selected path and containers.conf with podman info.`);
        };
        selectedBinary('conmon', 'Selected container monitor', host.conmon?.path, ['conmon']);
        selectedBinary('oci', 'Selected OCI runtime', host.ociRuntime?.path, ['crun']);
        if (host.networkBackend === 'netavark') selectedBinary('network', 'Selected network backend', host.networkBackendInfo?.path, ['netavark']);
        else add('host.helper.network', 'Selected network backend', 'warn', `Backend: ${host.networkBackend ?? 'not reported'}; the netavark executable check does not apply.`, 'Inspect the selected networking backend with podman info; use the runtime probes to verify it.');
        const network = host.rootlessNetworkCmd;
        if (['pasta', 'slirp4netns'].includes(network)) selectedBinary('rootlessNetwork', `Selected rootless network (${network})`, host[network]?.executable, [network === 'pasta' ? 'passt' : network]);
        else add('host.helper.rootlessNetwork', 'Selected rootless network helper', 'fail',
            `Unsupported or missing selection: ${network ?? 'not reported'}.`, `${install(['passt'])} Configure [network] default_rootless_network_cmd="pasta" in containers.conf, then verify podman info.`);
        const mountProgram = store.graphOptions?.['overlay.mount_program'];
        if (mountProgram) selectedBinary('overlay', 'Selected overlay mount helper', typeof mountProgram === 'string' ? mountProgram : mountProgram.Executable, ['fuse-overlayfs']);
        else add('host.helper.overlay', 'Selected overlay mount helper', 'skip', 'The engine does not select overlay.mount_program; host fuse-overlayfs is not an unconditional prerequisite.');
    } else add('host.helpers', 'Selected engine helper paths', 'skip', 'Requires a verified native Linux engine; remote paths cannot be validated against the local filesystem.');

    for (const kind of ['uid', 'gid']) {
        const args = ['unshare', 'cat', `/proc/self/${kind}_map`];
        if (platform !== 'linux' || !native || host.security?.rootless !== true) {
            add(`host.mapping.${kind}`, `Rootless ${kind.toUpperCase()} mapping`, 'skip', 'Requires a local rootless Linux engine; inspect mappings inside Podman Machine when applicable.', undefined, { file: 'podman', args });
            continue;
        }
        const result = probe('podman', args);
        const valid = result.ok && completeMapping(String(result.stdout || ''));
        add(`host.mapping.${kind}`, `Rootless ${kind.toUpperCase()} mapping`, valid ? 'pass' : 'fail',
            result.ok ? `${String(result.stdout || '').trim().replace(/\r?\n/g, '; ') || '(empty mapping)'}; at least 65536 contiguous container IDs starting at 0 are required.` : failure(result),
            valid ? undefined : result.ok
                ? `Ask an administrator to allocate at least 65536 non-overlapping subordinate ${kind.toUpperCase()}s in /etc/sub${kind} for your account. Reconnect; if Podman already owns a namespace, stop your containers before running podman system migrate. ${ROOTLESS_DOCS}`
                : `Rerun the displayed podman unshare command as your login user. Inspect its error, /etc/sub${kind}, and host namespace/AppArmor denials; failed execution does not establish that subordinate IDs are missing. ${ROOTLESS_DOCS}`,
            { file: 'podman', args }, result.status);
    }
    return { checks, engineInfo, engineUsable: !checks.some((check) => check.status === 'fail') };
}
