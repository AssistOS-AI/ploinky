import fs from 'node:fs';
import path from 'node:path';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';

/**
 * Persistent session revocation list (DS014/DS012).
 *
 * User Session and Guest Session JWTs are stateless, so logout / forced
 * revocation needs an out-of-band deny list. This stores revoked `sid` and
 * `jti` values under `.ploinky/data/router-security/sessions-revocations.json`
 * and is consulted on every session resolution.
 *
 * Unlike the access-control policy collections (which fail CLOSED on a corrupt
 * file), a corrupt/missing revocation list degrades to "nothing revoked": a
 * revocation list that failed closed would deny every user and become a DoS,
 * and the file lives under the high-trust `.ploinky/` tree anyway. JWT expiry
 * and the rev-based check remain in force regardless.
 */

const SCHEMA = 'sessions-revocations';

function workspaceRoot() {
    return path.resolve(PLOINKY_WORKSPACE_ROOT);
}

function revocationsDir() {
    return path.join(workspaceRoot(), '.ploinky', 'data', 'router-security');
}

function revocationsFile() {
    return path.join(revocationsDir(), 'sessions-revocations.json');
}

let cache = { sids: new Set(), jtis: new Set() };
let cacheKey = '';

function loadIndex() {
    const file = revocationsFile();
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        cache = { sids: new Set(), jtis: new Set() };
        cacheKey = '';
        return cache;
    }
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (key === cacheKey) {
        return cache;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const entries = Array.isArray(parsed?.revoked) ? parsed.revoked : [];
        const sids = new Set();
        const jtis = new Set();
        for (const entry of entries) {
            if (entry?.sid) sids.add(String(entry.sid));
            if (entry?.jti) jtis.add(String(entry.jti));
        }
        cache = { sids, jtis };
        cacheKey = key;
    } catch (err) {
        // Corrupt file: degrade to empty (see header note) and do not overwrite.
        console.error(`[ploinky] sessions-revocations.json is unreadable; treating as empty: ${err?.message || err}`);
        cache = { sids: new Set(), jtis: new Set() };
        cacheKey = key;
    }
    return cache;
}

export function isSessionRevoked({ sid, jti } = {}) {
    if (!sid && !jti) return false;
    const { sids, jtis } = loadIndex();
    if (sid && sids.has(String(sid))) return true;
    if (jti && jtis.has(String(jti))) return true;
    return false;
}

export function revokeSessionId({ sid, jti, reason = '', at } = {}) {
    const normSid = sid ? String(sid) : '';
    const normJti = jti ? String(jti) : '';
    if (!normSid && !normJti) return false;
    const dir = revocationsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = revocationsFile();
    let data = { schema: SCHEMA, revoked: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed?.schema === SCHEMA && Array.isArray(parsed.revoked)) {
            data = parsed;
        }
    } catch {
        // Missing or corrupt: start a fresh list rather than failing the logout.
    }
    const entry = { ts: at || new Date().toISOString() };
    if (normSid) entry.sid = normSid;
    if (normJti) entry.jti = normJti;
    if (reason) entry.reason = String(reason);
    data.revoked.push(entry);
    // Atomic write: temp file in the same dir, then rename over the active file.
    const tmp = path.join(dir, `.sessions-revocations.${process.pid}.${data.revoked.length}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    cacheKey = '';
    return true;
}

export default {
    isSessionRevoked,
    revokeSessionId,
};
