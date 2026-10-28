// Global-mode agents mount the workspace at its own path, so another agent (RoboTeam) can run a robot
// phase inside one of them through the private agent-exec route. The robot's coding agent runs in
// Bubblewrap with a private /proc, and the kernel refuses a new procfs in a user namespace while
// Podman's masked /proc paths (/proc/kcore, /proc/acpi, ...) hide parts of the container's procfs.
// These containers therefore run without those masks. Isolated agents keep the default masks.
export const PROC_UNMASK_LABEL = 'ploinky.procunmask';
const PROC_UNMASK_VALUE = 'proc-v1';

export function procUnmaskRequired({ runtime, runMode, descriptor } = {}) {
    if (runtime !== 'podman' || runMode !== 'global') return false;
    // A privileged container already has no masked paths.
    return descriptor?.containerSecurity?.privileged !== true;
}

export function procUnmaskArgs(options) {
    return procUnmaskRequired(options)
        ? ['--security-opt', 'unmask=/proc/*', '--label', `${PROC_UNMASK_LABEL}=${PROC_UNMASK_VALUE}`]
        : [];
}

// The recreate reason when a running container's masks differ from what its run mode requires.
export function procUnmaskReuseReason(options, currentLabel) {
    const wanted = procUnmaskRequired(options) ? PROC_UNMASK_VALUE : '';
    return String(currentLabel || '') === wanted ? '' : 'procUnmaskChanged';
}
