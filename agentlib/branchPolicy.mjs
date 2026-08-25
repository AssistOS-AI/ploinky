// One `--branch` policy parser shared by the outer `ploinky` supervisor, core
// CLI code, and the AgentLib source selector.
//
// The outer path must select the AgentLib source before Box reconciliation, so
// it needs the same parse the inner lifecycle uses; a second parser here would
// let the two disagree about which branch a deployment actually requested.

export const BRANCH_FALLBACKS = Object.freeze(['default', 'fail']);

/**
 * @typedef {object} BranchPolicy
 * @property {string|null} branch - global branch requested for repos and AgentLib
 * @property {Record<string,string>} repoBranches - per-repo overrides
 * @property {'default'|'fail'} fallback
 * @property {boolean} resetRepos
 */

/** @returns {BranchPolicy} */
export function emptyBranchPolicy() {
    return { branch: null, repoBranches: {}, fallback: 'default', resetRepos: false };
}

function assignRepoBranch(policy, pair) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) {
        throw new Error(`Malformed --repo-branch value '${pair}'. Expected repo=branch.`);
    }
    policy.repoBranches[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
}

/**
 * Parse `--branch`, `--repo-branch`, `--branch-fallback`, and `--reset-repos`.
 *
 * @param {string[]} args
 * @returns {BranchPolicy}
 */
export function parseBranchPolicy(args) {
    const policy = emptyBranchPolicy();
    if (!Array.isArray(args) || !args.length) return policy;

    for (let i = 0; i < args.length; i += 1) {
        const arg = String(args[i] || '');

        if (arg === '--branch' && i + 1 < args.length) {
            policy.branch = String(args[++i]);
            continue;
        }
        if (arg.startsWith('--branch=')) {
            policy.branch = arg.slice('--branch='.length);
            continue;
        }

        if (arg === '--repo-branch' && i + 1 < args.length) {
            assignRepoBranch(policy, String(args[++i]));
            continue;
        }
        if (arg.startsWith('--repo-branch=')) {
            assignRepoBranch(policy, arg.slice('--repo-branch='.length));
            continue;
        }

        if (arg === '--branch-fallback' && i + 1 < args.length) {
            policy.fallback = String(args[++i]);
            continue;
        }
        if (arg.startsWith('--branch-fallback=')) {
            policy.fallback = arg.slice('--branch-fallback='.length);
            continue;
        }

        if (arg === '--reset-repos') {
            policy.resetRepos = true;
            continue;
        }
    }

    if (!BRANCH_FALLBACKS.includes(policy.fallback)) {
        throw new Error(`Invalid --branch-fallback value '${policy.fallback}'. Use 'default' or 'fail'.`);
    }
    return policy;
}

/**
 * Extract just the branch-policy tokens from a raw argument list, preserving
 * their two-argument form. Used by argument splitters that hand the policy on
 * to `parseBranchPolicy` unchanged.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function collectBranchPolicyArgs(args) {
    const collected = [];
    const list = (args || []).map((a) => String(a));
    for (let i = 0; i < list.length; i += 1) {
        const arg = list[i];
        if (arg === '--branch' || arg === '--repo-branch' || arg === '--branch-fallback') {
            collected.push(arg);
            if (i + 1 < list.length) collected.push(list[++i]);
            continue;
        }
        if (arg.startsWith('--branch=') || arg.startsWith('--repo-branch=') || arg.startsWith('--branch-fallback=')) {
            collected.push(arg);
            continue;
        }
        if (arg === '--reset-repos') collected.push(arg);
    }
    return collected;
}

/** Remove source/repository branch-policy tokens before command dispatch. */
export function stripBranchPolicyArgs(args) {
    const list = (args || []).map((value) => String(value));
    const stripped = [];
    for (let index = 0; index < list.length; index += 1) {
        const arg = list[index];
        if (arg === '--branch' || arg === '--repo-branch' || arg === '--branch-fallback') {
            index += 1;
            continue;
        }
        if (arg.startsWith('--branch=')
            || arg.startsWith('--repo-branch=')
            || arg.startsWith('--branch-fallback=')
            || arg === '--reset-repos') {
            continue;
        }
        stripped.push(arg);
    }
    return stripped;
}
