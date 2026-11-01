// Read-only image discovery from one authorized routing lease. Inspect never
// pulls an image or observes a running agent/container.
import { execFile } from 'node:child_process';
import { commitRoutePlan } from './edgeRoutePlan.js';

export const AGENT_IMAGES_PATH = '/api/edge/agent-images';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTIVATION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_BODY_BYTES = 256 * 1024;
const cache = new WeakMap();

function failure(code = 'AGENT_IMAGES_UNAVAILABLE', status = 503) {
    return Object.assign(new Error(code), { code, status });
}

function text(value, maximum, { empty = false } = {}) {
    return typeof value === 'string' && (empty || value.length > 0)
        && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function imageReference(value) {
    if (!text(value, 4096) || /\s|\\|\$\{/.test(value) || value.startsWith('-')) throw failure();
    const parts = value.split('@');
    if (parts.length > 2 || (parts.length === 2 && !DIGEST.test(parts[1]))) throw failure();
    let repository = parts[0].replace(/:[^/:]+$/, '');
    if (!repository || repository.startsWith('/') || repository.endsWith('/')
        || repository.split('/').some((part) => !part || part === '.' || part === '..')) throw failure();
    const first = repository.split('/')[0];
    if (!first.includes('.') && !first.includes(':') && first !== 'localhost') repository = `docker.io/${repository}`;
    if (repository.startsWith('index.docker.io/')) repository = `docker.io/${repository.slice(16)}`;
    if (repository.startsWith('docker.io/') && repository.split('/').length === 2) {
        repository = `docker.io/library/${repository.slice(10)}`;
    }
    return { repository, pin: parts[1] || null };
}

function runInspect(command, args, options) {
    return new Promise((resolve) => {
        execFile(command, args, options, (error, stdout, stderr) => resolve({
            status: typeof error?.code === 'number' ? error.code : error ? null : 0,
            error: error && typeof error.code !== 'number' ? error : null,
            stdout,
            stderr,
        }));
    });
}

async function inspectImage(reference, query, deadline) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw failure();
    let result;
    try {
        result = await query('podman', ['image', 'inspect', '--', reference], {
            encoding: 'utf8', timeout, maxBuffer: MAX_BODY_BYTES,
        });
    } catch { throw failure(); }
    if (result.error) throw failure();
    // Podman image inspect uses 125 for an image not present in the local store.
    if (result.status === 125 && /no such image|image not known/i.test(String(result.stderr || ''))) return null;
    if (result.status !== 0 || Buffer.byteLength(String(result.stdout || '')) > MAX_BODY_BYTES) throw failure();
    let rows;
    try { rows = JSON.parse(result.stdout); } catch { throw failure(); }
    if (!Array.isArray(rows) || rows.length !== 1) throw failure();
    const row = rows[0];
    const imageId = typeof row?.Id === 'string' ? row.Id.replace(/^(?!sha256:)([a-f0-9]{64})$/, 'sha256:$1') : '';
    if (!DIGEST.test(imageId) || !Array.isArray(row.RepoDigests) || row.RepoDigests.length > 256) throw failure();
    const digests = row.RepoDigests.map((entry) => {
        if (!text(entry, 4096) || !/^.+@sha256:[a-f0-9]{64}$/.test(entry)) throw failure();
        return entry;
    });
    return Object.freeze({ imageId, digests: Object.freeze(digests) });
}

function leaseCache(plan, query) {
    let entry = cache.get(plan.snapshot);
    const key = `${plan.lease.activationId}:${plan.lease.effective?.revision || ''}`;
    if (!entry || entry.key !== key || entry.query !== query) {
        entry = { key, query, byReference: new Map(), byId: new Map() };
        cache.set(plan.snapshot, entry);
    }
    return entry;
}

export async function buildAgentImagesResponse(plan, { query = runInspect } = {}) {
    if (!plan?.ok || plan.listener !== 'private' || plan.kind !== 'private-operation'
        || plan.operation !== 'agent-images') throw failure('PRIVATE_LISTENER_REQUIRED', 403);
    const lease = plan.lease;
    if (!DIGEST.test(String(lease?.id || '')) || !ACTIVATION.test(String(lease?.activationId || ''))
        || lease.snapshot !== plan.snapshot || plan.snapshot?.generation !== lease.id) {
        throw failure('AGENT_IMAGES_LEASE_INVALID');
    }
    if (!commitRoutePlan(plan)) throw failure('edge_generation_changed');
    const records = Object.entries(plan.snapshot.agents || {}).filter(([name, record]) => (
        !name.startsWith('_') && record?.type === 'agent'
    ));
    if (records.length > 256) throw failure();
    const images = leaseCache(plan, query);
    const seen = new Set();
    const agents = [];
    const deadline = Date.now() + 2000;
    for (const [, record] of records) {
        const ref = `${record.repoName}/${record.agentName}`;
        if (!text(record.repoName, 128) || !text(record.agentName, 128)
            || [record.repoName, record.agentName].some((part) => part === '.' || part === '..')
            || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref) || seen.has(ref)) throw failure();
        seen.add(ref);
        const manifest = plan.snapshot.manifests?.[record.alias || record.agentName];
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw failure();
        const about = manifest.about ?? '';
        const enableMode = record.runMode || 'isolated';
        const runtime = record.runtime || 'podman';
        if (!text(about, 4096, { empty: true }) || !['isolated', 'global', 'devel'].includes(enableMode)
            || !['podman', 'docker', 'bwrap', 'seatbelt', 'host', 'none'].includes(runtime)) throw failure();
        const base = { ref, about, enableMode, runtime };
        if (!['podman', 'docker'].includes(runtime)) {
            agents.push({ ...base, image: null, reason: 'not_container' });
            continue;
        }
        // Launch resolved this image before recording it in the lease. Never
        // interpolate the raw manifest against mutable request-time state.
        const reference = record.containerImage || manifest.container || manifest.image;
        if (!reference) {
            agents.push({ ...base, image: null, reason: 'digest_unknown' });
            continue;
        }
        const { repository, pin } = imageReference(reference);
        if (!images.byReference.has(reference)) {
            const pending = inspectImage(reference, query, deadline).then((observed) => {
                // The inspected ID, rather than a mutable tag, owns cached image data.
                if (observed && !images.byId.has(observed.imageId)) images.byId.set(observed.imageId, observed);
                return observed?.imageId || null;
            }).catch((error) => {
                images.byReference.delete(reference);
                throw error;
            });
            images.byReference.set(reference, pending);
        }
        const imageId = await images.byReference.get(reference);
        const observed = imageId ? images.byId.get(imageId) : null;
        const matching = new Set((observed?.digests || []).map(imageReference)
            .filter((value) => value.repository === repository).map((value) => value.pin));
        const digest = pin || (matching.size === 1 ? [...matching][0] : null);
        agents.push(digest ? { ...base, image: { reference: repository, digest, imageId }, reason: null }
            : { ...base, image: null, reason: 'digest_unknown' });
    }
    agents.sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
    const envelope = { schemaVersion: 1, agents };
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_BODY_BYTES) throw failure();
    return envelope;
}

export async function sendAgentImages(res, { plan, body = Buffer.alloc(0), audit = () => {}, ...options } = {}) {
    let envelope;
    try {
        if (!Buffer.isBuffer(body) || body.length) throw failure('AGENT_IMAGES_REQUEST_INVALID', 400);
        envelope = await buildAgentImagesResponse(plan, options);
        if (!commitRoutePlan(plan)) throw failure('edge_generation_changed');
    } catch (error) {
        const payload = Buffer.from(JSON.stringify({ ok: false, error: error?.code || 'AGENT_IMAGES_UNAVAILABLE' }));
        res.writeHead(error?.status || 503, {
            'Content-Type': 'application/json', 'Content-Length': payload.length, 'Cache-Control': 'no-store',
        });
        res.end(payload);
        audit('agent_images_rejected', { code: error?.code || 'AGENT_IMAGES_UNAVAILABLE' });
        return false;
    }
    const payload = Buffer.from(JSON.stringify(envelope));
    res.writeHead(200, {
        'Content-Type': 'application/json', 'Content-Length': payload.length, 'Cache-Control': 'no-store',
    });
    res.end(payload);
    audit('agent_images_served', { agents: envelope.agents.length });
    return true;
}
