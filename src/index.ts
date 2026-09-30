/**
 * grugbrain: library entry. Everything the CLI uses is importable.
 */

export * from './config.js';
export * from './tokens.js';
export * from './stats.js';
export * from './compress/caveman.js';
export * from './compress/trim.js';
export * from './compress/skeleton.js';
export * from './compress/repomap.js';
export * from './proxy/transform.js';
export { startProxy, proxyHealth } from './proxy/server.js';
export * from './memory/store.js';
export * from './memory/brief.js';
export * from './memory/vault.js';
export * from './memory/graphhtml.js';
export * from './memory/maintain.js';
export { handleMessage, callTool, callToolRich, findSymbol } from './mcp.js';
export { install, uninstall, health } from './install.js';
export { applyCommandRules } from "./compress/cmdrules.js"; export { compactJson } from "./compress/jsoncompact.js";
