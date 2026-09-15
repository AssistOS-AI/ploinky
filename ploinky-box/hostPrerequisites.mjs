import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from './errors.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';
import { sanitizeAuthorityDiagnostic } from '../cli/sandbox/authorityCommandDiagnostics.mjs';

export const MINIMUM_HOST_PODMAN_VERSION = '5.4.0';
const PROBE_TIMEOUT_MS = 5_000;
const REQUIRED_MAPPED_IDS = 65_536;
const INSTALL_DOCS = 'https://podman.io/docs/installation';
const ROOTLESS_DOCS = 'https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md';

function readText(fsApi, filename) {
    try { return fsApi.readFileSync(filename, 'utf8'); } catch { return null; }
}

function distributionFamily(fsApi) {
    const release = readText(fsApi, '/etc/os-release') || '';
    const names = [...release.matchAll(/^(?:ID|ID_LIKE)=["']?([^"'\r\n]+)/gm)]
        .flatMap((match) => match[1].toLowerCase().split(/\s+/));
    if (names.some((name) => ['debian', 'ubuntu'].includes(name))) return 'debian';
    if (names.some((name) => ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'].includes(name))) return 'fedora';
    if (names.includes('arch')) return 'arch';
    if (names.includes('alpine')) return 'alpine';
    if (names.some((name) => /suse/.test(name))) return 'suse';
    return '';
}

function installInstruction(family, packages) {
    const mapped = packages.map((name) => name === 'uidmap'
        ? ({ fedora: 'shadow-utils', arch: 'shadow', alpine: 'shadow-subids', suse: 'shadow' }[family] || name)
        : name);
    const list = [...new Set(mapped)].join(' ');
    const prefix = {
        debian: 'sudo apt-get update && sudo apt-get install',
        fedora: 'sudo dnf install',
        arch: 'sudo pacman -S',
        alpine: 'sudo apk add',
        suse: 'sudo zypper install',
    }[family];
    return prefix ? `Run: ${prefix} ${list}.` : `Install ${list} using your distribution's package manager; see ${INSTALL_DOCS}.`;
}

function executable(fsApi, filename) {
    try {
        if (!fsApi.statSync(filename).isFile()) return false;
        fsApi.accessSync(filename, fs.constants.X_OK);
        return true;
    } catch { return false; }
}

function onPath(fsApi, env, name) {
    return String(env.PATH || '').split(path.delimiter).filter(Boolean)
        .map((directory) => path.join(directory, name))
        .find((filename) => executable(fsApi, filename));
}

function supportedVersion(text) {
    const match = /^podman version (\d+)\.(\d+)(?:\.(\d+))?(?:[-+][\w.-]+)?\s*$/i.exec(text.trim());
    if (!match) return false;
    const [major, minor] = match.slice(1, 3).map(Number);
    return major > 5 || (major === 5 && minor >= 4);
}

function completeMapping(text) {
    const rows = text.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/));
    let next = 0;
    for (const row of rows) {
        if (row.length !== 3 || row.some((value) => !/^\d+$/.test(value))) return false;
        const [inside, outside, size] = row.map(Number);
        if (![inside, outside, size].every(Number.isSafeInteger) || size <= 0 || inside !== next) return false;
        next += size;
    }
    return next >= REQUIRED_MAPPED_IDS;
}

// This checks the native host only. Packages inside the immutable Box have
// their own image/entrypoint checks; macOS prerequisites live in Podman Machine.
export function assertLinuxHostPrerequisites({
    runner,
    platform = process.platform,
    env = process.env,
    fsApi = fs,
    uid = process.getuid?.(),
} = {}) {
    if (platform !== 'linux') return;
    const processRunner = runner || createProcessRunner({ env: buildEngineProcessEnvironment(env) });
    const family = distributionFamily(fsApi);
    const failures = [];
    const add = (requirement, reason, next) => failures.push({ requirement, reason, next });
    const probe = (command, args) => {
        try {
            return processRunner.query(command, args, { timeoutMs: PROBE_TIMEOUT_MS });
        } catch (error) {
            return { ok: false, error };
        }
    };
    const diagnostic = (result) => {
        const detail = sanitizeAuthorityDiagnostic(result?.stderr || '', { limit: 1_000 });
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(result?.error?.code || '') ? result.error.code : '';
        return [code, detail].filter(Boolean).join(': ') || `command failed (status ${result?.status ?? 'unknown'})`;
    };
    const finish = () => {
        if (!failures.length) return;
        throw new PloinkyBoxError(
            'Linux host prerequisites failed; Ploinky has not prepared or started the Box.\n'
            + failures.map(({ requirement, reason, next }) => `  ${requirement}: ${reason}\n    Next: ${next}`).join('\n')
            + '\nFix the reported prerequisites, then rerun your ploinky command as your normal login user.',
            { code: 'PLOINKY_BOX_HOST_PREREQUISITES_FAILED' },
        );
    };

    if (uid === 0) add('Rootless execution', 'Ploinky was launched as root.', 'Exit the root shell and run ploinky as a regular account, without sudo.');
    if (String(env.CONTAINER_HOST || env.PODMAN_HOST || '').trim()) {
        add('Native Podman', 'A remote Podman endpoint is configured.', 'Unset CONTAINER_HOST and PODMAN_HOST and select the local Linux Podman installation.');
        finish();
    }

    const version = probe('podman', ['--version']);
    if (!version.ok || !supportedVersion(String(version.stdout || ''))) {
        const observed = version.ok ? sanitizeAuthorityDiagnostic(String(version.stdout || '')) : diagnostic(version);
        add('Podman', `Version ${MINIMUM_HOST_PODMAN_VERSION} or newer is required (observed: ${observed || 'unknown'}).`,
            `${installInstruction(family, ['podman', 'catatonit'])} If your distribution supplies an older version, upgrade to a supported release or package source listed at ${INSTALL_DOCS}. Verify with: podman --version.`);
    }
    for (const [name, packages] of [['newuidmap', ['uidmap']], ['newgidmap', ['uidmap']]]) {
        if (!onPath(fsApi, env, name)) add(name, 'Executable was not found on PATH.', installInstruction(family, packages));
    }
    for (const [device, module] of [['/dev/fuse', 'fuse'], ['/dev/net/tun', 'tun']]) {
        try {
            if (!fsApi.statSync(device).isCharacterDevice()) throw new Error('not a character device');
            fsApi.accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
        } catch {
            add(device, 'A readable and writable character device is required for nested containers.',
                `Ask an administrator to load the module with sudo modprobe ${module} and grant your account device access through the distribution's udev/group policy. Reconnect after group changes.`);
        }
    }
    for (const filename of ['/proc/sys/user/max_user_namespaces', '/proc/sys/kernel/unprivileged_userns_clone']) {
        if (readText(fsApi, filename)?.trim() === '0') add('User namespaces', `${filename} disables unprivileged namespaces.`,
            `Ask an administrator to enable rootless Podman under the host's namespace/AppArmor policy; see ${ROOTLESS_DOCS}.`);
    }
    // Report independent missing packages/devices together, before querying an
    // engine that cannot work without its installed rootless prerequisites.
    finish();

    const result = probe('podman', ['info', '--format', 'json']);
    if (!result.ok) {
        add('Podman engine', diagnostic(result),
            `Run podman info as your normal login user. Check /etc/subuid and /etc/subgid, your user login session, and distribution namespace/AppArmor policy. ${ROOTLESS_DOCS}`);
        finish();
    }
    let info;
    try {
        if (String(result.stdout || '').length > 1_048_576) throw new Error('oversized');
        info = JSON.parse(result.stdout);
        if (!info?.host || typeof info.host !== 'object') throw new Error('missing host');
    } catch {
        add('Podman engine', 'podman info returned malformed or incomplete JSON.', 'Repair the Podman installation and verify podman info --format json succeeds.');
        finish();
    }
    const host = info.host;
    if (host.security?.rootless !== true) add('Rootless Podman', 'The selected engine is not rootless.', 'Use a regular login account and run podman info without sudo.');
    if (host.serviceIsRemote !== false || host.os !== 'linux') add('Native Podman', 'The selected engine is not a verified local Linux engine.', 'Select a native Linux Podman installation; remote connections are unsupported for this workspace.');
    if (host.security?.seccompEnabled !== true) add('Seccomp', 'Podman does not report seccomp support.', 'Install the distribution Podman and OCI runtime packages with seccomp support enabled.');
    // The Box runs nested Podman with cgroups disabled and sets no outer CPU
    // quota. Host cgroup versions and controller delegation are not prerequisites.

    const requireSelectedBinary = (label, selected, packages) => {
        if (typeof selected !== 'string' || !path.isAbsolute(selected) || !executable(fsApi, selected)) {
            add(label, 'The helper selected by podman info is missing or not executable.',
                `${installInstruction(family, packages)} Check the selected path and configuration with podman info.`);
        }
    };
    requireSelectedBinary('Container monitor', host.conmon?.path, ['conmon']);
    requireSelectedBinary('OCI runtime', host.ociRuntime?.path, ['crun']);
    if (host.networkBackend === 'netavark') requireSelectedBinary('Network backend', host.networkBackendInfo?.path, ['netavark']);
    const networkCommand = host.rootlessNetworkCmd;
    if (networkCommand === 'pasta' || networkCommand === 'slirp4netns') {
        const selected = host[networkCommand]?.executable;
        requireSelectedBinary(`Rootless network (${networkCommand})`, selected, [networkCommand === 'pasta' ? 'passt' : 'slirp4netns']);
    } else add('Rootless network', 'Podman did not report a supported rootless network helper.',
        `${installInstruction(family, ['passt'])} Configure [network] default_rootless_network_cmd="pasta" in containers.conf, then verify podman info.`);

    const mountProgram = info.store?.graphOptions?.['overlay.mount_program'];
    if (mountProgram) requireSelectedBinary('Overlay mount helper',
        typeof mountProgram === 'string' ? mountProgram : mountProgram.Executable, ['fuse-overlayfs']);

    if (host.security?.rootless === true && host.serviceIsRemote === false && host.os === 'linux') {
        for (const kind of ['uid', 'gid']) {
            const mapping = probe('podman', ['unshare', 'cat', `/proc/self/${kind}_map`]);
            if (!mapping.ok || !completeMapping(String(mapping.stdout || ''))) add(`Rootless ${kind.toUpperCase()} mapping`,
                mapping.ok ? `At least ${REQUIRED_MAPPED_IDS} contiguous container IDs starting at 0 are required.` : diagnostic(mapping),
                `Ask an administrator to allocate at least 65536 non-overlapping subordinate ${kind.toUpperCase()}s for your account in /etc/sub${kind}. Reconnect; if Podman already has a namespace, stop your containers and run podman system migrate before retrying. ${ROOTLESS_DOCS}`);
        }
    }
    finish();
}
