import crypto from 'crypto';
import * as envSvc from '../../services/secretVars.js';
import { resolvePersistedRouterPort } from '../../services/routerPort.js';

const COMPONENTS = {
  webchat: { label: 'WebChat', path: '/webchat', authMode: 'login' },
  dashboard: { varName: 'WEBDASHBOARD_TOKEN', label: 'Dashboard', path: '/dashboard', authMode: 'token' }
};

function getRouterPort() {
  return resolvePersistedRouterPort();
}

function maskToken(token) {
  if (typeof token !== 'string') return '';
  return token.slice(0, 5);
}

function printLoginSurface(spec, { quiet } = {}) {
  if (quiet) return null;
  const port = getRouterPort();
  console.log(`✓ ${spec.label} uses router login.`);
  console.log(`  Visit: http://127.0.0.1:${port}${spec.path}`);
  console.log('  Sign in with your workspace account.');
  return null;
}

function refreshComponentToken(component, { quiet } = {}) {
  const spec = COMPONENTS[component];
  if (!spec) throw new Error(`Unknown component '${component}'`);
  if (spec.authMode !== 'token') {
    return printLoginSurface(spec, { quiet });
  }
  const token = crypto.randomBytes(32).toString('hex');
  envSvc.setEnvVar(spec.varName, token);
  if (!quiet) {
    const port = getRouterPort();
    console.log(`✓ ${spec.label} token refreshed (${maskToken(token)}…).`);
    console.log(`  Visit: http://127.0.0.1:${port}${spec.path}?token=<stored in ${spec.varName} in .ploinky/.secrets>`);
  }
  return token;
}

function getComponentToken(component) {
  const spec = COMPONENTS[component];
  if (!spec) throw new Error(`Unknown component '${component}'`);
  if (spec.authMode !== 'token' || !spec.varName) {
    return null;
  }
  try {
    const val = envSvc.resolveVarValue(spec.varName);
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  } catch (_) {}
  return null;
}

function ensureComponentToken(component, { quiet } = {}) {
  const spec = COMPONENTS[component];
  if (!spec) throw new Error(`Unknown component '${component}'`);
  if (spec.authMode !== 'token') {
    return printLoginSurface(spec, { quiet });
  }
  const existing = getComponentToken(component);
  if (existing) {
    if (!quiet) {
      const port = getRouterPort();
      console.log(`✓ ${spec.label} token ready (${maskToken(existing)}…).`);
      console.log(`  Visit: http://127.0.0.1:${port}${spec.path}?token=<stored in ${spec.varName} in .ploinky/.secrets>`);
    }
    return existing;
  }
  return refreshComponentToken(component, { quiet });
}

export {
  COMPONENTS,
  getRouterPort,
  refreshComponentToken,
  ensureComponentToken,
  getComponentToken
};
