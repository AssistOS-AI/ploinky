import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PLOINKY_DIR } from './config.js';

const registrationFile = path.join(PLOINKY_DIR, 'unregistered_agent_repos.json');

function unregisteredRepositories() {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(registrationFile, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return new Set();
        throw error;
    }
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) {
        throw new Error(`Invalid repository registration state: ${registrationFile}`);
    }
    return new Set(value);
}

export function isAgentRepositoryUnregistered(name) {
    return unregisteredRepositories().has(name);
}

export function setAgentRepositoryRegistered(name, registered) {
    const names = unregisteredRepositories();
    if (registered ? !names.delete(name) : names.has(name)) return;
    if (!registered) names.add(name);
    fs.mkdirSync(PLOINKY_DIR, { recursive: true });
    const temporary = `${registrationFile}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify([...names].sort(), null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(temporary, registrationFile);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}
