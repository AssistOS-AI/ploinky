import { assessGeneratedIgnoreState } from '../skills/exportExclusions.mjs';

// Default generated-state assessment for every verified Git update (P4).
// Runs under the checkout lock before dirty classification. A `.gitignore`
// Ploinky block is restored only with an exact write receipt; anything else
// (a user edit, or a write interrupted before its receipt) is preserved and
// reported with the assessor's code (for example
// `unverified-ignore-block-preserved`).
export function assessGeneratedCheckoutState({ repoPath }) {
    return assessGeneratedIgnoreState({ repoPath });
}
