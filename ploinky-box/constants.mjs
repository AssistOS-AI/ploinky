export const BOX_IMAGE_REFERENCE = 'docker.io/assistos/ploinky-box:runtime';
export const BOX_ROUTER_CONTAINER_PORT = 8080;
export const BOX_MEDIA_PORT = 7882;
export const BOX_READY_LINE = 'PLOINKY_BOX_READY';
export const BOX_MARKER_PATH = '/etc/ploinky-box';
export const BOX_MARKER_CONTENT = 'assistos/ploinky-box\n';

export const BOX_LABELS = Object.freeze({
    pathHash: 'io.assistos.ploinky-box.path-hash',
    role: 'io.assistos.ploinky-box.role',
    imageRef: 'io.assistos.ploinky-box.image-ref',
    routerHostPort: 'io.assistos.ploinky-box.router-host-port',
    mediaHostPort: 'io.assistos.ploinky-box.media-host-port',
});

export const BOX_ROLES = Object.freeze({
    container: 'box',
    workspace: 'workspace',
    containers: 'containers',
    dependencies: 'ploinky-deps',
});

export const BOX_VOLUME_KEYS = Object.freeze([
    'workspace',
    'containers',
    'dependencies',
]);
