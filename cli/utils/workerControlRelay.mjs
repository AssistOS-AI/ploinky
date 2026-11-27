// The Router supplies a pair-scoped client; robot processes receive no Router or user credentials.
export function createWorkerControlRelay({ api, client, session, monitor, now = Date.now,
    onStatus = () => {}, intervalMs = 500, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let stopped = true;
    let timer;
    let answers = [];
    let inFlight;
    async function execute(request) {
        if (request.deadline <= now()) return { error: 'Control request expired without execution' };
        const base = `/webtty/sessions/${encodeURIComponent(session.worker.terminalId)}`;
        if (request.operation === 'worker_status') {
            try { return await client.json('GET', `${base}/output`); }
            catch (error) { if (error.status === 404) return { running: false, lastOutputAt: null, silentForSeconds: null, recentOutput: '' }; throw error; }
        }
        if (request.operation === 'worker_interrupt') {
            if (!session.worker.interruptInput) return { error: 'Native interrupt is unavailable; reopen the worker with updated ALA.' };
            await client.json('POST', `${base}/input`, { data: session.worker.interruptInput });
            return { interruptRequested: true, stoppedConfirmed: false,
                message: 'Check worker_status before sending corrected instructions. Customized keybindings may change interrupt behavior.' };
        }
        if (request.operation === 'worker_send') {
            const { message } = request.arguments || {};
            if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 8000
                || Object.keys(request.arguments).join(',') !== 'message' || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(message)) return { error: 'Invalid worker message' };
            await client.json('POST', `${base}/input`, { data: `\u001b[200~${message}\u001b[201~\r` });
            await monitor.sent();
            return { delivered: true };
        }
        return { error: 'Unknown worker operation' };
    }
    async function pass() {
        if (!session.supervisor.controlId) { onStatus('Reopen this pair to enable server worker control'); return; }
        const result = await api('control-poll', { id: session.supervisor.controlId, results: answers });
        answers = [];
        for (const request of result.requests || []) {
            let value;
            try { value = await execute(request); }
            catch (error) { value = { error: error.message || 'Worker operation failed' }; }
            answers.push({ requestId: request.requestId, result: value });
        }
    }
    function once() {
        if (!inFlight) inFlight = pass().catch(error => onStatus(error.message)).finally(() => { inFlight = null; });
        return inFlight;
    }
    async function tick() {
        if (stopped) return;
        await once();
        if (!stopped) { timer = setTimer(tick, intervalMs); timer?.unref?.(); }
    }
    return { once,
        start() { if (!stopped) return; stopped = false; monitor.start(); void tick(); },
        stop() { stopped = true; clearTimer(timer); monitor.stop(); },
    };
}
