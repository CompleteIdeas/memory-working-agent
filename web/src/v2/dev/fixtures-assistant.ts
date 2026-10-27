/**
 * Fixture mode for Settings › Your assistant (v2 build, slice S2). Answers /assistant and its changes the way
 * src/api/routes/assistant.ts and src/assistant-settings.ts do, with the server's own words. Keys are kept as "saved"
 * flags only: a value typed here is dropped at once, as the server never sends one back. The brain decides the plug-in
 * reviewer, so a weak brain turns "add from npm" off on the Plug-ins page too (./fixtures-plugins.ts).
 *
 * Scenarios: `model-fixed` (the server's MWA_MODEL chooses the model); any other: the brain can be changed.
 * A key with "bad" in it fails the live check. A folder path with "missing" in it isn't there; "/Users/robert/mwa" is
 * where the helper keeps its keys. EVERYTHING HERE IS EXAMPLE DATA.
 */
import type { AssistantSettings, ModelChoices } from '../api/client';
import type { PluginFixtures } from './fixtures-plugins';

type Resp = { status: number; body: unknown };
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const APPLIES = 'Changes take effect on your next message.';
const LINE = /^[^\r\n\0]*$/;
/** where the helper keeps its .env, mwa.config.json and data (a grant of it, or of anything holding it, is refused) */
export const FIXTURE_HELPER_HOME = '/Users/robert/mwa';

export const FIXTURE_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter (many models, one key)', keyless: false, images: true },
  { id: 'anthropic', label: 'Anthropic (Claude)', keyless: false, images: false },
  { id: 'openai', label: 'OpenAI', keyless: false, images: true },
  { id: 'gemini', label: 'Google Gemini', keyless: false, images: true },
  { id: 'ollama', label: 'Local (Ollama), no key', keyless: true, images: true },
];
const KNOWN = new Set(['anthropic', 'azure', 'openai', 'openrouter', 'gemini', 'ollama']);
const KEY_NAME: Record<string, string | null> = { openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', ollama: null, azure: 'AZURE_GPT_API_KEY' };
/** chat models per provider; `strong`: a reviewer good enough for npm plug-ins */
const CHAT: Record<string, { id: string; name: string; strong: boolean }[]> = {
  openrouter: [{ id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol', strong: true }, { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', strong: true }, { id: 'openai/gpt-6-luna', name: 'OpenAI: GPT-6 Luna', strong: false }],
  anthropic: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', strong: true }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', strong: false }],
  openai: [{ id: 'gpt-6.1', name: 'GPT-6.1', strong: true }, { id: 'gpt-6-luna', name: 'GPT-6 Luna', strong: false }],
  gemini: [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro', strong: true }, { id: 'gemini-3-flash', name: 'Gemini 3 Flash', strong: false }],
  ollama: [{ id: 'llama3.1-8b', name: 'llama3.1-8b', strong: false }],
};
const IMAGE: Record<string, { id: string; name: string }[]> = {
  openrouter: [{ id: 'black-forest-labs/flux-2', name: 'FLUX 2' }, { id: 'google/gemini-3-image', name: 'Google: Gemini 3 Image' }],
  openai: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
};

export class AssistantFixtures {
  brain = { provider: 'openrouter', model: 'openai/gpt-6.1-sol' };
  image = { provider: '', model: '' };
  saved = new Set(['OPENROUTER_API_KEY']);
  preset: AssistantSettings['access']['preset'] = 'assistant';
  folders: { path: string; found: boolean }[] = [{ path: '/Users/robert/Documents/Barn', found: true }, { path: '/Users/robert/Old project', found: false }];
  style: AssistantSettings['style'] = 'guided';
  constructor(private scenario: string, private plugins: PluginFixtures) {}

