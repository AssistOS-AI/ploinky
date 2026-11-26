import fs from 'node:fs';
import path from 'node:path';

import { SUPERVISION_ROLES, supervisionRoleText } from './supervisionRoles.mjs';

// The two agents share a folder, so the task files and the role instructions
// live in one hidden directory inside it. `.ploinky` is masked from a terminal
// sandbox, and `.roboteam` is masked inside the working folder, so neither can
// carry them.
export const SUPERVISED_DIRECTORY = '.supervised';
export const SUPERVISION_FILES = Object.freeze({
    tasks: 'tasks.md',
    results: 'results.md',
    supervisor: 'supervisor.md',
    worker: 'worker.md',
});
const REVISION = /^rev:[ \t]*(\d{1,9})[ \t]*$/mu;

export function supervisedPaths(folder) {
    const directory = path.join(folder, SUPERVISED_DIRECTORY);
    return Object.freeze({
        directory,
        tasks: path.join(folder, SUPERVISION_FILES.tasks),
        results: path.join(folder, SUPERVISION_FILES.results),
        supervisor: path.join(directory, SUPERVISION_FILES.supervisor),
        worker: path.join(directory, SUPERVISION_FILES.worker),
    });
}

// The role files are generated from this command, so a stale copy is replaced
// on every session start; the task files are never created or touched here.
// They stay world readable: a terminal runs as its own container user, which may
// not be the user that runs this command.
// `roles` names the roles whose instructions this folder still has to carry: an
// agent whose CLI reads the role as a skill needs no file here.
export function prepareSupervisedFolder(folder, {
    roles = SUPERVISION_ROLES,
    roleText = supervisionRoleText,
    write = (file, value) => fs.writeFileSync(file, value, { mode: 0o644 }),
    mkdir = (directory, options) => fs.mkdirSync(directory, options),
} = {}) {
    const paths = supervisedPaths(folder);
    mkdir(paths.directory, { recursive: true, mode: 0o755 });
    for (const role of roles) write(paths[role], roleText(role));
    return paths;
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
