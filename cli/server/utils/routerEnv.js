import { resolvePersistedRouterPort } from '../../services/routerPort.js';

const COMPONENTS = {
  webchat: { label: 'WebChat', path: '/webchat', administratorOnly: false },
  dashboard: { label: 'Dashboard', path: '/dashboard', administratorOnly: true }
};

function getRouterPort() {
  return resolvePersistedRouterPort();
}

function printComponentAccess(component, { quiet } = {}) {
  const spec = COMPONENTS[component];
  if (!spec) throw new Error(`Unknown component '${component}'`);
  if (quiet) return null;
  const port = getRouterPort();
  console.log(`✓ ${spec.label} uses the Router authentication session.`);
  console.log(`  Visit: http://127.0.0.1:${port}${spec.path}`);
  console.log(spec.administratorOnly
    ? '  Sign in with a workspace administrator account.'
    : '  Sign in with your workspace account.');
  return null;
}

export {
  COMPONENTS,
  getRouterPort,
  printComponentAccess
};
