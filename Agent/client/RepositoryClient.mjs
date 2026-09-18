import { requestMarketplace } from './AgentMcpClient.mjs';

export function createRepositoryClient({ descriptor, request = requestMarketplace } = {}) {
    return Object.freeze({
        async listRepositories() { return (await request('GET', null, descriptor, 'list-repos')).repositories; },
        async prepareRepository({ url, name, branch }) {
            await request('POST', { action: 'install_repo', url, name, branch }, descriptor);
            return this.listRepositories();
        },
        install(input) { return request('POST', input, descriptor, 'install'); },
        remove(paths) { return request('POST', paths, descriptor, 'remove'); },
    });
}
