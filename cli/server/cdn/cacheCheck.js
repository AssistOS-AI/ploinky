import http from 'node:http';

// One request to the Router's own public listener inside the Box, the way an
// anonymous browser would make it: only a Host header, never a cookie.
function answerOnce({ host, path, method, publicPort }, request) {
    return new Promise((resolve, reject) => {
        const req = request({
            hostname: '127.0.0.1', port: publicPort, method, path, headers: { host },
            agent: false, signal: AbortSignal.timeout(5000),
        }, res => {
            const field = name => {
                const value = res.headers[name];
                return typeof value === 'string' ? value : null;
            };
            resolve({ status: res.statusCode, cdnHeader: field('cloudflare-cdn-cache-control'), cacheControl: field('cache-control') });
            res.destroy();
        });
        req.on('error', reject);
        req.end();
    });
}

// HEAD first. An application that does not answer HEAD like GET (any status of
// 400 or more) is asked again with GET, and that answer is reported.
export async function checkCacheRoute({ host, path, publicPort = 8080 }, request = http.request) {
    const head = await answerOnce({ host, path, method: 'HEAD', publicPort }, request);
    if (head.status < 400) return head;
    return answerOnce({ host, path, method: 'GET', publicPort }, request);
}

// One check per second per session. The slot is taken before the request starts.
const slots = new Map();

export function takeCheckSlot(session, now = () => performance.now()) {
    const time = now();
    for (const [key, until] of slots) {
        if (until <= time) slots.delete(key);
    }
    if (slots.has(session)) return false;
    slots.set(session, time + 1000);
    return true;
}
