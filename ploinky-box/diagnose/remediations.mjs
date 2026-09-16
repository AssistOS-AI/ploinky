import { sanitizeAuthorityDiagnostic } from '../../cli/sandbox/authorityCommandDiagnostics.mjs';
import { MINIMUM_HOST_PODMAN_VERSION, supportedVersion } from '../hostPrerequisites.mjs';

const clean = (value) => sanitizeAuthorityDiagnostic(typeof value === 'string' ? value : '', { limit: 4_000 });
const command = (file, ...args) => ({ file, args });
const infoCommand = command('podman', 'info', '--format', 'json');

function manual(id, title, requiresSudo, instructions, commands) {
    return { id, title, mode: 'manual', requiresSudo, instructions, ...(commands ? { commands } : {}) };
}

function automatic(id, title, instructions) {
    return { id, title, mode: 'automatic', requiresSudo: false, instructions, repairId: id };
}

function inspectPath(name) {
    return manual(`select-${name}-on-path`, `Make the installed ${name} executable available on PATH`, false,
        `The lookup only established that ${name} was unavailable on the current PATH. Look for an existing trusted installation and correct your personal shell PATH, then reopen the shell and rerun diagnose. Package absence has not been established.`, [command('command', '-v', name)]);
}

function conditionalInstall(action) {
    return { ...action, optional: true, title: `${action.title} if no usable installation exists`,
        instructions: `Conditional alternative after PATH inspection: ${action.instructions}` };
}

function installAction(id, title, packages, context, platform) {
    const family = context?.packageFamily;
    const mapped = packages.map((name) => name === 'uidmap'
        ? ({ fedora: 'shadow-utils', arch: 'shadow', alpine: 'shadow-subids', suse: 'shadow' }[family] || name) : name);
    const prefix = { debian: ['apt-get', 'install'], fedora: ['dnf', 'install'], arch: ['pacman', '-S'], alpine: ['apk', 'add'], suse: ['zypper', 'install'] }[family];
    const install = platform === 'linux' && prefix ? command('sudo', ...prefix, ...mapped) : null;
    return manual(id, title, platform === 'linux' ? true : null,
        `Install or update ${packages.join(', ')} using supported distribution packages. Verify the selected executable and version afterwards. ${platform === 'linux' ? 'System package installation requires an administrator.' : 'Privileges depend on the selected installation method.'}`,
        install ? [install] : undefined);
}

