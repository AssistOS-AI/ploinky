import { PloinkyBoxError } from '../errors.mjs';

export const PASTA_IPV4_NETWORK = 'pasta:--ipv4-only';

function networkError() {
    return new PloinkyBoxError('Owned Box network mode does not match its recorded IPv4-only pasta contract', {
        code: 'PLOINKY_BOX_NETWORK_INVALID',
    });
}

export function selectedBoxNetworkMode({ hostKind, rootlessNetworkCmd } = {}) {
    return hostKind === 'native-linux' && rootlessNetworkCmd === 'pasta' ? PASTA_IPV4_NETWORK : null;
}

// No explicit network option is the predecessor's engine-default contract.
// Keep it observable for status, teardown and exact rollback; reconciliation
// replaces it before starting a graph under the IPv4-only pasta policy.
export function observedBoxNetworkMode(runtime) {
    const modes = [];
    const args = runtime?.createCommand || [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--network' || args[index] === '--net') {
            modes.push(args[++index]);
        } else if (args[index].startsWith('--network=') || args[index].startsWith('--net=')) {
            modes.push(args[index].slice(args[index].indexOf('=') + 1));
        }
    }
    if (modes.length === 0) return null;
    if (modes.length !== 1 || modes[0] !== PASTA_IPV4_NETWORK || runtime.networkMode !== 'pasta') {
        throw networkError();
    }
    return PASTA_IPV4_NETWORK;
}

export function assertBoxNetworkMode(runtime, expectedMode = observedBoxNetworkMode(runtime)) {
    if (![null, PASTA_IPV4_NETWORK].includes(expectedMode)
        || observedBoxNetworkMode(runtime) !== expectedMode) throw networkError();
}