  private fixed() { return this.scenario === 'model-fixed'; }
  view(): AssistantSettings {
    return {
      brain: {
        provider: this.brain.provider, model: this.brain.model, fixed: this.fixed(),
        notes: this.brain.model === 'openai/gpt-6-luna' ? [{ standing: 'unmeasured', text: 'openrouter:openai/gpt-6-luna hasn\'t been tested against instructions planted in emails or web pages. Until it has, don\'t point it at mail or pages you don\'t trust (docs/models.md).' }] : [],
      },
      image: { provider: this.image.provider, model: this.image.model, on: !!this.image.model, fixed: false },
      providers: FIXTURE_PROVIDERS.map((p) => ({ ...p, keySaved: KEY_NAME[p.id] ? this.saved.has(KEY_NAME[p.id]!) : null })),
      access: { preset: this.preset, folders: this.folders, hosted: false, host: 'your server' },
      style: this.style,
      addFromNpm: this.plugins.npm(),
      applies: APPLIES,
    };
  }
  private change(message: string): Resp { return { status: 200, body: { assistant: this.view(), message } }; }

  read(path: string): Resp | null {
    return path === '/assistant' ? { status: 200, body: this.view() } : null;
  }

  private checkKey(key: unknown): string | undefined | Resp {
    if (key === undefined || key === null || key === '') return undefined;
    if (typeof key !== 'string' || key.length > 4096 || !LINE.test(key)) return err(400, 'bad_key', 'That doesn’t look like an API key. Paste it again, on one line.');
    return key.trim() || undefined;
  }
  private checkModel(model: unknown): string | Resp {
    if (typeof model !== 'string' || !model.trim()) return err(400, 'bad_model', 'Pick a model first.');
    if (model.length > 200 || /\s/.test(model.trim())) return err(400, 'bad_model', 'That isn’t a model name. Load the models and pick one.');
    return model.trim();
  }

  folderProblem(p: string): Resp | null {
    const path = p.trim();
    if (!path || !LINE.test(path)) return err(400, 'bad_folder', 'Type the folder’s full path.');
    if (/^(\\\\|\/\/)/.test(path)) return err(400, 'refused', 'A network share can’t be granted. Use a folder on this computer.');
    if (!/^(\/|[a-z]:[\\/])/i.test(path)) return err(400, 'bad_folder', 'Type the folder’s full path, starting from the drive or /.');
    if (/^(\/|[a-z]:[\\/]?)$/i.test(path)) return err(400, 'refused', 'A whole drive can’t be granted. Pick a folder on it, like Documents.');
    if (/missing/i.test(path)) return err(400, 'not_found', `I couldn’t find a folder at ${path.slice(0, 200)}.`);
    const clean = path.replace(/[\\/]+$/, '');
    if (FIXTURE_HELPER_HOME === clean || FIXTURE_HELPER_HOME.startsWith(clean + '/')) return err(400, 'refused', 'That folder holds your helper’s own keys and settings, so it can’t be granted. Pick a folder that doesn’t contain them.');
    if (clean === `${FIXTURE_HELPER_HOME}/data` || clean.startsWith(`${FIXTURE_HELPER_HOME}/data/`)) return err(400, 'refused', 'That folder is part of your helper’s own data (its memory, sign-ins and saved logins), so it can’t be granted. Pick a folder outside it.');
    return null;
  }

