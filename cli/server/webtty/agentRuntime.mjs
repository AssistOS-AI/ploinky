const CONTAINER_ID = /^[a-f0-9]{64}$/;
const EXEC_ID = /^[a-f0-9]{64}$/;
const MARKER = /^[A-Za-z0-9_-]{24,128}$/;
const AGENT_SHELL_MARKER_PREFIX = 'ploinky-webtty-marker:';

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function exactPodmanInspectAbsent(result, containerId) {
    if (!CONTAINER_ID.test(String(containerId || ''))) return false;
    if (!result || result.status !== 125 || result.signal || result.errorCode) return false;
    const stdout = String(result.stdout || '').trim();
    if (stdout !== '' && stdout !== '[]') return false;
    const exactId = escapeRegExp(containerId);
    return new RegExp(
        `^(?:error:\\s*)?(?:no container with name or id ["']?${exactId}["']? found|no such container:?\\s+["']?${exactId}["']?|container ["']?${exactId}["']? does not exist)\\.?$`,
        'i',
    ).test(String(result.stderr || '').trim());
}

export function parseExactPodmanInspectEnvelope(output, containerId, errorFactory = Error) {
    if (!CONTAINER_ID.test(String(containerId || ''))) throw new errorFactory('container-id');
    let records;
    try { records = JSON.parse(String(output || '')); } catch (_) { throw new errorFactory('inspect-json'); }
    if (!Array.isArray(records) || records.length !== 1 || records[0]?.Id !== containerId) {
        throw new errorFactory('inspect-identity');
    }
    return records[0];
}

export function projectExactAgentProcessTarget(record, containerId, errorFactory = Error) {
    if (!record || record.Id !== containerId) throw new errorFactory('inspect-identity');
    const execIds = Array.isArray(record.ExecIDs) ? record.ExecIDs.map(String) : [];
    if (execIds.length > 256 || execIds.some((value) => !EXEC_ID.test(value))) {
        throw new errorFactory('exec-identity');
    }
    const running = record.State?.Running === true;
    const initPid = Number(record.State?.Pid || 0);
    if (running && (!Number.isSafeInteger(initPid) || initPid <= 1)) {
        throw new errorFactory('container-init');
    }
    return Object.freeze({
        absent: false,
        id: containerId,
        running,
        initPid,
        execIds: Object.freeze(execIds),
    });
}

// Podman itself returns 126/127 when the selected outer /bin/bash cannot be
// executed.  Never let target-controlled behavior inside the admitted Bash
// session reproduce those fallback-authorizing statuses.
const BASH_WRAPPER = '/bin/bash --noprofile --norc; ploinky_webtty_status=$?; case "$ploinky_webtty_status" in 126|127) exit 124 ;; *) exit "$ploinky_webtty_status" ;; esac';
const SH_WRAPPER = '/bin/sh -i; ploinky_webtty_status=$?; exit "$ploinky_webtty_status"';
const SHELLS = Object.freeze({
    '/bin/bash': Object.freeze({
        wrapper: Object.freeze(['--noprofile', '--norc', '-p', '-c', BASH_WRAPPER]),
        interactive: Object.freeze(['/bin/bash', '--noprofile', '--norc']),
    }),
    '/bin/sh': Object.freeze({
        wrapper: Object.freeze(['-p', '-c', SH_WRAPPER]),
        interactive: Object.freeze(['/bin/sh', '-i']),
    }),
});

export function agentShellMarkerArgument(marker) {
    if (!MARKER.test(String(marker || ''))) throw new Error('agent marker is invalid');
    return `${AGENT_SHELL_MARKER_PREFIX}${marker}`;
}

export function fixedAgentShellWrapperArgv(marker, shellPath = '/bin/bash') {
    const shell = SHELLS[shellPath];
    if (!shell) throw new Error('fixed shell path is invalid');
    return Object.freeze([
        shellPath,
        ...shell.wrapper,
        agentShellMarkerArgument(marker),
    ]);
}

export function fixedAgentInteractiveShellArgv(shellPath = '/bin/bash') {
    const shell = SHELLS[shellPath];
    if (!shell) throw new Error('fixed shell path is invalid');
    return shell.interactive;
}

export function fixedAgentPodmanArgv(spec, shellPath = '/bin/bash') {
    return Object.freeze([
        'container',
        'exec',
        '--interactive',
        '--tty',
        '--user',
        spec.targetUser,
        '--workdir',
        spec.translatedCwd,
        '--env',
        'TERM=xterm-256color',
        '--env',
        `PLOINKY_WEBTTY_MARKER=${spec.marker}`,
        spec.containerId,
        ...fixedAgentShellWrapperArgv(spec.marker, shellPath),
    ]);
}

export function bashExecutableLookupFailed(output, exitEvent) {
    return [126, 127].includes(exitEvent?.exitCode)
        && /(?:executable file ['"]?\/bin\/bash['"]?.*not found|stat .*\/bin\/bash.*no such file|\/bin\/bash.*(?:not found|no such file))/i
            .test(String(output || '').slice(-16 * 1024));
}
