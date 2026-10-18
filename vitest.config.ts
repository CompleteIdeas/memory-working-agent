import { defineConfig } from 'vitest/config';

// Many tests start real processes (node, git, PowerShell, reg.exe). Under a full parallel run on a
// 16-thread machine, vitest's 5 s default failed one to seven of them a run, a different few each time,
// every one passing alone (BL-33, 2026-10-18). A hung test still fails, at 20 s.
export default defineConfig({ test: { testTimeout: 20_000 } });
