// A fictional task-reference tool process for AgentServer tests. It records
// what AgentServer handed it (input, the Router origin token and whether the
// auth-info header was present) to `seen-<label>.json` in its directory, and
// prints one admission result whose shape `input.mode` selects.
import fs from 'node:fs';
import path from 'node:path';

export function writeTaskReferenceToolScript(dir, provider) {
    const file = path.join(dir, 'task-ref-tool.mjs');
    fs.writeFileSync(file, `
import fs from 'node:fs';
import path from 'node:path';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const input = payload.input || {};
    const meta = payload.metadata || {};
    fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'seen-' + (input.label || 'x') + '.json'), JSON.stringify({
        input,
        taskRefOrigin: meta.taskRefOrigin || '',
        authInfoHeader: meta.requestInfo?.headers?.['x-ploinky-auth-info'] || '',
    }));
    const ok = { taskRef: { version: 1, provider: ${JSON.stringify(provider)}, id: 'T'.repeat(22) }, state: 'accepted', originRequestId: input.originRequestId };
    const outputs = {
        ok: JSON.stringify(ok),
        queued: JSON.stringify({ ...ok, state: 'queued' }),
        text: 'Task queued with id 42',
        extra: JSON.stringify({ ...ok, taskId: 'legacy' }),
        provider: JSON.stringify({ ...ok, taskRef: { ...ok.taskRef, provider: 'someone-else' } }),
        origin: JSON.stringify({ ...ok, originRequestId: 'B'.repeat(22) }),
        state: JSON.stringify({ ...ok, state: 'completed' }),
        two: JSON.stringify(ok) + '\\n' + JSON.stringify(ok),
        refkey: JSON.stringify({ ...ok, taskRef: { ...ok.taskRef, url: 'http://x' } }),
        shortid: JSON.stringify({ ...ok, taskRef: { ...ok.taskRef, id: 'short' } }),
    };
    process.stdout.write(outputs[input.mode || 'ok']);
});
`);
    return file;
}

export function taskReferenceTool(dir, { name = 'start_job', provider = 'explorer', extra = {} } = {}) {
    return {
        name,
        description: 'Fictional task-reference admission',
        command: process.execPath,
        args: [writeTaskReferenceToolScript(dir, provider)],
        cwd: dir,
        taskReference: { version: 1, provider },
        inputSchema: {
            type: 'object',
            properties: {
                label: { type: 'string' },
                mode: { type: 'string', enum: ['ok', 'queued', 'text', 'extra', 'provider', 'origin', 'state', 'two', 'refkey', 'shortid'] },
            },
        },
        ...extra,
    };
}
