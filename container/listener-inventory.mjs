import fs from 'node:fs';

const PROFILE_SCHEMA_VERSION = 1;
const SS_COLUMNS = 6;

function immutableArray(values) {
    return Object.freeze([...values]);
}

function compilePattern(value, field) {
    if (value === undefined) return null;
    try {
        return new RegExp(String(value));
    } catch (error) {
        throw new Error(`listener profile ${field} is not a valid regular expression: ${error.message}`);
    }
}

function parsePort(value, field = 'port') {
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`listener profile ${field} must be an integer from 1 through 65535`);
    }
    return port;
}

function normalizedOwnerProcesses(raw) {
    const values = [];
    const pattern = /"([^"]+)"/g;
    let match;
    while ((match = pattern.exec(raw)) !== null) values.push(match[1]);
    return immutableArray(new Set(values));
}

function normalizedOwnerPids(raw) {
    const values = [];
    const pattern = /\bpid=(\d+)\b/g;
    let match;
    while ((match = pattern.exec(raw)) !== null) values.push(Number(match[1]));
    return immutableArray(new Set(values));
}

export function classifyBindAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    if (address === '127.0.0.1' || address === '::1') return 'loopback';
    if (address === '*' || address === '0.0.0.0' || address === '::') return 'wildcard';
    return 'specific';
}

export function parseSocketAddress(value) {
    const raw = String(value || '').trim();
    const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(raw);
    if (bracketed) {
        return Object.freeze({
            address: bracketed[1],
            port: parsePort(bracketed[2], 'ss port'),
        });
    }
    const separator = raw.lastIndexOf(':');
    if (separator < 0) throw new Error(`ss local address has no port: ${raw}`);
    const address = raw.slice(0, separator);
    return Object.freeze({
        address: address || '*',
        port: parsePort(raw.slice(separator + 1), 'ss port'),
    });
}

export function parseSsOutput(stdout, {
    namespace,
    containerName = null,
} = {}) {
    const normalizedNamespace = String(namespace || '').trim();
    if (!normalizedNamespace) throw new Error('listener namespace is required');
    const records = [];
    const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const [index, line] of lines.entries()) {
        const columns = line.split(/\s+/);
        if (columns.length < SS_COLUMNS) {
            throw new Error(`cannot parse ss record ${index + 1} in ${normalizedNamespace}: ${line}`);
        }
        const protocol = columns[0].toLowerCase();
        if (protocol !== 'tcp' && protocol !== 'udp') {
            throw new Error(`unsupported ss protocol '${columns[0]}' in ${normalizedNamespace}`);
        }
        const local = parseSocketAddress(columns[4]);
        const processDetails = columns.slice(SS_COLUMNS).join(' ');
        records.push(Object.freeze({
            namespace: normalizedNamespace,
            containerName: containerName ? String(containerName) : null,
            protocol,
            state: columns[1],
            bindAddress: local.address,
            bindClass: classifyBindAddress(local.address),
            port: local.port,
            ownerProcesses: normalizedOwnerProcesses(processDetails),
            ownerPids: normalizedOwnerPids(processDetails),
            processDetails,
            raw: line,
        }));
    }
    return immutableArray(records);
}

export function parsePodmanPsJson(stdout) {
    const raw = String(stdout || '').trim();
    if (!raw) return immutableArray([]);
    let records;
    try {
        const value = JSON.parse(raw);
        records = Array.isArray(value) ? value : [value];
    } catch (_) {
        records = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
            try {
                return JSON.parse(line);
            } catch (error) {
                throw new Error(`cannot parse nested podman ps JSON record ${index + 1}: ${error.message}`);
            }
        });
    }
    return immutableArray(records.map((record, index) => {
        const rawNames = record?.Names ?? record?.names ?? record?.Name ?? record?.name;
        const name = Array.isArray(rawNames) ? rawNames[0] : rawNames;
        if (!String(name || '').trim()) {
            throw new Error(`nested podman ps JSON record ${index + 1} has no container name`);
        }
        const id = String(record?.Id ?? record?.ID ?? record?.id ?? '');
        if (!id) throw new Error(`nested podman ps JSON record ${index + 1} has no container ID`);
        return Object.freeze({
            name: String(name).replace(/^\//, ''),
            id,
            image: String(record?.Image ?? record?.image ?? ''),
        });
    }));
}

