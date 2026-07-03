/**
 * Image generation — a provider-agnostic capability that MIRRORS the chat brain. The user
 * picks an image/diffusion model from whatever provider they already connected (config
 * `models.image` = "provider:model", e.g. "openrouter:google/gemini-3.1-flash-image"); if
 * their provider has no image model the UI offers connecting an image service. The agent
 * gets a `generate_image` tool that calls that model and saves the PNG to a folder the user
 * allowed (their first granted folder, else the workspace).
 *
 * OpenAI-compatible image models (OpenRouter etc.) return the image via chat/completions with
 * modalities:["image","text"] — the result arrives as a data: URL (or remote URL) in
 * message.images[]. Anthropic/Azure have no image models, so only OpenAI-compat providers apply.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { RegisteredTool } from '../tools/registry.js';
import { OPENAI_COMPAT } from '../provider.js';
import { loadConfig } from '../config.js';
import { loadEnv } from '../env.js';

export function imageGenConfigured(): boolean {
  return !!loadConfig().models.image;
}

/** Resolve the configured image "provider:model" into the endpoint + key + model. */
function resolveImage(): { base: string; key?: string; model: string; provider: string } {
  loadEnv();
  const spec = loadConfig().models.image ?? '';
  const i = spec.indexOf(':');
  const provider = (i > 0 ? spec.slice(0, i) : '').toLowerCase();
  const model = (i > 0 ? spec.slice(i + 1) : spec).trim();
  const oc = OPENAI_COMPAT[provider];
  if (!oc) throw new Error('No image model set, or its provider can\'t generate images.');
  const base = ((oc.baseEnv && process.env[oc.baseEnv]) || oc.base).replace(/\/$/, '');
  const key = oc.keyless ? undefined : process.env[oc.keyEnv!];
  if (!oc.keyless && !key) throw new Error('The image provider needs its API key set.');
  return { base, key, model, provider };
}

/** Where to save generated images: the first folder the user granted, else the workspace. */
function imageDir(): string {
  const roots = loadConfig().tools?.access?.grantedRoots ?? [];
  const base = (roots[0] && existsSync(roots[0])) ? roots[0] : (process.env.MWA_WORKSPACE || resolve('./mwa-workspace'));
  const dir = join(base, 'mwa-images');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function slug(s: string): string {
  return (s || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
}

/** Generate one image from a text prompt and save it. Returns the saved file path. */
export async function generateImage(prompt: string, filename?: string): Promise<{ path: string; note?: string }> {
  const { base, key, model } = resolveImage();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`image model ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j: any = await res.json();
  const msg = j.choices?.[0]?.message ?? {};
  const url: string = msg.images?.[0]?.image_url?.url || msg.images?.[0]?.url || '';
  if (!url) throw new Error('The model returned no image (it may not be an image-generation model).');

  let buf: Buffer;
  if (url.startsWith('data:')) {
    buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  } else {
    const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error(`could not download the generated image (${img.status})`);
    buf = Buffer.from(await img.arrayBuffer());
  }
  const name = `${slug(filename || prompt)}-${Date.now()}.png`;
  const path = join(imageDir(), name);
  writeFileSync(path, buf);
  return { path, note: typeof msg.content === 'string' ? msg.content.slice(0, 200) : undefined };
}

export function imageGenTools(): RegisteredTool[] {
  return [
    {
      def: {
        name: 'generate_image',
        description: 'Create an image from a text description using the configured image model. Saves a PNG to the user\'s images folder and returns the file path. Use when the user asks to draw/generate/create a picture, logo, illustration, etc.',
        parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'A detailed description of the image to create.' }, filename: { type: 'string', description: 'Optional short name for the file (no extension).' } }, required: ['prompt'] },
      },
      handler: async (args) => {
        try {
          const r = await generateImage(String(args.prompt ?? ''), args.filename ? String(args.filename) : undefined);
          return `🖼️ image saved to ${r.path}${r.note ? `\n${r.note}` : ''}`;
        } catch (e) { return `(could not generate image: ${(e as Error).message.slice(0, 160)})`; }
      },
    },
  ];
}
