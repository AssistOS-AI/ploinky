import {
    createCloudflaredRouterIntegration as createRouterIntegration,
} from './routerIntegration.mjs';
import { startCloudflarePublicationRuntime } from './runtime.mjs';

export function createCloudflaredRouterIntegration(options = {}) {
    return createRouterIntegration({
        ...options,
        runtimeFactory: options.runtimeFactory || startCloudflarePublicationRuntime,
    });
}

export { startCloudflarePublicationRuntime };
