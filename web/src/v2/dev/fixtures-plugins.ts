/**
 * Fixture mode for Settings › Plug-ins (v2 build, slice S1). Answers /plugins and its changes the way
 * src/api/routes/plugins.ts does, with the server's own words; the library mirrors src/connectors/registry.ts
 * (tests/web-v2-s1.test.ts holds the two together). Keys are kept as "saved" flags only — a value typed here is
 * dropped at once, as the server never sends one back.
 *
 * Scenarios: `npm-off` (adding from npm is turned off, with the reason); any other: available. The npm review says
 * "dangerous" for shady-mcp and "safe" for anything else. EVERYTHING HERE IS EXAMPLE DATA.
 */
import type { AddFromNpm, CustomPlugin, Plugin, PluginReview } from '../api/client';

type Resp = { status: number; body: unknown };
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const APPLIES = 'Changes take effect on your next message.';
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

type Entry = Omit<Plugin, 'on' | 'keys' | 'missing'> & { keys: { name: string; label: string; help: string | null; optional: boolean }[] };
export const FIXTURE_LIBRARY: Entry[] = [
  { id: 'search', name: 'Web search', category: 'Web', tier: 'curated', source: null, description: 'Search the web for current information.', access: 'Sends search queries to the web. No account, no files.',
    keys: [{ name: 'BRAVE_API_KEY', label: 'Brave Search API key', help: 'Optional — better results; without it, a keyless fallback is used.', optional: true }] },
  { id: 'fetch', name: 'Read web pages', category: 'Web', tier: 'curated', source: null, description: 'Open a link and read its text.', access: 'Fetches the specific URLs named. No account, no files.', keys: [] },
  { id: 'thinking', name: 'Step-by-step reasoning', category: 'Thinking', tier: 'curated', source: 'https://github.com/modelcontextprotocol/servers', description: 'A scratchpad that helps the agent work through hard problems in steps.', access: 'A private reasoning scratchpad. No accounts, no internet, no files.', keys: [] },
  { id: 'docs', name: 'Library & framework docs', category: 'Dev', tier: 'curated', source: 'https://github.com/upstash/context7', description: 'Look up current documentation for code libraries and frameworks.', access: 'Reads public documentation from the web. No account required.',
    keys: [{ name: 'CONTEXT7_API_KEY', label: 'Context7 API key', help: 'Optional — only for higher rate limits (context7.com).', optional: true }] },
  { id: 'browser', name: 'Web browser (automation)', category: 'Web', tier: 'curated', source: 'https://github.com/microsoft/playwright-mcp', description: 'Open web pages, click, fill forms, and read what a real browser sees.', access: 'Drives a headless browser to sites you point it at. Downloads a browser on first use. No account.', keys: [] },
  { id: 'github', name: 'GitHub', category: 'Dev', tier: 'curated', source: 'https://github.com/modelcontextprotocol/servers', description: 'Read and write repositories, issues, and pull requests.', access: 'Your GitHub, scoped to the personal access token you provide.',
    keys: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', help: 'Create one at github.com/settings/tokens (scope it to what you want the agent to do).', optional: false }] },
  { id: 'notion', name: 'Notion', category: 'Productivity', tier: 'curated', source: 'https://github.com/makenotion/notion-mcp-server', description: 'Read and write your Notion pages and databases.', access: 'Only the Notion pages/databases you share with the integration.',
    keys: [{ name: 'NOTION_TOKEN', label: 'Notion integration token', help: 'Create an internal integration at notion.so/my-integrations, then share the pages you want with it.', optional: false }] },
  { id: 'tavily', name: 'Web search (Tavily)', category: 'Web', tier: 'curated', source: 'https://github.com/tavily-ai/tavily-mcp', description: 'Higher-quality web search and page extraction.', access: 'Sends search queries to Tavily (your account). No files.',
    keys: [{ name: 'TAVILY_API_KEY', label: 'Tavily API key', help: 'Free key at tavily.com.', optional: false }] },
  { id: 'firecrawl', name: 'Website scraping', category: 'Web', tier: 'curated', source: 'https://github.com/mendableai/firecrawl-mcp-server', description: 'Scrape and crawl websites into clean text.', access: 'Fetches and crawls the sites you point it at (your Firecrawl account).',
    keys: [{ name: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', help: 'Key at firecrawl.dev.', optional: false }] },
];

export class PluginFixtures {
  on = new Set(['search', 'fetch', 'thinking']);
  saved = new Set(['NOTION_TOKEN']);
  custom: CustomPlugin[] = [
    { id: 'weather-mcp', command: 'npx -y weather-mcp@1.4.0', argsHidden: false, package: 'weather-mcp@1.4.0', envNames: [] },
    { id: 'barn-notes', command: 'node C:\\tools\\barn-notes.mjs --token •••', argsHidden: false, package: null, envNames: ['BARN_NOTES_TOKEN'] },
  ];
  /** S2: the reviewing model follows the brain picked in Settings › Your assistant (./fixtures-assistant.ts) */
  reviewer = 'openrouter:openai/gpt-6.1-sol';
  reviewerCapable = true;
  private reviews = new Map<string, { review: PluginReview; at: number }>();
  constructor(private scenario: string, private clock: () => number) {}

  private view(e: Entry): Plugin {
    const keys = e.keys.map((k) => ({ ...k, saved: this.saved.has(k.name) }));
    return { ...e, on: this.on.has(e.id), keys, missing: keys.filter((k) => !k.optional && !k.saved).map((k) => k.name) };
  }
  npm(): AddFromNpm {
    if (this.scenario === 'npm-off') return { available: false, reason: 'Installing connectors from outside the library is turned off (installPolicy: off).', reviewer: this.reviewer };
    if (!this.reviewerCapable) return { available: false, reason: `Installing connectors from outside the library needs a stronger reviewing model than "${this.reviewer}". Connect a capable model — an aggregator like OpenRouter, or an Anthropic/OpenAI key you already have — to enable it.`, reviewer: this.reviewer };
    return { available: true, reason: `Connectors from outside the library are reviewed by ${this.reviewer} before you approve them.`, reviewer: this.reviewer };
  }
  /** an admin sees each command with its arguments (masked); anyone else the command name only, as on the server */
  list(admin = true) {
    const custom = admin ? this.custom : this.custom.map((c) => ({ ...c, command: c.command.split(' ')[0], argsHidden: c.command.includes(' ') }));
    return { plugins: FIXTURE_LIBRARY.map((e) => this.view(e)), custom, addFromNpm: this.npm(), applies: APPLIES };
  }

  read(path: string, admin = true): Resp | null {
    return path === '/plugins' ? { status: 200, body: this.list(admin) } : null;
  }

  write(method: string, path: string, body: unknown): Resp | null {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    const entry = (id: string) => FIXTURE_LIBRARY.find((e) => e.id === id);
    if (method === 'POST' && (m = /^\/plugins\/([^/]+)\/(enable|disable)$/.exec(path))) {
      const e = entry(decodeURIComponent(m[1]));
      if (!e) return err(404, 'not_found', 'There is no plug-in with that name in the library.');
      if (m[2] === 'enable') {
        const v = this.view(e);
        if (v.missing.length) return err(409, 'needs_keys', `${e.name} needs ${e.keys.filter((k) => v.missing.includes(k.name)).map((k) => k.label).join(' and ')} first. Add it below, then turn it on.`);
        this.on.add(e.id);
        return { status: 200, body: { plugin: this.view(e), message: `${e.name} is on. ${APPLIES}` } };
      }
      this.on.delete(e.id);
      return { status: 200, body: { plugin: this.view(e), message: `${e.name} is off. ${APPLIES}` } };
    }
    if (method === 'PUT' && (m = /^\/plugins\/([^/]+)\/keys$/.exec(path))) {
      const e = entry(decodeURIComponent(m[1]));
      if (!e) return err(404, 'not_found', 'There is no plug-in with that name in the library.');
      const keys = b.keys as Record<string, unknown> | undefined;
      if (!keys || typeof keys !== 'object' || !Object.keys(keys).length) return err(400, 'bad_body', 'Send {"keys": {"NAME": "value"}} with the keys this plug-in asks for.');
      for (const [name, value] of Object.entries(keys)) {
        const k = e.keys.find((x) => x.name === name);
        if (!k) return err(400, 'unknown_key', `${e.name} doesn’t use a key called ${name.slice(0, 60)}.`);
        if (typeof value !== 'string' || !value.trim()) return err(400, 'bad_value', `Type the ${k.label}, or leave it out.`);
      }
      for (const name of Object.keys(keys)) this.saved.add(name); // the value itself is not kept
      const v = this.view(e);
      return { status: 200, body: { plugin: v, message: v.on ? `Saved. ${APPLIES}` : 'Saved. You can turn it on now.' } };
    }
    if (method === 'DELETE' && (m = /^\/plugins\/([^/]+)\/keys\/([^/]+)$/.exec(path))) {
      const e = entry(decodeURIComponent(m[1]));
      if (!e) return err(404, 'not_found', 'There is no plug-in with that name in the library.');
      const name = decodeURIComponent(m[2]);
      const k = e.keys.find((x) => x.name === name);
      if (!k) return err(400, 'unknown_key', `${e.name} doesn’t use a key called ${name.slice(0, 60)}.`);
      if (this.on.has(e.id) && !k.optional) return err(409, 'in_use', `Turn ${e.name} off first, then clear its ${k.label}.`);
      if (!this.saved.has(name)) return err(404, 'not_saved', `No ${k.label} is saved.`);
      this.saved.delete(name);
      return { status: 200, body: { plugin: this.view(e), message: `Cleared the ${k.label}.${this.on.has(e.id) ? ` ${APPLIES}` : ''}` } };
    }
    if (method === 'DELETE' && (m = /^\/plugins\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (entry(id)) return err(400, 'library_plugin', 'That one comes with your helper. Turn it off instead.');
      if (!this.custom.some((c) => c.id === id)) return err(404, 'not_found', 'No plug-in by that name, or it was already removed.');
      this.custom = this.custom.filter((c) => c.id !== id);
      return { status: 200, body: { removed: id, message: `Removed ${id}. ${APPLIES}` } };
    }
    if (method === 'POST' && (path === '/plugins/review' || path === '/plugins/approve')) {
      const pkg = typeof b.package === 'string' ? b.package.trim() : '';
      if (!pkg) return err(400, 'bad_body', 'Type the npm package name, for example @scope/server-name.');
      if (!NPM_NAME.test(pkg)) return err(400, 'bad_package', 'That isn’t an npm package name. It looks like @scope/server-name or server-name, without a version.');
      const npm = this.npm();
      if (!npm.available) return err(409, 'npm_unavailable', npm.reason);
      if (path === '/plugins/review') {
        const at = this.clock();
        const bad = pkg === 'shady-mcp';
        const noAi = pkg === 'offline-mcp'; // the reviewing model could not be reached
        const review: PluginReview = {
          package: pkg, version: '1.0.0', verdict: bad ? 'dangerous' : noAi ? 'caution' : 'safe', aiReviewed: !noAi,
          summary: noAi ? 'The reviewing model couldn’t be reached — treat with caution and review it yourself.' : bad ?'This package sends your saved keys to an unknown server. Don’t install it unless you wrote it yourself.' : 'A small server that looks up the weather for a place. It only talks to a public weather service.',
          capabilities: bad ? ['reads your environment', 'sends data to the internet'] : ['looks up weather forecasts'],
          redFlags: bad ? ['reads every saved key', 'hidden (obfuscated) code'] : [],
          scan: { ran: true, files: 14, checksum: 'verified', note: null }, reviewer: npm.reviewer ?? 'example', expiresAt: at + 30 * 60_000,
        };
        this.reviews.set(pkg, { review, at });
        return { status: 200, body: { review } };
      }
      const got = this.reviews.get(pkg);
      if (!got || this.clock() - got.at > 30 * 60_000) return err(409, 'review_first', 'Run the safety review for this package first (a review lasts 30 minutes).');
      if (!got.review.aiReviewed && b.acceptRisk !== true) return err(409, 'unreviewed', 'The safety check couldn’t reach the AI reviewer, so only the automated checks ran. Only install it if you trust where it came from, and say so (acceptRisk).');
      if (got.review.verdict === 'dangerous' && b.acceptRisk !== true) return err(409, 'risky', 'The review found this package dangerous. Only install it if you trust where it came from, and say so (acceptRisk).');
      const id = pkg.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connector';
      if (entry(id)) return err(409, 'name_taken', `A plug-in in the library is already called ${id}. Use that one instead.`);
      if (this.custom.some((c) => c.id === id)) return err(409, 'name_taken', `You already have a plug-in called ${id}. Remove it first if you want to replace it.`);
      const plugin: CustomPlugin = { id, command: `npx -y ${pkg}@${got.review.version}`, argsHidden: false, package: `${pkg}@${got.review.version}`, envNames: [] };
      this.custom = [...this.custom, plugin];
      this.reviews.delete(pkg);
      return { status: 200, body: { plugin, message: `Installed ${pkg}@${got.review.version}. Its tools are available on your next message.` } };
    }
    return null;
  }
}
