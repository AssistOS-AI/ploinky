import * as skillsSvc from './skills.js';

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

export function handleDefaultSkillsCommand(options = []) {
    const { positional, flags } = parseOptions(options);
    const repoName = positional[0];
    if (!repoName) {
        throw new Error(USAGE);
    }

    const result = skillsSvc.installDefaultSkills(repoName, {
        only: flags.only,
        skip: flags.skip,
    });

    console.log(`✓ Installed ${result.skills.length} skill(s) from '${result.repoName}' into ${result.destRoot}:`);
    console.log(`    - .agents/skills/  (${result.skills.join(', ')})`);
    if (result.claudeLink?.mode === 'skills') {
        console.log(`    - .claude/skills → ../.agents/skills (symlink; existing .claude preserved)`);
    } else {
        console.log(`    - .claude → .agents (symlink)`);
    }
    if (result.gitignoreUpdated) {
        console.log('✓ Updated .gitignore (marker block).');
    } else {
        console.log('  .gitignore already up to date.');
    }
}
