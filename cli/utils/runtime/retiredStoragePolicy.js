// Reject retired declarations before admission or resource planning. Silently
// ignoring them would redirect writes into an unmounted container directory.
export function assertNoRetiredStorage(manifest) {
    const resources = manifest?.runtime?.resources;
    if (!resources || typeof resources !== 'object') return;
    const removedField = Object.hasOwn(resources, 'persistentStorage');
    const removedTemplate = Object.values(resources.env || {}).some(value =>
        typeof value === 'string' && /\{\{\s*STORAGE_(?:CONTAINER|HOST)_PATH\s*\}\}/.test(value));
    if (removedField || removedTemplate) {
        const error = new Error(
            'runtime.resources.persistentStorage and STORAGE_*_PATH templates have been removed. '
            + 'Use the automatic persistent home at /root, or explicit manifest volumes for additional mounts.'
        );
        error.code = 'PLOINKY_REMOVED_PERSISTENT_STORAGE';
        throw error;
    }
}
