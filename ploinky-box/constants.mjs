export const BOX_IMAGE_REFERENCE = 'docker.io/assistos/ploinky-box:latest';
export const BOX_IMAGE_OVERRIDE_ENV = 'PLOINKY_BOX_IMAGE';

export function resolveBoxImageReference(env = process.env) {
    const configured = env?.[BOX_IMAGE_OVERRIDE_ENV];
    if (configured === undefined || configured === '') return BOX_IMAGE_REFERENCE;
    if (typeof configured !== 'string' || configured.trim() !== configured || /\s/u.test(configured)) {
        throw new TypeError(
            `${BOX_IMAGE_OVERRIDE_ENV} must be a nonempty image reference without whitespace`,
        );
    }
    return configured;
}
export const BOX_ROUTER_CONTAINER_PORT = 8080;
export const BOX_MEDIA_PORT = 7882;
export const BOX_READY_LINE = 'PLOINKY_BOX_READY';
export const BOX_MARKER_PATH = '/etc/ploinky-box';
export const BOX_MARKER_CONTENT = 'assistos/ploinky-box\n';
export const BOX_ROUTER_HEALTH_SOCKET = '/run/ploinky/router-health.sock';

export const BOX_LABELS = Object.freeze({
    pathHash: 'io.assistos.ploinky-box.path-hash',
    role: 'io.assistos.ploinky-box.role',
    imageRef: 'io.assistos.ploinky-box.image-ref',
    routerHostPort: 'io.assistos.ploinky-box.router-host-port',
    mediaHostPort: 'io.assistos.ploinky-box.media-host-port',
    seccompFingerprint: 'io.assistos.ploinky-box.seccomp-fingerprint',
    dependenciesFingerprint: 'io.assistos.ploinky-box.dependencies-fingerprint',
    imagesFingerprint: 'io.assistos.ploinky-box.images-fingerprint',
});

// The broad writable workspace bind. The selected achillesAgentLib source lives
// inside it, so its alias there needs an explicit read-only shadow.
export const BOX_WORKSPACE_MOUNT = '/workspace';

// achillesAgentLib is direct-mounted from the one selected workspace source.
// The Box never installs its own copy. `/opt/ploinky/node_modules` is the
// workspace-backed cache where the image-bundled mcp-sdk is materialized.
export const BOX_AGENTLIB_LABELS = Object.freeze({
    mode: 'io.assistos.ploinky-box.agentlib-mode',
    sourceIdHash: 'io.assistos.ploinky-box.agentlib-source-id',
    fingerprint: 'io.assistos.ploinky-box.agentlib-fingerprint',
    sourceRelativePath: 'io.assistos.ploinky-box.agentlib-source-path',
    commit: 'io.assistos.ploinky-box.agentlib-commit',
});

export const BOX_ROLES = Object.freeze({
    container: 'box',
});

// Box persistence lives in the workspace itself, under `.ploinky/box`. The
// keys, host-relative names, and in-Box mount destinations are one contract so
// identity, mount rendering, and the entrypoint cannot drift apart.
export const BOX_DATA_KEYS = Object.freeze([
    'dependencies',
    'images',
]);

export const BOX_DATA_ROOT_NAME = 'box';

export const BOX_DATA_RELATIVE_NAMES = Object.freeze({
    dependencies: 'dependencies',
    images: 'images',
});

export const BOX_DATA_MOUNTS = Object.freeze({
    dependencies: '/opt/ploinky/node_modules',
    images: '/home/podman/.local/share/ploinky-images',
});

export const BOX_DATA_FINGERPRINT_LABELS = Object.freeze({
    dependencies: BOX_LABELS.dependenciesFingerprint,
    images: BOX_LABELS.imagesFingerprint,
});

export const BOX_RUNTIME_UID = 1000;
export const BOX_RUNTIME_GID = 1000;
export const BOX_USERNS = `keep-id:uid=${BOX_RUNTIME_UID},gid=${BOX_RUNTIME_GID}`;

// The outer Box keeps durable state in explicit host binds. Nested runtime
// metadata is instead confined to a fresh filesystem for each outer boot.
export const BOX_TMPFS = Object.freeze({
    destination: '/tmp',
    options: Object.freeze([
        'rw',
        'exec',
        'nosuid',
        'nodev',
        'mode=1777',
        'notmpcopyup',
    ]),
});
