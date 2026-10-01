import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { IcaRejected, IcaUnauthorized, IcaUnavailable } from './errors.js';
import { bearerFetcher, icaJson, icaRequest, parseIca, type Fetcher } from './gateway.js';

let server: Server; let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, auth: req.headers.authorization, ct: req.headers['content-type'] ?? null, ua: req.headers['user-agent'], extra: req.headers['x-extra'] ?? null, body: Buffer.concat(chunks).toString('utf8') }));
        return;
      }
      const status = Number((req.url ?? '/500').slice(1));
      res.writeHead(status, { 'content-type': 'text/plain' }).end(`SECRET-BODY-${status} personnummer 199001011234`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const caught = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('icaRequest', () => {
  it('sends the bearer, a JSON body, extra headers and a browser User-Agent', async () => {
    const { status, json } = await icaRequest(bearerFetcher('BEARER-1'), `${base}/echo`, { method: 'POST', body: { a: 1 }, headers: { 'x-extra': 'yes' } });
    expect(status).toBe(200);
    expect(json).toMatchObject({ method: 'POST', auth: 'Bearer BEARER-1', ct: 'application/json', extra: 'yes', body: '{"a":1}' });
    expect((json as { ua: string }).ua).toMatch(/Chrome/);
  });

  it('sends no content type on a GET', async () => {
    expect((await icaRequest(bearerFetcher('B'), `${base}/echo`)).json).toMatchObject({ method: 'GET', ct: null, body: '' });
  });

  it('maps statuses to typed errors whose messages never carry the body', async () => {
    const f = bearerFetcher('B');
    expect(await caught(icaRequest(f, `${base}/401`))).toMatchObject({ name: 'IcaUnauthorized', status: 401 });
    expect(await caught(icaRequest(f, `${base}/403`))).toBeInstanceOf(IcaUnauthorized);
    expect(await caught(icaRequest(f, `${base}/404`))).toMatchObject({ name: 'IcaRejected', status: 404 });
    expect(await caught(icaRequest(f, `${base}/451`))).toMatchObject({ name: 'IcaUnavailable', reason: 'geo-blocked', status: 451 });
    expect(await caught(icaRequest(f, `${base}/502`))).toMatchObject({ name: 'IcaUnavailable', reason: 'server-error', status: 502 });
    expect(await caught(icaRequest(f, `${base}/429`))).toMatchObject({ name: 'IcaUnavailable', reason: 'rate-limited', status: 429 });
    for (const s of [401, 404, 429, 451, 502]) {
      const e = await caught(icaRequest(f, `${base}/${s}`));
      expect(`${String(e)} ${JSON.stringify(e)}`).not.toMatch(/SECRET-BODY|199001011234/);
    }
    expect(await caught(icaRequest(f, `${base}/409`))).toBeInstanceOf(IcaRejected);
  });

  it('turns network failures and timeouts into IcaUnavailable', async () => {
    const down: Fetcher = () => Promise.reject(new TypeError('fetch failed'));
    const slow: Fetcher = () => Promise.reject(new DOMException('slow', 'TimeoutError'));
    expect(await caught(icaRequest(down, `${base}/echo`))).toMatchObject({ name: 'IcaUnavailable', reason: 'network' });
    expect(await caught(icaRequest(slow, `${base}/echo`))).toMatchObject({ name: 'IcaUnavailable', reason: 'timeout' });
  });
});

describe('bearerFetcher: timeout and caller signal', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps the 15 s timeout when the caller passes its own signal", async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    const c = new AbortController();
    const remove = vi.spyOn(c.signal, 'removeEventListener');
    const e = await caught(bearerFetcher('B')(`${base}/echo`, { signal: c.signal }));
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(e).toMatchObject({ name: 'TimeoutError' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it("aborts when the caller's signal does", async () => {
    const c = new AbortController(); c.abort();
    expect(await caught(bearerFetcher('B')(`${base}/echo`, { signal: c.signal }))).toMatchObject({ name: 'AbortError' });
  });

  it('works without a caller signal', async () => {
    expect((await bearerFetcher('B')(`${base}/echo`)).status).toBe(200);
  });
});

describe('parseIca / icaJson', () => {
  const Schema = z.looseObject({ name: z.string(), items: z.array(z.looseObject({ id: z.number() })).default([]) });

  it('keeps unknown keys and fills defaults', () => {
    expect(parseIca(Schema, { name: 'a', extra: { deep: 1 } })).toEqual({ name: 'a', items: [], extra: { deep: 1 } });
  });

  it('reports a mismatch as unexpected-response with paths and codes, never values', () => {
    let err: unknown;
    try { parseIca(Schema, { name: 42, items: [{ id: 'Mjölk-199001011234' }] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(IcaUnavailable);
    expect(err).toMatchObject({ reason: 'unexpected-response', issues: ['name: invalid_type', 'items.0.id: invalid_type'] });
    expect(`${String(err)} ${JSON.stringify(err)}`).not.toMatch(/Mjölk|199001011234|42/);
  });

  it('icaJson fetches and parses', async () => {
    expect(await icaJson(bearerFetcher('B'), `${base}/echo`, z.looseObject({ method: z.string() }))).toMatchObject({ method: 'GET' });
  });
});
