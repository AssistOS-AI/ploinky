import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// A supervised pair shares task/result records; its supervisor directs the worker through MCP.
// Role skills are installed through the workspace skill exporter.
export const SUPERVISION_ROLES = Object.freeze(['supervisor', 'worker']);
export const SUPERVISION_ROLE_LABELS = Object.freeze({ supervisor: 'Supervisor', worker: 'Worker' });

const ROLE_ROOT = new URL('../resources/supervised-sessions/', import.meta.url);

export function supervisionRoleText(role, { readFile = fs.readFileSync } = {}) {
    if (!SUPERVISION_ROLES.includes(role)) throw new Error(`Unknown supervision role: ${role}`);
    return readFile(fileURLToPath(new URL(`supervised-session-${role}/SKILL.md`, ROLE_ROOT)), 'utf8');
}

export const SUPERVISION_SKILL_NAME = 'supervised-session';

// This is native session configuration, never terminal input. The workflow stays in the installed skill.
export function supervisionSystemPrompt(role, binding = null) {
    if (!SUPERVISION_ROLES.includes(role)) throw new Error(`Unknown supervision role: ${role}`);
    return `This session is the ${SUPERVISION_ROLE_LABELS[role]} of a supervised coding session. `
        + `Read and follow ./.agents/skills/supervised-session-${role}/SKILL.md for this session. `
        + 'Use only the skill for your assigned role; the other role belongs to the other session.'
        + (typeof binding === 'string' && /^[a-f0-9-]{36}$/u.test(binding) ? `\nSession binding: ${binding}` : '');
}
