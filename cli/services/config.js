import fs from 'fs';
import path from 'path';

function resolveWorkspaceRoot() {
    let cwd;
    const explicitRoot = String(process.env.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (explicitRoot) {
        const normalizedExplicit = path.resolve(explicitRoot);
        try {
            if (fs.statSync(normalizedExplicit).isDirectory()) {
                return normalizedExplicit;
            }
        } catch (_) {}
    }

    try {
        cwd = path.resolve(process.cwd());
    } catch (err) {
        if (err?.code === 'ENOENT') {
            console.error([
                'Ploinky could not determine the current directory because it no longer exists.',
                'Change into an existing directory and run the command again, for example:',
                '  cd ..',
                '  cd -P <workspace>',
            ].join('\n'));
            process.exit(1);
        }
        throw err;
    }

    let current = cwd;
    while (true) {
        try {
            const candidate = path.join(current, '.ploinky');
            if (fs.statSync(candidate).isDirectory()) {
                return current;
            }
        } catch (_) {
            // Continue searching up the tree when missing or inaccessible.
        }

        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return cwd;
}

export const PLOINKY_WORKSPACE_ROOT = resolveWorkspaceRoot();
if (!process.env.PLOINKY_WORKSPACE_ROOT) {
    process.env.PLOINKY_WORKSPACE_ROOT = PLOINKY_WORKSPACE_ROOT;
}

let launchCwd;
try {
    launchCwd = path.resolve(process.cwd());
} catch (_) {
    launchCwd = PLOINKY_WORKSPACE_ROOT;
}
export const PLOINKY_CWD = launchCwd;
if (!process.env.PLOINKY_CWD) {
    process.env.PLOINKY_CWD = PLOINKY_CWD;
}

export const PLOINKY_DIR = path.join(PLOINKY_WORKSPACE_ROOT, '.ploinky');
export const REPOS_DIR = path.join(PLOINKY_DIR, 'repos');
export const AGENTS_FILE = path.join(PLOINKY_DIR, 'agents.json');
export const SECRETS_FILE = path.join(PLOINKY_DIR, '.secrets');
export const PROFILE_FILE = path.join(PLOINKY_DIR, 'profile');

// Workspace runtime structure lives under .ploinky/
export const AGENTS_WORK_DIR = path.join(PLOINKY_DIR, 'agents');
export const CODE_DIR = path.join(PLOINKY_DIR, 'code');
export const SKILLS_DIR = path.join(PLOINKY_DIR, 'skills');
export const LOGS_DIR = path.join(PLOINKY_DIR, 'logs');
export const SHARED_DIR = path.join(PLOINKY_DIR, 'shared');
export const RUNNING_DIR = path.join(PLOINKY_DIR, 'running');
export const ROUTING_FILE = path.join(PLOINKY_DIR, 'routing.json');
export const SERVERS_CONFIG_FILE = path.join(PLOINKY_DIR, 'servers.json');
export const TRANSCRIPTS_DIR = path.join(PLOINKY_DIR, 'transcripts');
export const DEPS_DIR = path.join(PLOINKY_DIR, 'deps');
export const GLOBAL_DEPS_CACHE_DIR = path.join(DEPS_DIR, 'global');
export const AGENTS_DEPS_CACHE_DIR = path.join(DEPS_DIR, 'agents');
export const HISTORY_FILE = path.join(PLOINKY_DIR, 'ploinky_history');
export const TEMPLATES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '../../templates');
export const GLOBAL_DEPS_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '../../globalDeps');

let DEBUG_MODE = process.env.PLOINKY_DEBUG === '1';

export function setDebugMode(enabled) {
    DEBUG_MODE = Boolean(enabled);
}

export function isDebugMode() {
    return DEBUG_MODE;
}

export function initEnvironment() {
    if (!fs.existsSync(PLOINKY_DIR)) {
        console.log(`Initializing Ploinky environment in ${path.resolve(PLOINKY_DIR)}...`);
        fs.mkdirSync(PLOINKY_DIR, { recursive: true });
    }

    const requiredDirs = [
        REPOS_DIR,
        AGENTS_WORK_DIR,
        CODE_DIR,
        SKILLS_DIR,
        LOGS_DIR,
        SHARED_DIR,
        RUNNING_DIR,
        TRANSCRIPTS_DIR,
    ];
    for (const dir of requiredDirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    if (!fs.existsSync(AGENTS_FILE)) {
        fs.writeFileSync(AGENTS_FILE, JSON.stringify({}, null, 2));
    }

    if (!fs.existsSync(HISTORY_FILE)) {
        fs.writeFileSync(HISTORY_FILE, '');
    }
}
