import { defineConfig, configDefaults } from 'vitest/config';

// Many tests start real processes (node, git, PowerShell, reg.exe). Under a full parallel run on a
// 16-thread machine, vitest's 5 s default failed one to seven of them a run, a different few each time,
// every one passing alone (BL-33, 2026-10-18). A hung test still fails, at 20 s.
// eval/ holds the promise-assessment harness; its checks are plain node scripts (`node eval/world.test.mjs`),
// which vitest picked up by name and failed as "no test suite found" (BL-40).
// vendor/ is AWM's own suite, gated by AWM's CI: since the 0.19/0.20 pins its model-daemon and MCPB packaging
// tests need things MWA's run does not have (import.meta.resolve under vitest's module runner, the mcpb CLI) and
// kept master red. MWA's own tests exercise the vendored AWM through src/awm.ts.
export default defineConfig({ test: { testTimeout: 20_000, exclude: [...configDefaults.exclude, 'eval/**', 'vendor/**'] } });
