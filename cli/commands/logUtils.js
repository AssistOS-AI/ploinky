import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { LOGS_DIR } from '../utils/config.js';

export function getLogPath(kind) {
    const base = LOGS_DIR;
    const map = { router: 'router.log' };
    const file = map[kind] || map.router;
    return path.join(base, file);
}

export async function logsTail(kind) {
    const file = getLogPath(kind);
    if (!fs.existsSync(file)) {
        console.log(`No log file yet: ${file}`);
        return;
    }
    try {
        const proc = spawn('tail', ['-f', file], { stdio: 'inherit' });
        await new Promise(resolve => proc.on('exit', resolve));
    } catch (_) {
        console.log(`Following ${file} (fallback watcher). Stop with Ctrl+C.`);
        let pos = fs.statSync(file).size;
        const fd = fs.openSync(file, 'r');
        const loop = () => {
            try {
                const st = fs.statSync(file);
                if (st.size > pos) {
                    const len = st.size - pos;
                    const buf = Buffer.alloc(len);
                    fs.readSync(fd, buf, 0, len, pos);
                    process.stdout.write(buf.toString('utf8'));
                    pos = st.size;
                }
            } catch (_) {}
            setTimeout(loop, 1000);
        };
        loop();
    }
}

export function showLast(count, kind) {
    const n = Math.max(1, parseInt(count || '200', 10) || 200);
    const file = getLogPath(kind || 'router');
    if (!fs.existsSync(file)) {
        console.log(`No log file: ${file}`);
        return;
    }
    try {
        const result = spawnSync('tail', ['-n', String(n), file], { stdio: 'inherit' });
        if (result.status !== 0) throw new Error('tail failed');
    } catch (e) {
        try {
            const data = fs.readFileSync(file, 'utf8');
            const lines = data.split('\n');
            const chunk = lines.slice(-n).join('\n');
            console.log(chunk);
        } catch (e2) {
            console.error(`Failed to read ${file}: ${e2.message}`);
        }
    }
}