const ACTIONS = {
    node: manual('select-supported-node', 'Select Node.js 22 or newer', false,
        'Install a supported Node.js release in your home directory and update your shell PATH. Reopen the shell and verify node --version; a system-wide install is not required.', [command('node', '--version')]),
    login: manual('use-login-user', 'Use the intended regular login account', false,
        'Exit the root shell and reconnect as the intended regular login account. Run Ploinky without sudo and do not borrow another account’s runtime directory.'),
    endpoint: manual('clear-remote-endpoint', 'Remove unsupported remote endpoint overrides', false,
        'Unset CONTAINER_HOST and PODMAN_HOST in your shell and remove those overrides from your personal shell configuration. Use native Podman on Linux or your selected Podman Machine on macOS.', [command('unset', 'CONTAINER_HOST', 'PODMAN_HOST')]),
    connection: manual('select-rootless-engine', 'Select the intended rootless Podman engine', false,
        'Inspect your Podman connections and select the intended rootless local engine or Podman Machine. Do not run Ploinky or Podman with sudo.', [command('podman', 'system', 'connection', 'list'), infoCommand]),
    machine: manual('inspect-podman-machine', 'Inspect the selected Podman Machine', false,
        'Inspect podman machine list and the default connection. Select your intended rootless Machine; only an existing stopped Machine with verified settings is eligible for automatic start.', [command('podman', 'machine', 'list'), command('podman', 'system', 'connection', 'list')]),
    helpers: manual('inspect-selected-helpers', 'Correct the selected Podman helper executables', null,
        'Inspect the helper paths reported by podman info. Selecting an already-installed executable in your personal containers.conf needs no sudo. Installing a missing system package or changing system configuration requires an administrator; the failed path check alone does not establish which repair is needed.', [infoCommand]),
    storage: manual('inspect-user-storage', 'Review the selected Podman storage configuration', false,
        'Inspect podman info and the selected personal containers/storage.conf. Correct only your own configuration after identifying the failing driver, graphroot, mount_program or force_mask setting. Preserve existing data; do not reset or prune the store or change its driver in place.', [infoCommand]),
    containerStorage: manual('inspect-container-storage', 'Review storage settings in the reported container', false,
        'Inspect the exact in-container Podman command and storage.conf path reported by this check. Temporary diagnostic stores use configuration generated from Ploinky and the Box image: correct that source/image configuration and rerun diagnostics. For an existing Box or agent store, review its own configuration through the owning account and preserve its data; do not reset the store or change its driver in place. Host security denials need separate administrator review.'),
    policy: manual('inspect-runtime-policy', 'Identify the exact namespace or mount denial', null,
        'Repeat the diagnostic as the same login user and inspect the failed command. Check helper paths, device access and the matching host security denial. A host AppArmor/SELinux or namespace-policy change requires an administrator; a denied probe alone does not prove which setting must change.'),
    apparmorInspect: manual('inspect-apparmor-loaded-policy', 'Inspect restricted AppArmor diagnostics if a probe is denied', true,
        'Optional administrator inspection: use aa-status and journalctl -k to identify the exact loaded profile and denied path. Unreadable profile or audit information alone does not prevent deployment. Keep profiles enforced.', [command('sudo', 'aa-status'), command('sudo', 'journalctl', '-k')]),
    pastaPolicy: manual('review-pasta-policy', 'Review pasta network namespace permissions', true,
        'Ask an administrator to confirm the matching AppArmor denial. If needed, add @{run}/netns/ r, and @{run}/netns/netns-* r, to the pasta profile, validate it, and reload only that profile. Missing source rules alone do not prove a failure; alternate effective rules may grant access. Keep the profile enforced.'),
    fusePolicy: manual('review-fusermount-policy', 'Review fusermount3 overlay cleanup permissions', true,
        'Ask an administrator to confirm the matching AppArmor denial. If needed, add umount /data/podman/storage/overlay/*/merged/, to the fusermount3 profile, validate it, and reload only that profile. Missing source rules alone do not prove a failure. Keep the profile enforced.'),
    namespacePolicy: manual('enable-host-user-namespaces', 'Enable supported rootless user namespaces', true,
        'Ask an administrator to enable rootless Podman under the host namespace and security policy. Inspect the reported zero-valued namespace sysctl and choose an appropriate enabled value; do not disable AppArmor or other confinement.'),
    ports: manual('select-available-ports', 'Select available publication ports', false,
        'Inspect the listeners and choose free --port and --udp-port values, then rerun diagnose with the same options. Stop only a conflicting service you own and intend to stop; repair never terminates listeners.', [command('ss', '-ltnu')]),
    session: manual('restore-login-session', 'Use this account’s login session and runtime directory', false,
        'Reconnect through a real login session for this account and inspect its XDG_RUNTIME_DIR and Podman cgroup settings. Do not borrow another user’s runtime directory or change host cgroup policy solely because a probe failed.', [infoCommand]),
    space: manual('free-owned-disk-space', 'Free space in the affected user storage', false,
        'Inspect free space and remove only files or test resources you own and no longer need. Preserve workspace data and other containers. If the cause is an administrator-imposed quota, ask its owner to review the quota separately.', [command('df', '-h')]),
    registry: manual('restore-registry-access', 'Restore registry connectivity or authentication', false,
        'Check your DNS, proxy and user CA configuration, then retry the registry operation. For a private registry, use podman login with an interactive prompt or credential store; never put credentials in diagnostic output. A host-wide network or trust-policy change needs separate administrator review.'),
    image: manual('restore-supported-box-image', 'Restore the supported Box image and source contract', false,
        'Verify the configured Box image, immutable identity and Ploinky source revision. Use a compatible published image or rebuild the image from the supported source; do not modify running containers or relax isolation.', [command('podman', 'images')]),
    cleanup: manual('inspect-owned-diagnostic-cleanup', 'Inspect retained diagnostic resources', null,
        'Inspect only the temporary resource named in the failed check and prove its ownership before removing it. Do not prune, reset storage, or remove a similarly named workspace. Permission or policy repairs may need an administrator; ownership ambiguity must be resolved first.'),
    graph: manual('inspect-application-state', 'Inspect the current application deployment', false,
        'Inspect the named agent and its startup logs. Correct its application configuration or run the intended Ploinky start command when ready; repair does not restart agents or infer application health.', [command('ploinky', 'logs', 'last')]),
};

