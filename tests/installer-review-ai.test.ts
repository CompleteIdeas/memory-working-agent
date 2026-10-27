// Review of S1: the installation review says whether the reviewing model actually judged the package. When the model
// can't be reached the verdict is "caution" with a pinned version, and aiReviewed is false — so /plugins/approve can
// ask for acceptRisk instead of installing on the automated checks alone. npm and the model are stubs here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const chat = vi.fn();
vi.mock('../src/provider.js', () => ({ resolveProvider: () => ({ chat }) }));
const { reviewConnector } = await import('../src/installer/review.js');

const cfg = { models: { reason: 'anthropic:claude-sonnet-5' }, tools: {} } as never;
beforeEach(() => {
  chat.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('https://registry.npmjs.org/')) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { description: 'x', dist: { tarball: 'https://registry.example/t.tgz', integrity: 'sha512-x' } } }, maintainers: [{ name: 'a' }], time: { created: '2020-01-01T00:00:00Z' } }));
    }
    if (String(url).startsWith('https://api.npmjs.org/downloads/')) return new Response(JSON.stringify({ downloads: 5000 }));
    return new Response('nope', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('reviewConnector: did the AI reviewer judge it?', () => {
  it('the model answered: aiReviewed true, its verdict', async () => {
    chat.mockResolvedValue({ text: '{"verdict":"safe","capabilities":["reads pages"],"redFlags":[],"summary":"Fine."}' });
    const r = await reviewConnector('example-mcp', cfg);
    expect(r).toMatchObject({ verdict: 'safe', aiReviewed: true, pinnedVersion: '1.2.3' });
  });
  it('the model could not be reached: caution, a pinned version, and aiReviewed false', async () => {
    chat.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await reviewConnector('example-mcp', cfg);
    expect(r).toMatchObject({ verdict: 'caution', aiReviewed: false, pinnedVersion: '1.2.3' });
    expect(r.summary).toMatch(/couldn't be reached/);
  });
});
