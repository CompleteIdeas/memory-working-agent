// v2 build, slice A1: the OpenAPI contract (api/openapi.yaml) and the /api/v1 route table describe the same API,
// and real responses match the contract's schemas. Each slice that adds routes adds its spec operations and cases.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { v1Routes } from '../src/api/v1.js';
import { createV1 } from '../src/api/router.js';
import { resetAppDb } from '../src/v2/db.js';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ops = Object.entries(spec.paths as Record<string, Record<string, any>>).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ key: `${m.toUpperCase()} ${path}`, op: item[m], path, method: m })));

const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
const validate = (schema: object, data: unknown) => {
  const fn = ajv.compile({ ...JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"spec#/components/')) });
  return fn(data) ? null : ajv.errorsText(fn.errors);
};
const responseSchema = (op: any, status: number): object | undefined => {
  const r = op.responses[String(status)] ?? op.responses.default;
  const resolved = r?.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  return resolved?.content?.['application/json']?.schema;
};

describe('the contract and the route table agree', () => {
  const routes = v1Routes().map((r) => ({ key: `${r.method} ${r.path}`, scope: r.scope }));
  it('every route is in the spec and every spec operation has a route', () => {
    expect(routes.map((r) => r.key).sort()).toEqual(ops.map((o) => o.key).sort());
  });
  it('a route is public exactly when its operation needs no sign-in', () => {
    for (const r of routes) {
      const op = ops.find((o) => o.key === r.key)!.op;
      expect(`${r.key} public=${r.scope === 'public'}`).toBe(`${r.key} public=${Array.isArray(op.security) && op.security.length === 0}`);
    }
  });
  it('every operation has an operationId, a summary, a success response and the error response', () => {
    for (const o of ops) {
      expect(o.op.operationId, o.key).toBeTruthy();
      expect(o.op.summary, o.key).toBeTruthy();
      expect(Object.keys(o.op.responses).some((s) => /^2\d\d$/.test(s)), o.key).toBe(true);
      expect(o.op.responses.default, o.key).toBeTruthy();
    }
  });
  it('every write operation requires an Idempotency-Key', () => {
    for (const o of ops.filter((x) => x.method !== 'get' && !(Array.isArray(x.op.security) && !x.op.security.length))) {
      expect((o.op.parameters ?? []).some((p: any) => p.$ref === '#/components/parameters/IdempotencyKey'), o.key).toBe(true);
    }
  });
});

// Real responses against the schemas, over HTTP.
let server: Server, base = '';
beforeAll(async () => {
  resetAppDb(':memory:');
  const v1 = createV1(v1Routes(), { authed: () => true, sameOrigin: () => true });
  server = createServer(async (req, res) => { if (!(await v1(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(() => server?.close());

/** One request per operation (and a few error cases). Slices append theirs. */
const CASES: { op: string; path: string; init?: RequestInit; status: number }[] = [
  { op: 'GET /meta', path: '/meta', status: 200 },
  { op: 'GET /meta', path: '/meta', init: { method: 'POST' }, status: 405 },
];

describe('responses match the contract', () => {
  it('the schema check rejects a wrong response (it is not vacuous)', () => {
    expect(validate(spec.components.schemas.Meta, { api: 'v1' })).toMatch(/required/);
    expect(validate(spec.components.schemas.Meta, { api: 'v2', server: '1', minClient: '1', secure: true, features: [] })).toMatch(/const/);
    expect(validate(spec.components.schemas.Error, { error: { code: 'x' } })).toMatch(/message/);
  });
  it('every operation has at least one case', () => {
    for (const o of ops) expect(CASES.some((c) => c.op === o.key), o.key).toBe(true);
  });
  for (const c of CASES) {
    it(`${c.init?.method ?? 'GET'} ${c.path} → ${c.status}`, async () => {
      const r = await fetch(base + c.path, c.init);
      expect(r.status).toBe(c.status);
      const op = ops.find((o) => o.key === c.op)!.op;
      const schema = r.status === 405 ? spec.components.schemas.Error : responseSchema(op, r.status);
      expect(schema, 'a schema for this status').toBeTruthy();
      expect(validate(schema!, await r.json())).toBeNull();
    });
  }
});