function bindingAction(check) {
    if (check.repairEligible === true && check.code === 'BINDING_SHARED_READ') {
        return automatic('secure-binding-permissions', 'Restrict private router binding metadata permissions',
            'Run ploinky repair to remove extra read/traverse permissions from verified, user-owned binding metadata. It rechecks ownership, file identity and safety before changing permissions.');
    }
    if (check.code === 'BINDING_FOREIGN_OWNER') return manual('repair-binding-owner', 'Correct foreign-owned binding metadata', true,
        'Ask an administrator to inspect the exact binding metadata path and restore its intended ownership. Do not recursively change ownership of unrelated state.');
    if (['BINDING_SHARED_WRITE', 'BINDING_INVALID_RECORD'].includes(check.code)) return manual('review-binding-record', 'Review untrusted or invalid router binding metadata', false,
        'Review the named record and its intended mapping as its owner. A shared-writable or invalid record is not trusted and cannot be automatically repaired. Preserve evidence and restore the intended binding using ploinky bind only after resolving its provenance.');
    return manual('inspect-binding-metadata', 'Inspect unsafe or unreadable router binding metadata', null,
        'Inspect the exact path and ownership reported by the check. Resolve symlinks, unreadable paths or changed identities before retrying. Repair will not follow unsafe paths or guess ownership; administrator help depends on what the inspection finds.');
}

