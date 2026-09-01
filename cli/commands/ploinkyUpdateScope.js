import fs from 'fs';
import path from 'path';

export const PLOINKY_UPDATED_WORKSPACE_CHECKOUT_ENV = 'PLOINKY_UPDATED_WORKSPACE_CHECKOUT';

function resolveExistingDirectory(directoryPath, label, {
    realpath = fs.realpathSync.native,
    statSync = fs.statSync,
} = {}) {
    const resolved = path.resolve(String(directoryPath || ''));
    let canonical;
    try {
        canonical = realpath(resolved);
    } catch (error) {
        throw new Error(`${label} does not exist or cannot be resolved: ${resolved}`, { cause: error });
    }
    let stat;
    try {
        stat = statSync(canonical);
    } catch (error) {
        throw new Error(`${label} cannot be inspected: ${canonical}`, { cause: error });
    }
    if (!stat.isDirectory()) {
        throw new Error(`${label} is not a directory: ${canonical}`);
    }
    return canonical;
}

export function pathContains(parentPath, candidatePath) {
    const relative = path.relative(parentPath, candidatePath);
    return relative === ''
        || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
}

export function resolvePloinkyUpdateScope(folderPath, {
    cwd = () => process.cwd(),
    realpath = fs.realpathSync.native,
    statSync = fs.statSync,
} = {}) {
    const explicit = typeof folderPath === 'string' ? folderPath.trim() : '';
    const selected = explicit && path.isAbsolute(explicit)
        ? explicit
        : path.resolve(cwd(), explicit);
    return resolveExistingDirectory(selected, 'Ploinky update folder', { realpath, statSync });
}

export function resolvePloinkyUpdateEligibility({
    repoPath,
    updateScopePath,
    realpath = fs.realpathSync.native,
    statSync = fs.statSync,
} = {}) {
    const scopeRoot = resolveExistingDirectory(
        updateScopePath,
        'Ploinky update folder',
        { realpath, statSync },
    );
    const checkoutRoot = resolveExistingDirectory(
        repoPath,
        'Ploinky checkout',
        { realpath, statSync },
    );
    const eligible = pathContains(scopeRoot, checkoutRoot)
        || pathContains(checkoutRoot, scopeRoot);
    return Object.freeze({
        eligible,
        scopeRoot,
        checkoutRoot,
        reason: eligible
            ? ''
            : `Ploinky checkout is outside the selected update folder ${scopeRoot}`,
    });
}
