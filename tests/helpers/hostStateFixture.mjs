// Host-state test fixtures shared by the Box supervisor and lifecycle suites.

import { BOX_DATA_MOUNTS } from '../../ploinky-box/constants.mjs';
import { checkoutShadowMount } from '../../ploinky-box/contract/checkoutAlias.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { hostStateMaskMount } from '../../ploinky-box/hostState/root.mjs';

/**
 * A host-state guard that checks nothing: for suites that exercise other
 * supervisor behaviour with a fake engine. The guard itself is covered by
 * ploinkyBoxHostStateGuard.test.mjs and the supervisor cases there.
 */
export const PERMISSIVE_HOST_STATE_GUARD = Object.freeze({
    beforeLock() {},
    underLock() { return Object.freeze({ adopted: false, quarantine: null, moved: Object.freeze([]) }); },
    quiescence() { return []; },
    retireUnmaskedHostState() { return null; },
});

/** A quiescence seam for direct `reconcileBoxContainer` calls: nothing runs. */
export function quiescentEngine() {
    return [];
}

/**
 * The read-only binds every Box carries over its workspace bind: the host
 * state mask and, when the checkout lies inside the workspace, its shadow.
 */
export function hostStateFixtureMounts(workspaceRoot, repositoryRoot) {
    const mask = hostStateMaskMount(workspaceRoot);
    const shadow = repositoryRoot ? checkoutShadowMount(workspaceRoot, repositoryRoot) : null;
    return [
        { type: 'bind', name: '', source: mask.source, destination: mask.destination, rw: false },
        ...(shadow ? [{ type: 'bind', name: '', source: shadow.source, destination: shadow.destination, rw: false }] : []),
    ];
}

// The engine's view of a Box created with exactly `args`.
export function handleFromCreateArgs(args, id = 'e'.repeat(64)) {
    const values = (option) => args.flatMap((value, index) => (value === option ? [args[index + 1]] : []));
    const pairs = (option) => Object.fromEntries(values(option).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
    const tmpfs = values('--tmpfs')[0];
    const [tmpfsDestination, tmpfsOptions] = [tmpfs.slice(0, tmpfs.indexOf(':')), tmpfs.slice(tmpfs.indexOf(':') + 1)];
    return {
        id,
        labels: pairs('--label'),
        runtime: {
            complete: true,
            imageId: args.at(-1),
            configuredImage: args.at(-1),
            networkMode: '',
            user: values('--user')[0],
            workingDir: values('--workdir')[0],
            // The image supplies its own environment; the create adds the rest.
            environment: { ...IMAGE_CONTRACT.environment, ...pairs('--env'), HOSTNAME: id.slice(0, 12) },
            createCommand: ['podman', ...args],
            publications: values('--publish').map((entry) => {
                const [hostIp, hostPort, target] = entry.split(':');
                const [containerPort, protocol] = target.split('/');
                return { containerPort, protocol, hostIp, hostPort };
            }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
            running: true,
            status: 'running',
            init: args.includes('--init'),
            usernsMode: 'private',
            privileged: false,
            securityOptions: values('--security-opt').sort(),
            devices: values('--device').map((device) => ({ hostPath: device, containerPath: device, permissions: 'rwm' }))
                .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
            tmpfs: [{ destination: tmpfsDestination, options: [...tmpfsOptions.split(',').filter((option) => option !== 'notmpcopyup'), 'rprivate'].sort() }],
            mounts: values('--volume').map((volume) => {
                const [source, destination, options = ''] = volume.split(':');
                return { type: 'bind', name: '', source, destination, rw: options !== 'ro' };
            }).sort((left, right) => left.destination.localeCompare(right.destination)),
        },
    };
}

export { BOX_DATA_MOUNTS };