function errorAction(check, report, context) {
    const detail = String(check.detail || '');
    const inside = insideContainer(check.id);
    if (/\b(?:crun|runc|OCI runtime)\b[\s\S]*\b(?:unknown|unsupported) version(?: specified)?\b/i.test(detail)) {
        return inside ? ACTIONS.image : installAction('update-oci-runtime', 'Update the selected OCI runtime to a compatible release', ['crun'], context, report.platform);
    }
    if (/(?:apparmor|SELinux)[\s\S]*(?:denied|not permitted)|(?:denied|not permitted)[\s\S]*apparmor|\bavc:\s*denied/i.test(detail)) {
        if (/apparmor/i.test(detail) && /pasta|\/run\/netns\//i.test(detail)) return ACTIONS.pastaPolicy;
        if (/apparmor/i.test(detail) && /fusermount3|umount[\s\S]*\/data\/podman\/storage\/overlay\//i.test(detail)) return ACTIONS.fusePolicy;
        return manual('review-host-security-policy', 'Review the reported host security denial', true,
            'Ask an administrator to inspect the matching AppArmor or SELinux denial and adjust only the required operation and path after validating the runtime contract. Keep confinement enforced.');
    }
    if (/network namespace[\s\S]*permission denied|(?:mount|unmount|fusermount|fuse-overlayfs|user namespace|cannot clone|uid_map|gid_map|newuidmap|newgidmap)[\s\S]*(?:denied|not permitted|failed)/i.test(detail)) return ACTIONS.policy;
    if (/TCP.*already in use|UDP.*already in use|EADDRINUSE/i.test(detail)) return ACTIONS.ports;
    if (/systemd|cgroup|dbus|XDG_RUNTIME_DIR/i.test(detail)) return ACTIONS.session;
    if (/no space|ENOSPC|disk quota/i.test(detail)) return ACTIONS.space;
    if (/mkdir.*(?:shared|code).*not permitted|overlay|storage driver|graphroot|force_mask/i.test(detail)) return inside ? ACTIONS.containerStorage : ACTIONS.storage;
    if (/unauthorized|authentication required|denied.*requested access|TLS|certificate|ENOTFOUND|DNS|resolve host|registry|connection (?:refused|reset)|timed out/i.test(detail)) return ACTIONS.registry;
    return null;
}

function insideContainer(id) {
    return /^(?:inner|nested-engine)\./.test(id) || id === 'workspace.storage' || /^current\.agent\.[0-9]+\.podman$/.test(id);
}

function classify(check, report, context) {
    const id = check.id;
    if (id === 'repair.lock' || id === 'repair.lock.release' || id.startsWith('repair.execution.')) {
        return manual(`review-${id}`, `Resolve ${clean(check.label || id)}`, null,
            clean(check.next) || 'Inspect this failed repair operation and its recorded error before rerunning repair. Verify ownership and the exact affected resource first; no automatic retry or privilege requirement can be inferred from this execution failure alone.');
    }
    if (id === 'repair.binding.permissions') return bindingAction(check);
    if (id === 'repair.machine.state') return check.code === 'MACHINE_STOPPED_ELIGIBLE' && check.repairEligible === true
        ? automatic('start-podman-machine', 'Start the verified stopped Podman Machine',
            'Run ploinky repair to start only the existing selected rootless Machine after revalidating its identity and settings. It does not create or reconfigure a Machine.') : ACTIONS.machine;
    if (id === 'repair.image.cache') return check.code === 'IMAGE_CACHE_MISSING' && check.repairEligible === true
        ? automatic('pull-box-image', 'Pull the configured missing Box image',
            'Run ploinky repair to pull only the configured registry image after verifying it is still absent and the intended engine is usable. It does not replace an existing image or change registry credentials.') : ACTIONS.image;
    if (id === 'image.pull' && check.status === 'fail') {
        const cause = errorAction(check, report, context);
        return [automatic('pull-box-image', 'Retry the configured Box image pull',
            'Run ploinky repair to retry pulling the configured image only if it remains absent and the intended engine is usable. It does not replace an existing image or change registry credentials.'), ...(cause ? [cause] : [])];
    }
    if (['host.node.runtime', 'host.node.path'].includes(id)) return ACTIONS.node;
    if (id === 'host.user') return ACTIONS.login;
    if (id === 'host.endpoint') return ACTIONS.endpoint;
    if (id === 'host.platform') return manual('select-supported-platform', 'Use a supported Ploinky host environment', false,
        'Run Ploinky from a regular Linux login account with native rootless Podman, or macOS with Podman Machine. Provisioning a new host is separate from repair.');
    if (['host.podman.native', 'host.podman.rootless'].includes(id)) return ACTIONS.connection;
    if (['host.machine', 'host.machine.state'].includes(id)) return ACTIONS.machine;
    if (id === 'host.podman.version') {
        const install = installAction('install-host-podman', 'Install a supported Podman release', ['podman', 'catatonit'], context, report.platform);
        if (/\bENOENT\b|command not found|not found on PATH/i.test(check.detail || '')) return [inspectPath('podman'), conditionalInstall(install)];
        const version = /\bpodman version (\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)(?:;|\s|$)/i.exec(check.detail || '');
        if (check.exitCode === 0 && version && !supportedVersion(`podman version ${version[1]}`)) {
            return { ...install, instructions: `The selected executable reported Podman ${version[1]}; Ploinky requires ${MINIMUM_HOST_PODMAN_VERSION} or newer. ${install.instructions}` };
        }
        return manual('inspect-podman-version-command', 'Inspect the failed Podman version command', null,
            'Run the recorded podman --version command as the same login user and inspect the execution error or unexpected output. The probe did not establish a supported version or prove package absence. Check PATH and executable access before deciding whether system installation needs administrator help.', [command('podman', '--version')]);
    }
    if (['host.helper.newuidmap', 'host.helper.newgidmap'].includes(id)) return [
        inspectPath(id.split('.').at(-1)),
        conditionalInstall(installAction('install-uidmap', 'Install subordinate-ID mapping helpers', ['uidmap'], context, report.platform)),
    ];
    if (id === 'host.seccomp') return installAction('install-seccomp-runtime', 'Install a Podman runtime with seccomp support', ['podman', 'crun'], context, report.platform);
    if (id.startsWith('host.helper.')) return ACTIONS.helpers;
    if (['host.device.fuse', 'host.device.tun'].includes(id)) {
        const module = id.endsWith('.fuse') ? 'fuse' : 'tun';
        return manual(`enable-device-${module}`, `Enable the host ${module} device for rootless containers`, true,
            `Ask an administrator to load the ${module} kernel module if absent and grant access through the host udev/group policy. Reconnect after group changes. Do not use blanket world-writable permissions.`, [command('sudo', 'modprobe', module)]);
    }
    if (['host.sysctl.max_user_namespaces', 'host.sysctl.unprivileged_userns_clone'].includes(id)) return ACTIONS.namespacePolicy;
    if (['host.apparmor', 'host.apparmor.loaded'].includes(id)) return { ...ACTIONS.apparmorInspect, optional: true };
    if (id === 'host.apparmor.pasta') return ACTIONS.pastaPolicy;
    if (id === 'host.apparmor.fusermount') return ACTIONS.fusePolicy;
    if (['host.mapping.uid', 'host.mapping.gid'].includes(id) && check.exitCode === 0) {
        const kind = id.endsWith('.uid') ? 'uid' : 'gid';
        return manual(`allocate-subordinate-${kind}s`, `Allocate a valid subordinate ${kind.toUpperCase()} range`, true,
            `The mapping command succeeded but its output did not meet the required range. Ask an administrator to allocate at least 65536 non-overlapping subordinate ${kind.toUpperCase()}s for your account in /etc/sub${kind}. Reconnect; if Podman already owns a namespace, plan stopping your own containers before podman system migrate. Repair never rewrites ID allocations.`);
    }
    const category = errorAction(check, report, context);
    if (category) return category;
    if (['host.mapping.uid', 'host.mapping.gid'].includes(id)) return manual('inspect-subordinate-mapping-probe', 'Inspect the failed rootless mapping probe', null,
        'Rerun the reported podman unshare command in this account’s login session. Failed execution does not prove that subordinate IDs are missing. Check the reported helper, namespace and policy error before choosing a user configuration change or administrator repair.');
    if (['host.storage', 'host.storage.vfs'].includes(id)) return ACTIONS.storage;
    if (id === 'workspace.storage' || /^(?:inner|nested-engine)\.podman-settings$/.test(id)) return ACTIONS.containerStorage;
    if (/^(?:inner|nested-engine)\.(?:tool-|image-reference|identity$|uid-mapping|gid-mapping)/.test(id) || ['image.contract', 'image.agentlib'].includes(id)) return ACTIONS.image;
    if (/^(?:inner|nested-engine)\.device-/.test(id)) return ACTIONS.policy;
    if (/^cleanup\.|^(?:inner|nested-engine)\.(?:agent-remove|engine-remove|data-cleanup|scratch-cleanup)/.test(id)) return ACTIONS.cleanup;
    if (/^current\.(?:graph|agent\.)/.test(id)) return /\.podman$/.test(id) ? ACTIONS.containerStorage : ACTIONS.graph;
    return manual(`inspect-${id}`, `Inspect ${clean(check.label || id)}`, null,
        'Inspect the failed check and its recorded command as the same login user. The available evidence does not establish a safe repair or the required privileges. Correct the identified cause and rerun ploinky diagnose; repair does not execute diagnostic hints.');
}

function childrenFor(check, checks) {
    const filter = check.id === 'runtime.probes' ? (id) => /^(?:image\.|box\.|inner\.|nested-engine\.|cleanup\.)/.test(id)
        : check.id === 'box.inner' ? (id) => /^(?:inner|nested-engine)\./.test(id)
            : check.id === 'inner.engine-exec' ? (id) => id.startsWith('nested-engine.')
                : check.id === 'current.graph' ? (id) => /^current\.agent\./.test(id)
                    : check.id === 'host.machine.state' ? (id) => id === 'repair.machine.state'
                    : null;
    return filter ? checks.filter((candidate) => candidate.id !== check.id && candidate.status === 'fail' && filter(candidate.id)) : [];
}

/** Build actions from the diagnostic catalog; report-supplied actions are never trusted. */
export function annotateRemediations(report, { context = {} } = {}) {
    const checks = (report.checks || []).map(({ actionIds, ...check }) => ({ ...check }));
    const byId = new Map();
    const summaries = [];
    for (const check of checks) {
        if (!['fail', 'warn'].includes(check.status)) continue;
        const children = childrenFor(check, checks);
        if (children.length) { summaries.push({ check, children }); continue; }
        const classified = classify(check, report, context);
        check.actionIds = [];
        for (const definition of Array.isArray(classified) ? classified : [classified]) {
            const { optional, ...fields } = definition;
            const existing = byId.get(fields.id);
            if (existing) {
                existing.required ||= check.status === 'fail' && !optional;
                if (!existing.checkIds.includes(check.id)) existing.checkIds.push(check.id);
            } else byId.set(fields.id, { ...fields, required: check.status === 'fail' && !optional, checkIds: [check.id] });
            check.actionIds.push(fields.id);
        }
    }
    // Inner summaries may themselves be children of an outer summary.
    for (const { check, children } of summaries.reverse()) {
        check.actionIds = [...new Set(children.flatMap((child) => child.actionIds || []))];
        for (const id of check.actionIds) {
            const action = byId.get(id);
            if (!action.checkIds.includes(check.id)) action.checkIds.push(check.id);
        }
    }
    return { ...report, checks, actions: [...byId.values()] };
}

function displayCommand(value) {
    if (typeof value?.file !== 'string' || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) return '';
    const quote = (argument) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
    return clean([value.file, ...value.args].map((part) => quote(clean(part))).join(' '));
}

/** Distinguish required administrator repairs from optional privileged inspection. */
export function formatRemediationActions(actions, { remaining = false } = {}) {
    const list = Array.isArray(actions) ? actions : [];
    const lines = [remaining ? 'Remaining actions' : 'Remediation actions'];
    if (!list.length) return `${lines[0]}: none.\n`;
    const groups = [
        ['Automatic actions (no sudo)', (action) => action.mode === 'automatic'],
        ['Required administrator actions', (action) => action.mode !== 'automatic' && action.requiresSudo === true && action.required],
        ['Manual actions (no sudo)', (action) => action.mode !== 'automatic' && action.requiresSudo === false],
        ['Manual actions (privilege undetermined)', (action) => action.mode !== 'automatic' && action.requiresSudo !== true && action.requiresSudo !== false],
        ['Optional administrator diagnostics or conditional policy review', (action) => action.mode !== 'automatic' && action.requiresSudo === true && !action.required],
    ];
    for (const [title, matches] of groups) {
        const selected = list.filter(matches);
        if (!selected.length) continue;
        lines.push(`\n${title}:`);
        for (const action of selected) {
            const label = action.mode === 'automatic' ? 'AUTO (no sudo)' : action.requiresSudo === true ? 'SUDO REQUIRED'
                : action.requiresSudo === false ? 'MANUAL (no sudo)' : 'MANUAL (privilege undetermined)';
            lines.push(`[${label}] ${clean(action.title)}${action.required ? '' : ' (optional)'}`);
            lines.push(`  ${clean(action.instructions)}`);
            for (const entry of action.commands || []) {
                const rendered = displayCommand(entry);
                if (rendered) lines.push(`  Command: ${rendered}`);
            }
        }
    }
    if (list.some((action) => action.mode === 'automatic')) lines.push('\nRun ploinky repair as your regular user to apply eligible automatic actions.');
    if (list.some((action) => action.requiresSudo === true && action.required)) lines.push('The required administrator actions above remain deployment blockers; ploinky repair never invokes sudo.');
    return `${lines.join('\n')}\n`;
}
