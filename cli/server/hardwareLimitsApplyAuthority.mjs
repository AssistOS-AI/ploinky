import { isDeepStrictEqual } from 'node:util';
import { selectionIdentity } from '../sandbox/edgeSelectionMutations.mjs';

export function createHardwareApplyAuthority({ readSelection, verifyInitial = () => true } = {}) {
    if (verifyInitial() !== true) throw Object.assign(new Error('The routing authority changed before Apply.'), { code: 'identity_changed', status: 409 });
    const initial = readSelection();
    if (verifyInitial() !== true) throw Object.assign(new Error('The routing authority changed while capturing Apply.'), { code: 'identity_changed', status: 409 });
    const selectorFile = initial?.paths?.activeSelectorFile;
    if (typeof selectorFile !== 'string' || !selectorFile) throw new Error('Apply requires a selected routing identity.');
    let expected = selectionIdentity(initial.selector);
    let valid = expected?.state === 'active';
    return Object.freeze({
        accept(receipt) {
            // No arbitrary rebasing: every operation-owned transition must
            // extend the exact prior selection on this workspace's one file.
            try {
                const before = selectionIdentity(receipt?.before);
                const after = selectionIdentity(receipt?.after);
                if (!valid || receipt.selectorFile !== selectorFile || !isDeepStrictEqual(before, expected) || !after) {
                    valid = false;
                    return false;
                }
                expected = after;
                return true;
            } catch (_) { valid = false; return false; }
        },
        isCurrent() {
            try {
                const current = readSelection();
                return valid && current?.paths?.activeSelectorFile === selectorFile && isDeepStrictEqual(selectionIdentity(current.selector), expected);
            } catch (_) { return false; }
        },
    });
}