export function parsePidNamespaceInventory(stdout, containerName) {
    let value;
    try {
        value = JSON.parse(String(stdout || ''));
    } catch (error) {
        throw new Error(`nested container '${containerName}' PID-namespace inventory is invalid JSON: ${error.message}`);
    }
    const initPid = Number(value?.initPid);
    if (!Number.isSafeInteger(initPid) || initPid < 1) {
        throw new Error(`nested container '${containerName}' PID-namespace inventory has invalid initPid`);
    }
    const pidNamespace = String(value?.pidNamespace || '');
    if (!/^pid:\[\d+]$/.test(pidNamespace)) {
        throw new Error(`nested container '${containerName}' returned invalid PID namespace '${pidNamespace}'`);
    }
    if (!Array.isArray(value?.pids)) {
        throw new Error(`nested container '${containerName}' PID-namespace inventory has no PID array`);
    }
    const pids = [...new Set(value.pids.map((rawPid) => {
        const pid = Number(rawPid);
        if (!Number.isSafeInteger(pid) || pid < 1) {
            throw new Error(`nested container '${containerName}' returned invalid PID '${rawPid}'`);
        }
        return pid;
    }))].sort((left, right) => left - right);
    if (!pids.includes(initPid)) {
        throw new Error(`nested container '${containerName}' init PID ${initPid} is absent from its PID namespace`);
    }
    return Object.freeze({ initPid, pidNamespace, pids: immutableArray(pids) });
}

function normalizeContainerInspection(raw, listed) {
    const record = Array.isArray(raw) ? raw[0] : raw;
    const name = String(record?.Name || listed.name || '').replace(/^\//, '');
    if (!name) throw new Error(`nested container '${listed.name}' inspection has no name`);
    const labels = record?.Config?.Labels || {};
    const networkMode = String(record?.HostConfig?.NetworkMode || '').trim().toLowerCase();
    if (!networkMode) throw new Error(`nested container '${name}' inspection has no network mode`);
    const inspectedPidMode = String(record?.HostConfig?.PidMode || '').trim().toLowerCase();
    if (inspectedPidMode && inspectedPidMode !== 'private') {
        throw new Error(`nested container '${name}' uses unsupported shared PID mode '${inspectedPidMode}'`);
    }
    if (record?.State?.Running !== true) {
        throw new Error(`nested container '${name}' inspection is not in the running state`);
    }
    const initPid = Number(record?.State?.Pid);
    if (!Number.isSafeInteger(initPid) || initPid < 1) {
        throw new Error(`nested container '${name}' inspection has invalid State.Pid '${record?.State?.Pid}'`);
    }
    const startedAt = String(record?.State?.StartedAt || '').trim();
    if (!startedAt) throw new Error(`nested container '${name}' inspection has no State.StartedAt`);
    const inspectedId = String(record?.Id || '');
    if (!inspectedId) throw new Error(`nested container '${name}' inspection has no container ID`);
    if (listed.id && !inspectedId.startsWith(listed.id)) {
        throw new Error(`nested container '${name}' inspection ID does not match its running-list record`);
    }
    return Object.freeze({
        name,
        id: inspectedId,
        image: String(record?.ImageName || record?.Config?.Image || listed.image || ''),
        networkMode,
        pidMode: 'private',
        managed: labels['io.assistos.ploinky.managed'] === '1',
        namespace: networkMode === 'host' ? 'outer' : `nested:${name}`,
        initPid,
        startedAt,
        pidNamespace: '',
        pids: immutableArray([]),
    });
}

export function buildContainerRecord({ inspection, listed, pidInventory }) {
    const normalized = normalizeContainerInspection(inspection, listed);
    if (pidInventory.initPid !== normalized.initPid) {
        throw new Error(
            `nested container '${normalized.name}' inspection State.Pid changed before PID-namespace collection`,
        );
    }
    return Object.freeze({
        ...normalized,
        pidNamespace: pidInventory.pidNamespace,
        pids: immutableArray(pidInventory.pids),
    });
}

function validateProfileShape(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new Error('listener profile must be an object');
    }
    if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
        throw new Error(`listener profile schemaVersion must equal ${PROFILE_SCHEMA_VERSION}`);
    }
    if (!String(profile.id || '').trim()) throw new Error('listener profile id is required');
    if (!Array.isArray(profile.requiredContainers)) {
        throw new Error('listener profile requiredContainers must be an array');
    }
    if (!Array.isArray(profile.rules)) throw new Error('listener profile rules must be an array');
    if (!Array.isArray(profile.controlPorts)) {
        throw new Error('listener profile controlPorts must be an array');
    }
    if (!Array.isArray(profile.forbiddenSockets)) {
        throw new Error('listener profile forbiddenSockets must be an array');
    }
}

