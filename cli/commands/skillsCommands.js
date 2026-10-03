import * as skillsSvc from './skills.js';
import { withHeldOrAcquiredWorkspaceMutationLease } from '../utils/runtime/maintenanceLocks.js';

const USAGE = 'Usage: default-skills <repoName>';

function parseOptions(options = []) {
    const positional = [];
    const flags = { only: null, skip: null };
    for (let i = 0; i < options.length; i += 1) {
        const arg = options[i];
        if (arg === '--only' || arg === '--skip') {
            const value = options[i + 1];
            if (!value || String(value).startsWith('--')) {
                throw new Error(`Missing value for ${arg}. ${USAGE}`);
            }
            const list = String(value).split(',').map(s => s.trim()).filter(Boolean);
            flags[arg.slice(2)] = list;
            i += 1;
        } else if (typeof arg === 'string' && arg.startsWith('--')) {
            throw new Error(`Unknown flag '${arg}'. ${USAGE}`);
        } else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}

// Resolving, cloning and recording an absent source repository, then exporting
// from its checkout, is one workspace mutation. An update that already holds
// the lease reuses it; otherwise the command waits for its own lease.
export async function handleDefaultSkillsCommand(options = [], { workspaceLeaseWaitMs } = {}) {
    const { positional, flags } = parseOptions(options);
    const repoName = positional[0];
    if (!repoName) {
        throw new Error(USAGE);
    }

    const leaseOptions = workspaceLeaseWaitMs === undefined
        ? { operation: 'repositories-prepare' }
        : { operation: 'repositories-prepare', waitTimeoutMs: workspaceLeaseWaitMs };
    const result = await withHeldOrAcquiredWorkspaceMutationLease(leaseOptions,
        () => skillsSvc.installDefaultSkills(repoName, {
            only: flags.only,
            skip: flags.skip,
        }));

    console.log(`✓ Installed ${result.skills.length} skill(s) from '${result.repoName}' into ${result.destRoot}:`);
    console.log(`    - .agents/skills/  (${result.skills.join(', ')})`);
    if (result.claudeLink?.mode === 'skills') {
        console.log(`    - .claude/skills → ../.agents/skills (symlink; existing .claude preserved)`);
    } else {
        console.log(`    - .claude → .agents (symlink)`);
    }
    const exclusions = result.exclusions;
    if (result.gitignoreUpdated) {
        console.log('✓ Updated .gitignore (managed block; this folder is not in a Git worktree).');
    } else if (exclusions?.mode === 'git' && exclusions.status === 'published') {
        console.log('✓ Generated skill links are excluded through this worktree\'s private Git excludes file.');
    } else if (exclusions && ['unchanged'].includes(exclusions.status)) {
        console.log('  Local exclusions already up to date.');
    } else if (exclusions) {
        console.log(`  Local exclusions ${exclusions.status} (${exclusions.code}); see the warning above.`);
    }
    const retention = result.managedExport?.retention;
    if (retention?.retainedBytes) {
        const backups = Object.values(retention.backups).reduce((count, entry) => count + entry.count, 0);
        console.log(`  Retained ${backups} prior skill output backup(s) and ${retention.staging.retained.length} staging folder(s) (${retention.retainedBytes} bytes) under .agents; they are kept for manual review.`);
    }
}
