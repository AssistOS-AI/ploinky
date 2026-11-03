import { normalizeImageId } from '../contract/image-id.mjs';

// The in-transaction Box image tag refresh (`ploinky update`, registry digest not provable): pull the tag
// under the workspace lock, validate it, and replace the Box only when the tag now names another image.

/** Refuses a combination of refresh options that cannot be honoured, before any mutation. */
export function assertImageRefreshOptions({
    replaceImage, refreshImageTag, imagePolicy, allowReplacement, requireExistingContainerId,
}, fail) {
    if (replaceImage !== true && refreshImageTag !== true) return;
    if (replaceImage === true && refreshImageTag === true) {
        throw fail('replaceImage and refreshImageTag cannot be combined');
    }
    if (imagePolicy === 'preserve') throw fail('An image refresh cannot use the preserve image policy');
    if (allowReplacement !== true) throw fail('An image refresh requires a command that may replace the Box');
    if (requireExistingContainerId !== null) throw fail('An image refresh cannot target a required existing Box');
}

const reasonOf = (error) => String(error?.message || error).slice(0, 500);

/**
 * @returns {Promise<null | { outcome: 'pull-failed'|'invalid'|'current'|'pending-agentlib'|'replace',
 *   beforeId: string, afterId?: string, reason?: string, image?: object }>}
 */
export async function refreshBoxImageTag({
    dependencies, engine, imageRef, old, desiredAgentLib, runner, stdout, stderr,
}) {
    const beforeId = normalizeImageId(old.imageId);
    try {
        await dependencies.pullImage(engine, imageRef, runner, { stdout, stderr });
    } catch (error) {
        return { outcome: 'pull-failed', beforeId, reason: reasonOf(error) };
    }
    let pulled;
    try {
        pulled = dependencies.validateImage(engine.name, imageRef, runner);
    } catch (error) {
        return { outcome: 'invalid', beforeId, reason: reasonOf(error) };
    }
    const afterId = normalizeImageId(pulled.immutableId);
    if (afterId === beforeId) return { outcome: 'current', beforeId, afterId, image: pulled };
    // The AgentLib was selected from the pre-pull local tag: keep the Box, the next start applies the new tag.
    if (desiredAgentLib.mode === 'image' && desiredAgentLib.supplyingImageId !== afterId) {
        return { outcome: 'pending-agentlib', beforeId, afterId };
    }
    return { outcome: 'replace', beforeId, afterId, image: pulled };
}

/** The public form of a refresh result: no image object. */
export function imageRefreshResult(imageRefresh) {
    if (!imageRefresh) return null;
    return Object.freeze({
        outcome: imageRefresh.outcome,
        beforeId: imageRefresh.beforeId,
        afterId: imageRefresh.afterId || null,
        reason: imageRefresh.reason || '',
    });
}