function compileRequiredContainer(entry, index) {
    if (!String(entry?.id || '').trim()) {
        throw new Error(`listener profile requiredContainers[${index}].id is required`);
    }
    const minimum = entry.minMatches === undefined ? 1 : Number(entry.minMatches);
    const maximum = entry.maxMatches === undefined ? minimum : Number(entry.maxMatches);
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum < minimum) {
        throw new Error(`listener profile requiredContainers[${index}] has invalid match bounds`);
    }
    return Object.freeze({
        ...entry,
        namePattern: compilePattern(entry.namePattern, `requiredContainers[${index}].namePattern`),
        networkModePattern: compilePattern(entry.networkModePattern, `requiredContainers[${index}].networkModePattern`),
        minMatches: minimum,
        maxMatches: maximum,
    });
}

function compilePorts(entry, field) {
    const ports = (entry.ports || []).map((port, index) => parsePort(port, `${field}.ports[${index}]`));
    const ranges = (entry.portRanges || []).map((range, index) => {
        const start = parsePort(range?.start, `${field}.portRanges[${index}].start`);
        const end = parsePort(range?.end, `${field}.portRanges[${index}].end`);
        if (end < start) throw new Error(`listener profile ${field}.portRanges[${index}] is reversed`);
        return Object.freeze({ start, end });
    });
    return Object.freeze({ ports: immutableArray(ports), portRanges: immutableArray(ranges) });
}

function compileRule(entry, index) {
    if (!String(entry?.id || '').trim()) throw new Error(`listener profile rules[${index}].id is required`);
    if (!String(entry?.rationale || '').trim()) {
        throw new Error(`listener profile rules[${index}].rationale is required`);
    }
    const minimum = entry.minMatches === undefined ? 0 : Number(entry.minMatches);
    const maximum = entry.maxMatches === undefined ? Number.MAX_SAFE_INTEGER : Number(entry.maxMatches);
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum < minimum) {
        throw new Error(`listener profile rules[${index}] has invalid match bounds`);
    }
    const portSet = compilePorts(entry, `rules[${index}]`);
    const dynamicBindSet = entry.dynamicBindSet === undefined
        ? null
        : String(entry.dynamicBindSet);
    if (dynamicBindSet && dynamicBindSet !== 'loopback-and-managed-gateways') {
        throw new Error(`listener profile rules[${index}].dynamicBindSet is unsupported`);
    }
    if (dynamicBindSet && ((entry.bindClasses || []).length || (entry.bindAddresses || []).length)) {
        throw new Error(
            `listener profile rules[${index}] cannot combine dynamicBindSet with static bind selectors`,
        );
    }
    return Object.freeze({
        ...entry,
        ...portSet,
        namespacePattern: compilePattern(entry.namespacePattern, `rules[${index}].namespacePattern`),
        containerPattern: compilePattern(entry.containerPattern, `rules[${index}].containerPattern`),
        ownerPattern: compilePattern(entry.ownerPattern, `rules[${index}].ownerPattern`),
        ownerContainerPattern: compilePattern(entry.ownerContainerPattern, `rules[${index}].ownerContainerPattern`),
        protocols: immutableArray((entry.protocols || []).map(value => String(value).toLowerCase())),
        bindClasses: immutableArray((entry.bindClasses || []).map(value => String(value))),
        bindAddresses: immutableArray((entry.bindAddresses || []).map(value => String(value))),
        dynamicBindSet,
        exactOwners: entry.exactOwners ? immutableArray(entry.exactOwners.map(value => String(value)).sort()) : null,
        minMatches: minimum,
        maxMatches: maximum,
    });
}

