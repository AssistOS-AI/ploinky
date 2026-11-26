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
    return readFile(fileURLToPath(new URL(`${role}.md`, ROLE_ROOT)), 'utf8');
}

// The first message of each role only points at its own instructions; the
// protocol itself stays in the file so an agent can re-read it after a
// compaction.
export function supervisionIntro(role, { folder = '.', peerAgent = '' } = {}) {
    const other = role === 'supervisor' ? 'worker' : 'supervisor';
    const peer = peerAgent ? `${peerAgent} is the ${other} and runs in the same folder. ` : '';
    if (role === 'supervisor') {
        return `You are the supervisor of a supervised coding session in ${folder}. ${peer}`
            + 'Read ./.supervised/supervisor.md now and follow it for the whole session; re-read it if your context is '
            + 'compacted. Ask the person what to build, then read existing tasks.md and results.md, then write the next higher revision of ./tasks.md.';
    }
    if (role === 'worker') {
        return `You are the worker of a supervised coding session in ${folder}. ${peer}`
            + 'Read ./.supervised/worker.md now and follow it for the whole session; re-read it if your context is '
            + 'compacted. Do not start work yet: wait for a [supervisor] rev N prompt.';
    }
    throw new Error(`Unknown supervision role: ${role}`);
}

// The role a terminal plays, as a skill its own CLI discovers. A provider that
// installs it answers `skill: true`, and the prompt then carries no protocol.
export const SUPERVISION_SKILL_NAME = 'supervised-session';

// What a terminal is told when the provider installed the role skill: the role,
// the peer, and the two files. The protocol itself stays in the skill.
export function supervisionSkillIntro(role, { folder = '.', peerAgent = '' } = {}) {
    const other = role === 'supervisor' ? 'worker' : 'supervisor';
    const peer = peerAgent ? `${peerAgent} is the ${other} and runs in the same folder. ` : '';
    const mine = role === 'supervisor' ? './tasks.md' : './results.md';
    const theirs = role === 'supervisor' ? './results.md' : './tasks.md';
    return `You are the ${role} of a supervised coding session in ${folder}. ${peer}`
        + `Follow the ${SUPERVISION_SKILL_NAME}-${role} skill for the whole session. You write ${mine} and read ${theirs}.`;
}

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
