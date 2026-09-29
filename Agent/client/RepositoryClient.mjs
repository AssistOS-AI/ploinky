import { requestMarketplace } from './AgentMcpClient.mjs';

export function createRepositoryClient({ descriptor, request = requestMarketplace } = {}) {
    return Object.freeze({
        async listRepositories() { return (await request('GET', null, descriptor, 'list-repos')).repositories; },
        async prepareRepository({ url, name, branch }) {
            await request('POST', { action: 'install_repo', url, name, branch }, descriptor, 'repos');
            return this.listRepositories();
        },
        async install(input) { const response = await request('POST', { action: 'install', ...input }, descriptor, 'repos', { raw: true }); return response.result || response; },
        async remove(paths) { const response = await request('POST', { action: 'remove', paths }, descriptor, 'repos', { raw: true }); return response.result || response; },
    });
}
