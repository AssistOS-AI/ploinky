import fs from 'fs';
import path from 'path';

import { ROUTING_FILE } from '../utils/config.js';

const ROUTING_LOCK_FILE = `${ROUTING_FILE}.lock`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRoutingLock({ timeoutMs = 10000, intervalMs = 50 } = {}) {
    const start = Date.now();
    while (true) {
        try {
            fs.mkdirSync(path.dirname(ROUTING_LOCK_FILE), { recursive: true });
            const fd = fs.openSync(ROUTING_LOCK_FILE, 'wx');
            fs.writeFileSync(fd, JSON.stringify({
                pid: process.pid,
                createdAt: new Date().toISOString()
            }));
            return () => {
                try { fs.closeSync(fd); } catch (_) {}
                try { fs.unlinkSync(ROUTING_LOCK_FILE); } catch (_) {}
            };
        } catch (error) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timed out waiting for routing file lock: ${ROUTING_LOCK_FILE}`);
            }
            await sleep(intervalMs);
        }
    }
}

function readRoutingConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object') {
            parsed.routes = parsed.routes && typeof parsed.routes === 'object' ? parsed.routes : {};
            return parsed;
        }
    } catch (_) {}
    return { routes: {} };
}

function writeRoutingConfig(config) {
    const target = config && typeof config === 'object' ? config : {};
    target.routes = target.routes && typeof target.routes === 'object' ? target.routes : {};
    fs.mkdirSync(path.dirname(ROUTING_FILE), { recursive: true });
    const tempFile = `${ROUTING_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(target, null, 2));
    fs.renameSync(tempFile, ROUTING_FILE);
}

async function mergeRoutingConfig(mutator) {
    const release = await acquireRoutingLock();
    try {
        const current = readRoutingConfig();
        const next = await mutator(current) || current;
        writeRoutingConfig(next);
        return next;
    } finally {
        release();
    }
}

export {
    mergeRoutingConfig,
    readRoutingConfig
};
