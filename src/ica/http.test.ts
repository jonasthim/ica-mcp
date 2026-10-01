import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newSession } from './http.js';

let server: Server; let base = '';
beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => { vi.restoreAllMocks(); });

const caught = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('newSession().fetch: timeout and caller signal', () => {
  it('keeps the 15 s timeout when the caller passes its own signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    const c = new AbortController();
    const remove = vi.spyOn(c.signal, 'removeEventListener');
    expect(await caught(newSession().fetch(`${base}/`, { signal: c.signal }))).toMatchObject({ name: 'TimeoutError' });
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it("aborts when the caller's signal does", async () => {
    const c = new AbortController(); c.abort();
    expect(await caught(newSession().fetch(`${base}/`, { signal: c.signal }))).toMatchObject({ name: 'AbortError' });
  });

  it('works without a caller signal, and with one that never fires', async () => {
    expect((await newSession().fetch(`${base}/`)).status).toBe(200);
    expect((await newSession().fetch(`${base}/`, { signal: new AbortController().signal })).status).toBe(200);
  });
});