function compileForbidden(entry, index) {
    const portSet = compilePorts(entry, `forbiddenSockets[${index}]`);
    return Object.freeze({
        ...entry,
        ...portSet,
        namespacePattern: compilePattern(entry.namespacePattern, `forbiddenSockets[${index}].namespacePattern`),
        protocols: immutableArray((entry.protocols || []).map(value => String(value).toLowerCase())),
    });
}

export function compileListenerProfile(profile) {
    validateProfileShape(profile);
    const requiredContainers = profile.requiredContainers.map(compileRequiredContainer);
    const rules = profile.rules.map(compileRule);
    const ids = new Set();
    for (const entry of [...requiredContainers, ...rules]) {
        if (ids.has(entry.id)) throw new Error(`listener profile id '${entry.id}' is duplicated`);
        ids.add(entry.id);
    }
    return Object.freeze({
        ...profile,
        id: String(profile.id),
        requireManagedContainers: profile.requireManagedContainers !== false,
        rejectAdditionalContainers: profile.rejectAdditionalContainers !== false,
        requireProcessOwners: profile.requireProcessOwners !== false,
        controlPorts: immutableArray(profile.controlPorts.map((port, index) => (
            parsePort(port, `controlPorts[${index}]`)
        ))),
        requiredContainers: immutableArray(requiredContainers),
        rules: immutableArray(rules),
        forbiddenSockets: immutableArray(profile.forbiddenSockets.map(compileForbidden)),
    });
}

export function loadListenerProfile(filePath) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`cannot load listener profile '${filePath}': ${error.message}`);
    }
    return compileListenerProfile(parsed);
}

function portMatches(record, entry) {
    if (!entry.ports.length && !entry.portRanges.length) return true;
    return entry.ports.includes(record.port)
        || entry.portRanges.some(range => record.port >= range.start && record.port <= range.end);
}

function entryMatchesSocket(record, entry) {
    return (!entry.namespacePattern || entry.namespacePattern.test(record.namespace))
        && (!entry.protocols.length || entry.protocols.includes(record.protocol))
        && portMatches(record, entry);
}

