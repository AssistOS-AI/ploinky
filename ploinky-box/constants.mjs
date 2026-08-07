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
});

export const BOX_ROLES = Object.freeze({
    container: 'box',
    images: 'images',
    dependencies: 'ploinky-deps',
});

export const BOX_VOLUME_KEYS = Object.freeze([
    'images',
    'dependencies',
]);

export const BOX_RUNTIME_UID = 1000;
export const BOX_RUNTIME_GID = 1000;
export const BOX_USERNS = `keep-id:uid=${BOX_RUNTIME_UID},gid=${BOX_RUNTIME_GID}`;
