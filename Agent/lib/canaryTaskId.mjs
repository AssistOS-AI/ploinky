export const ROLLOUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Return the rollout ID from canary.<rolloutId>.<16 hex digits>, or null for other task IDs. */
export function parseCanaryTaskId(taskId) {
    if (typeof taskId !== 'string' || !taskId.startsWith('canary.')) return null;
    const separator = taskId.lastIndexOf('.');
    const rolloutId = taskId.slice('canary.'.length, separator);
    const nonce = taskId.slice(separator + 1);
    return ROLLOUT_ID_RE.test(rolloutId) && /^[a-f0-9]{16}$/.test(nonce) ? rolloutId : null;
}
