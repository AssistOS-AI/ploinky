import { isTaskReferencePath } from './declaration.mjs';
import { isTaskReferenceId, validateTaskEventsQuery } from './providerEndpointPlan.mjs';
import { TASK_REFERENCE_UNAVAILABLE } from './routing.mjs';

// The generic task-reference surface (interface contract §2.3), reserved on
// every listener before any other dispatch. Only the exact canonical spelling
// of one fixed operation plans; every other spelling of the mount (encoded,
// undecodable, dot or empty segments, unknown shapes) stays Router-owned and
// unavailable, and no spelling ever reaches an agent route or a root
// application.
//
//   GET  /task-refs/descriptor?agent=<routeKey>&tool=<name>
//   GET  /task-refs/<provider>/<id>
//   GET  /task-refs/<provider>/<id>/events[?after=<n>&limit=<m>]
//   POST /task-refs/<provider>/<id>/control
//   POST /task-refs/<provider>/lookup

export { TASK_REFERENCE_UNAVAILABLE };
export const TASK_REFERENCE_REQUEST_INVALID = 'task_reference_request_invalid';
export const TASK_REFERENCE_METHOD_NOT_ALLOWED = 'task_reference_method_not_allowed';

const ROUTE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CANONICAL_PATH = /^\/task-refs(?:\/[A-Za-z0-9_.-]+)+$/;
const DESCRIPTOR_QUERY = /^agent=([A-Za-z0-9][A-Za-z0-9_.-]*)&tool=([A-Za-z0-9_.:-]{1,128})$/;

function refused(status, code) {
    return Object.freeze({ ok: false, matched: true, status, code });
}

const unavailable = () => refused(503, TASK_REFERENCE_UNAVAILABLE);
const invalid = () => refused(400, TASK_REFERENCE_REQUEST_INVALID);
const methodNotAllowed = () => refused(405, TASK_REFERENCE_METHOD_NOT_ALLOWED);

// Parses the raw request target. Returns {ok: true, op, ...} for one exact
// operation, or a refusal.
export function parseTaskReferenceTarget({ method, rawTarget }) {
    const raw = String(rawTarget || '');
    if (raw.includes('#')) return unavailable();
    const queryIndex = raw.indexOf('?');
    const path = queryIndex < 0 ? raw : raw.slice(0, queryIndex);
    const hasQuery = queryIndex >= 0;
    const query = hasQuery ? raw.slice(queryIndex + 1) : '';
    if (!CANONICAL_PATH.test(path)) return unavailable();
    const segments = path.split('/').slice(2);
    if (segments.some((segment) => segment === '.' || segment === '..')) return unavailable();
    const upper = String(method || 'GET').toUpperCase();

    if (segments.length === 1 && segments[0] === 'descriptor') {
        if (upper !== 'GET') return methodNotAllowed();
        const match = DESCRIPTOR_QUERY.exec(query);
        if (!match) return invalid();
        return Object.freeze({ ok: true, op: 'descriptor', path, query, agent: match[1], tool: match[2] });
    }
    if (segments.length < 2 || segments.length > 3 || !ROUTE_KEY.test(segments[0])) return unavailable();
    const [provider, second, third] = segments;
    if (segments.length === 2 && second === 'lookup') {
        if (upper !== 'POST') return methodNotAllowed();
        if (hasQuery) return invalid();
        return Object.freeze({ ok: true, op: 'lookup', path, query: '', provider, subpath: '/lookup' });
    }
    if (segments.length === 2) {
        if (upper !== 'GET') return methodNotAllowed();
        if (!isTaskReferenceId(second) || hasQuery) return invalid();
        return Object.freeze({ ok: true, op: 'read', path, query: '', provider, id: second, subpath: `/${second}` });
    }
    if (third === 'events') {
        if (upper !== 'GET') return methodNotAllowed();
        if (!isTaskReferenceId(second) || (hasQuery && query === '') || !validateTaskEventsQuery(query).ok) return invalid();
        return Object.freeze({ ok: true, op: 'events', path, query, provider, id: second, subpath: `/${second}/events` });
    }
    if (third === 'control') {
        if (upper !== 'POST') return methodNotAllowed();
        if (!isTaskReferenceId(second) || hasQuery) return invalid();
        return Object.freeze({ ok: true, op: 'control', path, query: '', provider, id: second, subpath: `/${second}/control` });
    }
    return unavailable();
}

// The pre-dispatch planner step. Returns null when the target is not the
// task-reference mount, a refusal, or a `task-reference` plan carrying the
// parsed operation. Upgrades and non-HTTP transports never plan.
// `forwarding` returns the request's canonical forwarding metadata; the browser
// mutation proof binds a POST to its origin, as for other Router surfaces.
export function taskReferenceRoutePlan({ req, pathname, listener, transport = 'http', host, hostSelection, lease, snapshot, parsedUrl, forwarding }) {
    const rawTarget = String(req?.url || '');
    const rawPath = rawTarget.split(/[?#]/)[0];
    if (!isTaskReferencePath(pathname) && !(rawPath && isTaskReferencePath(rawPath))) return null;
    if (transport !== 'http' || req?.headers?.upgrade) return unavailable();
    const request = parseTaskReferenceTarget({ method: req?.method, rawTarget });
    if (!request.ok) return request;
    return {
        matched: true,
        ok: true,
        kind: 'task-reference',
        listener,
        host,
        hostSelection,
        pathname: request.path,
        canonicalPath: request.path,
        parsedUrl,
        lease,
        snapshot,
        forwarding: typeof forwarding === 'function' ? forwarding() : forwarding,
        request,
    };
}
