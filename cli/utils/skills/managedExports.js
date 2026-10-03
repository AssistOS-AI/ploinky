import { ensureRepositoryLink } from '../repositoryInstall.mjs';
import {
    syncManagedSkillExports as syncWithTransaction,
    skillTreeDigest,
    EXPORT_LEDGER,
} from './exportTransaction.mjs';

export { skillTreeDigest, EXPORT_LEDGER };

// Ploinky links validate the canonical destination inside the export root;
// the link text is computed for the final skills directory.
export function ploinkySkillLink(staged, target, root, skills) {
    ensureRepositoryLink(staged, target, root, { linkParent: skills });
}

/** Exports skills as links. Existing files are never adopted from names and
 * replaced links are retained outside the skill root. Publication runs as one
 * recoverable transaction under the
 * folder's export lock (see exportTransaction.mjs).
 */
export function syncManagedSkillExports(options) {
    return syncWithTransaction({ linker: ploinkySkillLink, ...options });
}
