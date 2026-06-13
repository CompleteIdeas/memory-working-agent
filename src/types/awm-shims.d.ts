// agent-working-memory ships JS in dist/ without type declarations.
// We import the proven deep paths (mirroring USEA's EmbeddedAWM). Declare them
// as untyped modules so tsc accepts the imports; we wrap them with our own
// types in src/awm.ts.
declare module 'agent-working-memory/dist/storage/sqlite.js';
declare module 'agent-working-memory/dist/engine/activation.js';
declare module 'agent-working-memory/dist/engine/connections.js';
declare module 'agent-working-memory/dist/core/write-pipeline.js';
declare module 'agent-working-memory/dist/core/embeddings.js';
