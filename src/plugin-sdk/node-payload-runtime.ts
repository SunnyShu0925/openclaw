// Re-exports the shared paired-node payload unwrap helper for plugins.
// Core (src/plugins/session-catalog-family.ts) imports the normalization-core
// subpath directly; bundled extensions import through this SDK subpath per the
// extensions boundary (extensions/AGENTS.md).

export { unwrapNodePayloadJSON } from "@openclaw/normalization-core/node-payload";
