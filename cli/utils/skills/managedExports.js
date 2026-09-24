import { ensureRepositoryLink } from '../repositoryInstall.mjs';
import {
    syncManagedSkillExports as syncWithTransaction,
    skillTreeDigest,
    copyFreshSkillTree,
    EXPORT_LEDGER,
} from './exportTransaction.mjs';

export { skillTreeDigest, copyFreshSkillTree, EXPORT_LEDGER };

// Ploinky links validate the canonical destination inside the export root;
// the link text is computed for the final skills directory.
export function ploinkySkillLink(staged, target, root, skills) {
    ensureRepositoryLink(staged, target, root, { linkParent: skills });
}

/** Compatibility export only. Existing files are never adopted from names.
 * Retired trees stay outside the skill root, including for writes through old
 * open descriptors. Publication runs as one recoverable transaction under the
 * folder's export lock (see exportTransaction.mjs).
 */
export function syncManagedSkillExports(options) {
    return syncWithTransaction({ linker: ploinkySkillLink, ...options });
}
