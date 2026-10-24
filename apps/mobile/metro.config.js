/**
 * Metro, reaching the shared domain package from outside this app's own tree.
 *
 * apps/mobile is a standalone project rather than an npm workspace — React
 * Native refuses to run unless React matches its renderer exactly, and the web
 * app pins a different 19.2 release — so the only thing it shares with the rest
 * of the monorepo is source: `@dash/domain`, installed as a `file:` link.
 *
 * Two adjustments make that work, and nothing else is changed:
 *
 * 1. `watchFolders` includes packages/domain, so Metro will bundle files that
 *    live outside the project root. Only that folder — watching the whole
 *    repository would put apps/web's build output and a second node_modules
 *    under the file watcher for no benefit.
 *
 * 2. The domain package is written for Node's ESM resolution and names its
 *    siblings by their compiled filename (`./index.js`) while the source on
 *    disk is `.ts`. TypeScript maps one to the other; Metro does not. For
 *    relative imports inside packages/domain only, a `.js` request that has no
 *    file is retried as `.ts`. Nothing in the app itself is affected.
 *
 * The app's own node_modules is searched first, so anything shared resolves to
 * the React Native side's version, never the web app's.
 */

const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..', '..');
const domainRoot = path.join(repoRoot, 'packages', 'domain');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [domainRoot];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(repoRoot, 'node_modules'),
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromDomain = context.originModulePath.startsWith(domainRoot + path.sep);
  if (fromDomain && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Not a TypeScript sibling after all — fall through to the default.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
