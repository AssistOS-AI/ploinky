import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from '../../utils/config.js';

const SETTINGS_FILE = path.join(PLOINKY_DIR, 'router-settings.json');
const DEFAULTS = {
    loginBrandingName: 'Login',
};

function loadFromDisk() {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch (_) {
        // missing, unreadable, or non-JSON — fall through to defaults
    }
    return {};
}

function normalize(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const branding = typeof source.loginBrandingName === 'string' ? source.loginBrandingName.trim() : '';
    return {
        loginBrandingName: branding || DEFAULTS.loginBrandingName,
    };
}

function saveToDisk(settings) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tempPath = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8' });
    fs.renameSync(tempPath, SETTINGS_FILE);
}

export function readRouterSettings() {
    return normalize(loadFromDisk());
}

export function updateRouterSettings(updates = {}) {
    const current = normalize(loadFromDisk());
    const next = normalize({ ...current, ...updates });
    saveToDisk(next);
    return next;
}
