const DEFAULT_PROTOCOL = 'tcp';
const MANIFEST_PROTOCOLS = new Set(['tcp', 'udp']);
const PROTOCOL_TOKEN = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

export function parseExplicitPublishSpec(value) {
    const raw = String(value ?? '');
    const input = raw.trim();
    if (!input) {
        throw new Error('empty value');
    }

    const { addressSpec, protocol } = splitTerminalProtocol(input);
    const parts = addressSpec.split(':');
    let hostIp = '';
    let hostPortSpec = '';
    let containerPortSpec = '';
    if (parts.length === 1) {
        [containerPortSpec] = parts;
    } else if (parts.length === 2) {
        [hostPortSpec, containerPortSpec] = parts;
    } else if (parts.length === 3) {
        [hostIp, hostPortSpec, containerPortSpec] = parts;
    } else {
        throw new Error('wrong segment count');
    }

    const containerTarget = parsePortRange(containerPortSpec);
    let hostInterval = null;
    if (hostPortSpec) {
        hostInterval = parsePortRange(hostPortSpec, { allowZero: true });
        const isEphemeralSinglePort = hostInterval.start === 0 && hostInterval.end === 0;
        if (!isEphemeralSinglePort && hostInterval.length !== containerTarget.length) {
            throw new Error('host and container range lengths must match');
        }
    }

    return {
        raw,
        hostIp,
        hostPortSpec,
        containerPortSpec,
        protocol,
        hostInterval,
        containerTarget,
        target: `${formatPortRange(containerTarget)}/${protocol}`,
    };
}

export function parseManifestOpenPortSpec(value) {
    const raw = String(value ?? '').trim();
    try {
        if (!raw) {
            throw new Error('empty value');
        }

        const { addressSpec, protocol } = splitTerminalProtocol(raw);
        if (!MANIFEST_PROTOCOLS.has(protocol)) {
            throw new Error(`unsupported protocol '${protocol}'`);
        }

        const parts = addressSpec.split(':');
        let hostIp = '127.0.0.1';
        let hostPortSpec = '';
        let containerPortSpec = '';
        if (parts.length === 1) {
            [hostPortSpec] = parts;
            containerPortSpec = hostPortSpec;
        } else if (parts.length === 2) {
            [hostPortSpec, containerPortSpec] = parts;
        } else if (parts.length === 3) {
            [hostIp, hostPortSpec, containerPortSpec] = parts;
        } else {
            throw new Error('wrong segment count');
        }

        const boxSide = parsePortRange(hostPortSpec, { allowZero: true });
        if (boxSide.start === 0) {
            throw new Error('host port 0 is not valid for outer box publish');
        }
        const privateContainer = parsePortRange(containerPortSpec);
        if (boxSide.length !== privateContainer.length) {
            throw new Error('host and container range lengths must match');
        }

        const normalizedBoxSide = formatPortRange(boxSide);
        const normalizedPrivateContainer = formatPortRange(privateContainer);
        const bindClass = isWildcardBind(hostIp) ? 'wildcard' : 'specific';
        const suffix = protocol === DEFAULT_PROTOCOL ? '' : `/${protocol}`;
        return {
            raw,
            spec: `${hostIp}:${normalizedBoxSide}:${normalizedBoxSide}${suffix}`,
            hostIp,
            bindClass,
            hostPortSpec: normalizedBoxSide,
            containerPortSpec: normalizedPrivateContainer,
            protocol,
            target: `${normalizedBoxSide}/${protocol}`,
            boxSide,
            privateContainer,
        };
    } catch (error) {
        const message = error?.message || String(error);
        if (message.startsWith('invalid openPorts publish spec')) {
            throw error;
        }
        throw new Error(`invalid openPorts publish spec '${raw}': ${message}`);
    }
}

export function intervalsOverlap(left, right) {
    return left.start <= right.end && right.start <= left.end;
}

export function formatPortRange(range) {
    return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

export function manifestClaimsEqual(left, right) {
    return left.protocol === right.protocol
        && bindIdentity(left) === bindIdentity(right)
        && left.boxSide.start === right.boxSide.start
        && left.boxSide.end === right.boxSide.end
        && left.privateContainer.start === right.privateContainer.start
        && left.privateContainer.end === right.privateContainer.end;
}

function splitTerminalProtocol(input) {
    const slashIndex = input.lastIndexOf('/');
    if (slashIndex === -1) {
        return { addressSpec: input, protocol: DEFAULT_PROTOCOL };
    }

    const addressSpec = input.slice(0, slashIndex);
    const rawProtocol = input.slice(slashIndex + 1);
    if (addressSpec.includes('/')) {
        throw new Error('conflicting protocols or too many protocol suffixes');
    }
    if (!PROTOCOL_TOKEN.test(rawProtocol)) {
        throw new Error(`invalid protocol '${rawProtocol}'`);
    }
    return {
        addressSpec,
        protocol: rawProtocol.toLowerCase(),
    };
}

function parsePortRange(value, { allowZero = false } = {}) {
    const raw = String(value ?? '').trim();
    const match = raw.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
        throw new Error(`invalid port range '${raw}'`);
    }

    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    const minimum = allowZero ? 0 : 1;
    if (
        !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || start < minimum
        || end < minimum
        || end < start
        || start > 65535
        || end > 65535
    ) {
        throw new Error(`invalid port range '${raw}'`);
    }
    return {
        start,
        end,
        length: end - start + 1,
    };
}

function isWildcardBind(hostIp) {
    const normalized = String(hostIp ?? '').trim().toLowerCase();
    return normalized === '' || normalized === '0.0.0.0' || normalized === '*';
}

function bindIdentity(claim) {
    if (claim.bindClass === 'wildcard') {
        return 'wildcard';
    }
    return String(claim.hostIp || '').trim().toLowerCase();
}
