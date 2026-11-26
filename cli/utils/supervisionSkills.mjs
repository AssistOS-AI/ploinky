import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { SUPERVISION_ROLES, SUPERVISION_SKILL_NAME, supervisionRoleText } from './supervisionRoles.mjs';
import { syncManagedSkillExports } from './skills/exportTransaction.mjs';
import { createSkillExclusionPlanner } from './skills/exportExclusions.mjs';

function directory(parent, name) {
    const target = path.join(parent, name);
    try { fs.mkdirSync(target, { mode: 0o755 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(target).isDirectory()) throw new Error(`Skill directory is not a real directory: ${target}`);
    return target;
}

// Bundled sources may live outside the robot's mounts. Keep a versioned source
// inside the working folder, then publish relative links through Ploinky's
// ordinary export transaction, ledger, compatibility links and exclusions.
export function installSupervisionSkills(folder) {
    const root = fs.realpathSync(folder);
    const agents = directory(root, '.agents');
    const cache = directory(agents, '.supervised-skill-sources');
    const sources = SUPERVISION_ROLES.map(role => {
        const name = `${SUPERVISION_SKILL_NAME}-${role}`;
        const text = supervisionRoleText(role);
        const hash = crypto.createHash('sha256').update(text).digest('hex');
        const version = directory(cache, hash);
        const source = directory(version, name);
        const file = path.join(source, 'SKILL.md');
        try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o644 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== text) {
            throw new Error(`Bundled supervision skill source was modified: ${file}`);
        }
        return { name, path: source, source: { name: 'ploinky-supervised-sessions' } };
    });
    const result = syncManagedSkillExports({
        folder: root,
        owner: 'builtin:supervised-sessions',
        sources,
        claude: 'root-or-skills',
        authority: { kind: 'ploinky-cli', operation: 'skills-export' },
        exclusions: createSkillExclusionPlanner({ nonGitBlock: true,
            authorizeComposition: process.env.PLOINKY_SKILL_EXCLUDES_COMPOSE === '1' }),
    });
    for (const { name } of sources) {
        if (![...result.installed, ...result.unchanged].includes(name)) {
            const diagnostic = result.diagnostics.find(entry => entry.name === name);
            throw new Error(`Cannot install ${name}: ${diagnostic?.reason || 'skill export was not published'}. Existing files were preserved.`);
        }
    }
    return result;
}
