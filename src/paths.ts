/**
 * Where MWA's runtime files live — one answer, asked at call time.
 *
 * Usability review 2026-10-24 (F16): every default was `resolve('./data/…')` against the current directory, each
 * behind its own env var (MWA_DB, MWA_RUNLOG, MWA_NOTIFY, MWA_LOG, …), and `MWA_ROOT`/`MWA_HOME` from the
 * configuration docs were read by nothing. A server started from the repo folder wrote its run log, token log and
 * mwa.log into the repo's `data/`, beside another experiment's. Now one setting places them all:
 *
 *   MWA_DATA_DIR            the data folder itself
 *   MWA_ROOT / MWA_HOME     a home folder; the data folder is `<home>/data`
 *   (neither)               `./data`, as before
 *
 * The per-file vars still win when set (Docker and the desktop app set them), so nothing already deployed moves.
 * `.env` and `mwa.config.json` are configuration, not runtime data, and keep their own rules (MWA_ENV_PATH,
 * MWA_CONFIG_PATH).
 */
import { resolve, join } from 'node:path';

type Env = Record<string, string | undefined>;

/** The runtime data folder, absolute. */
export function dataDir(env: Env = process.env): string {
  if (env.MWA_DATA_DIR) return resolve(env.MWA_DATA_DIR);
  const home = env.MWA_ROOT ?? env.MWA_HOME;
  return home ? resolve(home, 'data') : resolve('./data');
}

/** The memory store (SQLite file). */
export const dbFile = (env: Env = process.env): string => env.MWA_DB ?? join(dataDir(env), 'agent.db');
/** One line per finished run. Several other files sit beside it (conversations, tokens, thoughts, transcripts). */
export const runLogPath = (env: Env = process.env): string => env.MWA_RUNLOG ?? join(dataDir(env), 'runs.jsonl');
/** Results of scheduled jobs for the app's feed; receipts and held messages sit beside it. */
export const notifyPath = (env: Env = process.env): string => env.MWA_NOTIFY ?? join(dataDir(env), 'notifications.jsonl');
/** The operator log (JSON lines). */
export const mwaLogPath = (env: Env = process.env): string => env.MWA_LOG ?? join(dataDir(env), 'mwa.log');
/** Connector and MCP installs. */
export const installLogPath = (env: Env = process.env): string => env.MWA_INSTALL_LOG ?? join(dataDir(env), 'installs.jsonl');
/** The secrets vault. */
export const vaultPath = (env: Env = process.env): string => env.MWA_VAULT_PATH ?? join(dataDir(env), 'vault.json');
/** Browser profiles, one folder per person under it. */
export const browserDir = (env: Env = process.env): string => env.MWA_BROWSER_DIR ?? join(dataDir(env), 'browser');
