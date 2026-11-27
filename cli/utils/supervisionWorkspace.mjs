import path from 'node:path';

import { installSupervisionSkills } from './supervisionSkills.mjs';

// Role skills live under .agents/skills; tasks.md and results.md stay in the working folder.
export const SUPERVISED_DIRECTORY = '.agents/skills';
export const SUPERVISION_FILES = Object.freeze({
    tasks: 'tasks.md',
    results: 'results.md',
});

export function supervisedPaths(folder) {
    const directory = path.join(folder, SUPERVISED_DIRECTORY);
    return Object.freeze({
        directory,
        tasks: path.join(folder, SUPERVISION_FILES.tasks),
        results: path.join(folder, SUPERVISION_FILES.results),
        supervisor: path.join(directory, 'supervised-session-supervisor', 'SKILL.md'),
        worker: path.join(directory, 'supervised-session-worker', 'SKILL.md'),
    });
}

// Use the same transaction and ownership rules as other Ploinky skill exports.
export function prepareSupervisedFolder(folder) {
    installSupervisionSkills(folder);
    return supervisedPaths(folder);
}
