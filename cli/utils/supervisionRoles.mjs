import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// A supervised session is two coding agents in one folder that talk through two
// files. The role instructions ship with the command; every session copies them
// next to the task files, because a coding agent only reads what is inside the
// folder it works in.
export const SUPERVISION_ROLES = Object.freeze(['supervisor', 'worker']);
export const SUPERVISION_ROLE_LABELS = Object.freeze({ supervisor: 'Supervisor', worker: 'Worker' });

const ROLE_ROOT = new URL('../resources/supervised-sessions/', import.meta.url);

export function supervisionRoleText(role, { readFile = fs.readFileSync } = {}) {
    if (!SUPERVISION_ROLES.includes(role)) throw new Error(`Unknown supervision role: ${role}`);
    return readFile(fileURLToPath(new URL(`supervised-session-${role}/SKILL.md`, ROLE_ROOT)), 'utf8');
}

export const SUPERVISION_SKILL_NAME = 'supervised-session';

// The courier types this into the worker's terminal once per new revision.
export function taskDelivery(rev) {
    return `[supervisor] rev ${rev}: read ./tasks.md and implement revision ${rev}. `
        + `Run the checks it names and append your progress and final summary to ./results.md under rev ${rev}, `
        + 'then stop and wait for the next revision.';
}

// Sent at most once per open revision when the worker's terminal has been silent.
export function stallNudge(minutes) {
    return `[supervisor] worker terminal silent for ${minutes} minute${minutes === 1 ? '' : 's'}. `
        + 'Append one progress line now, or say exactly what is blocking you and stop.';
}

// This is native session configuration, never terminal input. The workflow stays in the installed skill.
export function supervisionSystemPrompt(role) {
    if (!SUPERVISION_ROLES.includes(role)) throw new Error(`Unknown supervision role: ${role}`);
    return `This session is the ${SUPERVISION_ROLE_LABELS[role]} of a supervised coding session. `
        + `Read and follow ./.agents/skills/supervised-session-${role}/SKILL.md for this session. `
        + 'Use only the skill for your assigned role; the other role belongs to the other session.';
}