  write(method: string, path: string, body: unknown): Resp | null {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (method === 'POST' && path === '/assistant/models') {
      if (typeof b.provider !== 'string' || !KNOWN.has(b.provider)) return err(400, 'bad_provider', 'Pick one of the AI providers in the list.');
      const key = this.checkKey(b.key); if (key && typeof key === 'object') return key;
      const name = KEY_NAME[b.provider];
      const reachable = !name || !!key || this.saved.has(name); // no key, no list (as the server)
      const kind = b.kind === 'image' ? 'image' : 'chat';
      const models: ModelChoices['models'] = !reachable ? [] : kind === 'image'
        ? (IMAGE[b.provider] ?? []).map((m) => ({ ...m, npmAfter: null }))
        : (CHAT[b.provider] ?? []).map((m) => ({ id: m.id, name: m.name, npmAfter: m.strong }));
      return { status: 200, body: { provider: b.provider, kind, models } };
    }
    if (method === 'PUT' && path === '/assistant/brain') {
      if (typeof b.provider !== 'string' || !KNOWN.has(b.provider)) return err(400, 'bad_provider', 'Pick one of the AI providers in the list.');
      const model = this.checkModel(b.model); if (typeof model !== 'string') return model;
      const key = this.checkKey(b.key); if (key && typeof key === 'object') return key;
      if (this.fixed()) return err(409, 'fixed', 'The server’s MWA_MODEL setting chooses the model, and it wins over a choice here. Change it there.');
      const name = KEY_NAME[b.provider];
      if (name && !key && !this.saved.has(name)) return err(400, 'check_failed', 'a key is required for this provider');
      if (typeof key === 'string' && /bad/i.test(key)) return err(400, 'check_failed', 'failed: 401 Incorrect API key provided: •••');
      if (name && typeof key === 'string') this.saved.add(name); // the value itself is not kept
      const before = this.plugins.npm().available;
      this.brain = { provider: b.provider, model };
      const strong = (CHAT[b.provider] ?? []).find((m) => m.id === model)?.strong ?? true;
      this.plugins.reviewer = `${b.provider}:${model}`;
      this.plugins.reviewerCapable = strong;
      const after = this.plugins.npm().available;
      const npm = after === before ? '' : after ? ' Adding plug-ins from npm is available now.' : ' Adding plug-ins from npm is off now: it needs a stronger model to check them.';
      return this.change(`${model} works ✓${npm} ${APPLIES}`);
    }
    if (method === 'PUT' && path === '/assistant/image') {
      if (typeof b.model !== 'string' || !b.model.trim()) return err(400, 'bad_model', 'Pick an image model first, or turn image generation off.');
      if (typeof b.provider !== 'string' || !KNOWN.has(b.provider)) return err(400, 'bad_provider', 'Pick one of the AI providers in the list.');
      if (b.provider === 'anthropic') return err(400, 'bad_provider', 'Anthropic doesn’t make images. Pick another provider, like OpenRouter.');
      const model = this.checkModel(b.model); if (typeof model !== 'string') return model;
      const key = this.checkKey(b.key); if (key && typeof key === 'object') return key;
      if (KEY_NAME[b.provider] && typeof key === 'string') this.saved.add(KEY_NAME[b.provider]!);
      this.image = { provider: b.provider, model };
      return this.change(`Image model set to ${b.provider}:${model}. ${APPLIES}`);
    }
    if (method === 'DELETE' && path === '/assistant/image') {
      this.image = { provider: '', model: '' };
      return this.change('Image generation turned off.');
    }
    if (method === 'PUT' && path === '/assistant/access') {
      if (b.preset !== 'locked-down' && b.preset !== 'assistant' && b.preset !== 'developer') return err(400, 'bad_preset', 'Pick Locked-down, Assistant or Developer.');
      this.preset = b.preset;
      return this.change(`Saved. ${APPLIES}`);
    }
    if (method === 'POST' && path === '/assistant/folders') {
      if (typeof b.path !== 'string') return err(400, 'bad_folder', 'Type the folder’s full path.');
      const p = b.path.trim();
      if (this.folders.some((f) => f.path === p)) return this.change('That folder is already granted.');
      const problem = this.folderProblem(p); if (problem) return problem;
      this.folders = [...this.folders, { path: p, found: true }];
      return this.change(this.preset === 'locked-down' ? 'Granted. It’s used once you pick Assistant or Developer.' : `Granted. ${APPLIES}`);
    }
    if (method === 'POST' && path === '/assistant/folders/remove') {
      if (typeof b.path !== 'string' || !this.folders.some((f) => f.path === b.path)) return err(404, 'not_granted', 'That folder isn’t granted, or it was already removed.');
      this.folders = this.folders.filter((f) => f.path !== b.path);
      return this.change(`Removed. ${APPLIES}`);
    }
    if (method === 'PUT' && path === '/assistant/style') {
      if (b.style !== 'guided' && b.style !== 'direct') return err(400, 'bad_style', 'Pick Guided or Direct.');
      this.style = b.style;
      return this.change(b.style === 'direct' ? 'Switched to Direct — concise replies.' : 'Switched to Guided — I\'ll explain and suggest next steps.');
    }
    return null;
  }
}
