import fs from 'node:fs';
import path from 'node:path';

import { installSupervisionSkills } from './supervisionSkills.mjs';

// Role skills live under .agents/skills; tasks.md and results.md stay in the working folder.
export const SUPERVISED_DIRECTORY = '.agents/skills';
export const SUPERVISION_FILES = Object.freeze({
    tasks: 'tasks.md',
    results: 'results.md',
});
const REVISION = /^rev:[ \t]*(\d{1,9})[ \t]*$/mu;

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

export function parseTaskRevision(text) {
    const match = typeof text === 'string' ? text.match(REVISION) : null;
    return match ? Number(match[1]) : null;
}

// A missing task file is normal: the supervisor has not written it yet.
export function readTaskRevision(folder, { read = file => fs.readFileSync(file, 'utf8') } = {}) {
    let text;
    try {
        text = read(supervisedPaths(folder).tasks);
    } catch (error) {
        if (error?.code === 'ENOENT') return { rev: null, text: '', missing: true };
        throw error;
    }
    return { rev: parseTaskRevision(text), text, missing: false };
}
