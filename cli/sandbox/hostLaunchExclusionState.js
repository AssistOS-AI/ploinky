// Process-local record of the workspace lock (D4) held for a host-runtime
// launch. It has no dependencies so that the lease code can consult it
// cheaply. Lock order: the workspace start lease, then D4. Taking the lease
// while this process holds D4 for a launch would invert that order.

let held = null;

export function heldHostLaunchExclusion() {
    return held;
}

export function setHeldHostLaunchExclusion(value) {
    held = value;
}

export function assertHostLaunchLockOrder(operation) {
    if (!held) return;
    const error = new Error(
        `${operation} cannot be taken while this process holds the workspace lock for a host-runtime launch `
        + `(${held.label}); the workspace start lease must always be taken before that lock.`,
    );
    error.code = 'PLOINKY_BOX_LOCK_ORDER';
    throw error;
}
