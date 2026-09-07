import { StringDecoder } from 'node:string_decoder';
const PREFIX = '@@PLOINKY_TASK_CONTROL@@';

// Metadata is accepted only at line boundaries; all other bytes remain live logs.
export function createTaskControlStream(onLog, onControl) {
    let buffered = '';
    const decoder = new StringDecoder('utf8');
    let lineStart = true;
    const consume = () => {
        while (buffered) {
            if (lineStart && (PREFIX.startsWith(buffered) || buffered.startsWith(PREFIX))) {
                const newline = buffered.indexOf('\n');
                if (newline < 0 && buffered.length < 4096) return;
                if (newline >= 0) {
                    const record = buffered.slice(PREFIX.length, newline);
                    buffered = buffered.slice(newline + 1);
                    try { onControl(JSON.parse(record)); } catch {}
                    continue;
                }
            }
            const newline = buffered.indexOf('\n');
            if (newline < 0) { onLog(buffered); buffered = ''; lineStart = false; return; }
            onLog(buffered.slice(0, newline + 1));
            buffered = buffered.slice(newline + 1); lineStart = true;
        }
    };
    return {
        push(chunk) { buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk); consume(); },
        finish() { buffered += decoder.end(); if (buffered) onLog(buffered); buffered = ''; }
    };
}
