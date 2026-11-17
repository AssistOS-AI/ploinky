import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = value => `"${value}"`;

export function validateSqliteHomeRules(rules = []) {
    if (!Array.isArray(rules) || rules.length > 32) throw new Error('Invalid SQLite home migration rules');
    for (const rule of rules) {
        if (!rule || typeof rule.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rule.file)
            || ['table', 'key', 'column', 'array'].some(field => typeof rule[field] !== 'string' || !IDENTIFIER.test(rule[field]))) {
            throw new Error('Invalid SQLite home migration rule');
        }
    }
    return rules;
}

export function inspectSqliteHomePaths(file, rule, prefixes) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const columns = db.prepare(`PRAGMA table_info(${quote(rule.table)})`).all();
        if (!columns.length) throw new Error('SQLite home migration table is missing');
        const keys = columns.filter(column => column.pk);
        if (keys.length !== 1 || keys[0].name !== rule.key || !columns.some(column => column.name === rule.column)) {
            throw new Error('SQLite home migration requires the declared primary key and JSON column');
        }
        const changes = [];
        for (const row of db.prepare(`SELECT ${quote(rule.key)} AS id, ${quote(rule.column)} AS value FROM ${quote(rule.table)} WHERE ${quote(rule.column)} IS NOT NULL`).iterate()) {
            const value = JSON.parse(row.value);
            if (!value || typeof value !== 'object' || !Array.isArray(value[rule.array])) continue;
            let changed = false;
            value[rule.array] = value[rule.array].map(entry => {
                if (typeof entry !== 'string') return entry;
                const prefix = prefixes.find(prefix => entry.startsWith(prefix));
                if (!prefix) return entry;
                const suffix = entry.slice(prefix.length);
                if (suffix.includes('\0') || suffix.split('/').includes('..')) throw new Error('Unsafe legacy SQLite file reference');
                changed = true;
                return `/root/${suffix}`;
            });
            if (changed) changes.push({ id: row.id, before: row.value, after: JSON.stringify(value) });
        }
        return changes;
    } finally { db.close(); }
}

export function applySqliteHomePaths(file, rule, changes) {
    if (!changes.length) return;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        const update = db.prepare(`UPDATE ${quote(rule.table)} SET ${quote(rule.column)}=? WHERE ${quote(rule.key)}=? AND ${quote(rule.column)}=?`);
        for (const row of changes) {
            if (update.run(row.after, row.id, row.before).changes !== 1) throw new Error('SQLite data changed during offline home migration');
        }
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
    } finally { db.close(); }
}