function exactStringSet(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containersForPattern(containers, pattern) {
    if (!pattern) return [];
    return containers.filter(container => pattern.test(container.name));
}

function listenerMatchesRule(record, rule, containers, managedGateways) {
    if (!entryMatchesSocket(record, rule)) return false;
    if (rule.containerPattern && !rule.containerPattern.test(String(record.containerName || ''))) return false;
    if (rule.bindClasses.length && !rule.bindClasses.includes(record.bindClass)) return false;
    if (rule.bindAddresses.length && !rule.bindAddresses.includes(record.bindAddress)) return false;
    if (rule.dynamicBindSet === 'loopback-and-managed-gateways'
        && record.bindAddress !== '127.0.0.1'
        && !managedGateways.has(record.bindAddress)) return false;
    if (rule.ownerPattern && !record.ownerProcesses.some(owner => rule.ownerPattern.test(owner))) return false;
    if (rule.exactOwners && !exactStringSet([...record.ownerProcesses].sort(), rule.exactOwners)) return false;
    if (rule.ownerContainerPattern) {
        const candidates = containersForPattern(containers, rule.ownerContainerPattern);
        if (candidates.length !== 1 || !record.ownerPids.length) return false;
        const allowedPids = new Set(candidates[0].pids);
        if (!record.ownerPids.every(pid => allowedPids.has(pid))) return false;
    }
    return true;
}

function socketDescription(record) {
    const owners = record.ownerProcesses.join(',') || '<unknown>';
    return `${record.namespace} ${record.protocol} ${record.bindAddress}:${record.port} owner=${owners}`;
}

function annotateEffectiveInstance(record, containers, requiredMatches, rule) {
    if (rule.effectiveInstance) return String(rule.effectiveInstance);
    const container = record.containerName
        ? containers.find(candidate => candidate.name === record.containerName)
        : containers.find(candidate => candidate.pids.some(pid => record.ownerPids.includes(pid)));
    if (!container) return 'ploinky-core';
    const matched = requiredMatches.find(entry => entry.containers.includes(container));
    return matched?.definition?.effectiveInstance || `container:${container.name}`;
}

export function validateListenerInventory({ listeners, containers, managedNetworks = [] }, inputProfile) {
    const profile = inputProfile?.rules?.[0]?.namespacePattern instanceof RegExp
        ? inputProfile
        : compileListenerProfile(inputProfile);
    const normalizedListeners = [...(listeners || [])];
    const normalizedContainers = [...(containers || [])];
    const normalizedManagedNetworks = [...(managedNetworks || [])];
    const errors = [];
    const managedGateways = new Set();
    for (const network of normalizedManagedNetworks) {
        const gateway = String(network?.gateway || '');
        if (!gateway) {
            errors.push(`managed network '${network?.name || '<unknown>'}' has no gateway evidence`);
        } else if (managedGateways.has(gateway)) {
            errors.push(`managed gateway '${gateway}' appears more than once`);
        } else {
            managedGateways.add(gateway);
        }
    }
    const requiredMatches = profile.requiredContainers.map((definition) => {
        const matches = normalizedContainers.filter(container => (
            definition.namePattern?.test(container.name)
            && (!definition.networkModePattern || definition.networkModePattern.test(container.networkMode))
        ));
        if (matches.length < definition.minMatches || matches.length > definition.maxMatches) {
            errors.push(
                `required container '${definition.id}' expected ${definition.minMatches}..${definition.maxMatches}, found ${matches.length}`,
            );
        }
        return Object.freeze({ definition, containers: immutableArray(matches) });
    });

    const knownContainers = new Set(requiredMatches.flatMap(entry => entry.containers));
    const containersByName = new Map();
    const containersByPidNamespace = new Map();
    for (const container of normalizedContainers) {
        if (containersByName.has(container.name)) {
            errors.push(`nested container name '${container.name}' appears more than once`);
        } else {
            containersByName.set(container.name, container);
        }
        if (containersByPidNamespace.has(container.pidNamespace)) {
            errors.push(
                `nested containers '${containersByPidNamespace.get(container.pidNamespace).name}' and '${container.name}' share PID namespace '${container.pidNamespace}'`,
            );
        } else {
            containersByPidNamespace.set(container.pidNamespace, container);
        }
        if (profile.requireManagedContainers && !container.managed) {
            errors.push(`nested container '${container.name}' lacks io.assistos.ploinky.managed=1`);
        }
        if (profile.rejectAdditionalContainers && !knownContainers.has(container)) {
            errors.push(`unexpected nested container '${container.name}' (${container.networkMode})`);
        }
    }

    const ruleMatches = new Map(profile.rules.map(rule => [rule.id, []]));
    const annotated = [];
    for (const record of normalizedListeners) {
        if (profile.requireProcessOwners && (!record.ownerProcesses.length || !record.ownerPids.length)) {
            errors.push(
                `${socketDescription(record)} has no owner PID/process; run ss as container root with procfs visibility`,
            );
        }
        if (record.containerName) {
            const container = containersByName.get(record.containerName);
            if (!container) {
                errors.push(
                    `${socketDescription(record)} is attributed to unknown nested container '${record.containerName}'`,
                );
                continue;
            }
            const allowedPids = new Set(container.pids);
            const foreignPids = record.ownerPids.filter(pid => !allowedPids.has(pid));
            if (foreignPids.length) {
                errors.push(
                    `${socketDescription(record)} owner PID(s) ${foreignPids.join(',')} do not belong to exact nested container '${container.name}'`,
                );
                continue;
            }
        }
        const forbidden = profile.forbiddenSockets.find(entry => entryMatchesSocket(record, entry));
        if (forbidden) {
            errors.push(`${socketDescription(record)} matches forbidden socket '${forbidden.id || 'unnamed'}'`);
            continue;
        }
        const rule = profile.rules.find(candidate => listenerMatchesRule(
            record,
            candidate,
            normalizedContainers,
            managedGateways,
        ));
        if (!rule) {
            const boundary = record.bindClass === 'wildcard'
                ? 'unexpected wildcard listener'
                : profile.controlPorts.includes(record.port)
                    ? 'unexpected control listener'
                    : 'unreviewed listener';
            errors.push(`${boundary}: ${socketDescription(record)}`);
            continue;
        }
        if ((record.bindClass === 'wildcard' || profile.controlPorts.includes(record.port))
            && rule.reviewedSensitive !== true) {
            errors.push(`sensitive socket matched non-sensitive rule '${rule.id}': ${socketDescription(record)}`);
            continue;
        }
        ruleMatches.get(rule.id).push(record);
        annotated.push(Object.freeze({
            ...record,
            ownerProcess: record.ownerProcesses.join(','),
            effectiveInstance: annotateEffectiveInstance(
                record,
                normalizedContainers,
                requiredMatches,
                rule,
            ),
            ruleId: rule.id,
            rationale: rule.rationale,
        }));
    }

    for (const rule of profile.rules) {
        const matches = ruleMatches.get(rule.id);
        if (matches.length < rule.minMatches || matches.length > rule.maxMatches) {
            errors.push(
                `listener rule '${rule.id}' expected ${rule.minMatches}..${rule.maxMatches}, found ${matches.length}`,
            );
        }
        if (rule.exclusiveSocket) {
            const candidates = normalizedListeners.filter(record => entryMatchesSocket(record, rule));
            if (candidates.length !== matches.length) {
                errors.push(`listener rule '${rule.id}' is not exclusive across its protocol/port selector`);
            }
        }
        if (rule.dynamicBindSet === 'loopback-and-managed-gateways') {
            const expected = ['127.0.0.1', ...managedGateways].sort();
            const actual = matches.map(record => record.bindAddress).sort();
            if (!exactStringSet(actual, expected)) {
                errors.push(
                    `listener rule '${rule.id}' expected exact bind set ${expected.join(',')}, found ${actual.join(',') || '<none>'}`,
                );
            }
        }
    }

    annotated.sort((left, right) => (
        left.namespace.localeCompare(right.namespace)
        || left.protocol.localeCompare(right.protocol)
        || left.port - right.port
        || left.bindAddress.localeCompare(right.bindAddress)
    ));
    return Object.freeze({
        ok: errors.length === 0,
        profileId: profile.id,
        errors: immutableArray(errors),
        listeners: immutableArray(annotated),
        containers: immutableArray(normalizedContainers),
        managedNetworks: immutableArray(normalizedManagedNetworks),
    });
}

export function formatListenerInventory(validation) {
    return validation.listeners.map(record => JSON.stringify({
        namespace: record.namespace,
        protocol: record.protocol,
        bindAddress: record.bindAddress,
        port: record.port,
        ownerProcess: record.ownerProcess,
        ownerPids: record.ownerPids,
        effectiveInstance: record.effectiveInstance,
        rationale: record.rationale,
    })).join('\n');
}
