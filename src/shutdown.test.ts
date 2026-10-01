import { Agent, createServer, get, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, type Db } from './db/index.js';
import { createCipher } from './crypto.js';
import { FAKE_SECRETS, fakeAppState, fakeLoggedInSession, startFakeIca, type FakeIca } from './ica/test-fakes.js';
import { loadAppSession, storeAppSession } from './sessions/app-store.js';
import { createSessionKeeper } from './sessions/keeper.js';
import { storeWebSession } from './sessions/web-store.js';
import { seedUser } from './test-helpers.js';
import { createShutdown } from './shutdown.js';

const silent = { info: () => {}, warn: () => {} };
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const never = () => new Promise<void>(() => {});
/** A log that records `<level> <msg>` and the fields of every line. */
function recordingLog() {
  const lines: { level: string; msg: string; obj: Record<string, unknown> }[] = [];
  return {
    lines,
    log: {
      info: (obj: object, msg: string) => { lines.push({ level: 'info', msg, obj: obj as Record<string, unknown> }); },
      warn: (obj: object, msg: string) => { lines.push({ level: 'warn', msg, obj: obj as Record<string, unknown> }); },
    },
  };
}

describe('createShutdown', () => {
  it('closes HTTP (after the in-flight request), then drains the upkeep, then the keeper, then closes the database and exits 0', async () => {
    const db = openDb(':memory:');
    const events: string[] = [];
    let answer!: () => void;
    let arrived!: () => void;
    const inside = new Promise<void>((r) => { arrived = r; });
    const server = createServer((_req, res) => { arrived(); answer = () => { events.push('request answered'); res.end('ok'); }; });
    const port = await listen(server);
    server.on('close', () => events.push('http closed'));
    const body = new Promise<string>((resolve, reject) => {
      get({ port, host: '127.0.0.1' }, (res) => { let b = ''; res.on('data', (c) => { b += String(c); }); res.on('end', () => resolve(b)); }).on('error', reject);
    });
    await inside;
    let upkeepDone!: () => void;
    let idleDone!: () => void;
    const stopUpkeep = vi.fn(() => { events.push('upkeep stop'); return new Promise<void>((r) => { upkeepDone = () => { events.push('upkeep drained'); r(); }; }); });
    const keeper = { beginClosing: vi.fn(() => { events.push('closing'); }), idle: vi.fn(() => { events.push('keeper idle'); return new Promise<void>((r) => { idleDone = () => { events.push('keeper drained'); r(); }; }); }) };
    const { log, lines } = recordingLog();
    const codes: number[] = [];
    const shutdown = createShutdown({ server, stopUpkeep, keeper, db, log, stopTimers: [() => events.push('timers')], exit: (c) => { events.push(`exit ${c}`); codes.push(c); } });
    shutdown('SIGTERM');
    // The keeper stops starting refreshes and the upkeep stops scheduling at once; nothing is awaited before HTTP has closed.
    expect(events).toEqual(['closing', 'timers', 'upkeep stop']);
    await new Promise((r) => setTimeout(r, 20));
    expect(keeper.idle).not.toHaveBeenCalled();
    answer();
    expect(await body).toBe('ok');
    await vi.waitFor(() => expect(events).toContain('http closed'));
    upkeepDone();
    await vi.waitFor(() => expect(keeper.idle).toHaveBeenCalled());
    expect(db.$client.open).toBe(true);
    idleDone();
    await vi.waitFor(() => expect(codes).toEqual([0]));
    expect(events).toEqual(['closing', 'timers', 'upkeep stop', 'request answered', 'http closed', 'upkeep drained', 'keeper idle', 'keeper drained', 'exit 0']);
    expect(db.$client.open).toBe(false);
    // One info line per step, each with its ms.
    const steps = lines.filter((l) => l.level === 'info' && typeof l.obj.step === 'string');
    expect(steps.map((l) => l.obj.step)).toEqual(['http', 'upkeep', 'keeper', 'db']);
    for (const l of steps) expect(typeof l.obj.ms).toBe('number');
    expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('closes idle keep-alive connections, including ones that go idle after their request', async () => {
    const db = openDb(':memory:');
    let answer!: () => void;
    let arrived!: () => void;
    const inside = new Promise<void>((r) => { arrived = r; });
    const server = createServer((req, res) => { if (req.url === '/slow') { arrived(); answer = () => res.end('slow'); } else res.end('fast'); });
    server.keepAliveTimeout = 60_000;
    const port = await listen(server);
    const agent = new Agent({ keepAlive: true });
    const fetchOn = (path: string) => new Promise<string>((resolve, reject) => {
      get({ port, host: '127.0.0.1', path, agent }, (res) => { let b = ''; res.on('data', (c) => { b += String(c); }); res.on('end', () => resolve(b)); }).on('error', reject);
    });
    expect(await fetchOn('/fast')).toBe('fast'); // leaves an idle keep-alive socket
    const slow = fetchOn('/slow');
    await inside;
    const codes: number[] = [];
    const started = Date.now();
    createShutdown({ server, stopUpkeep: async () => {}, keeper: { beginClosing: () => {}, idle: async () => {} }, db, log: silent, exit: (c) => { codes.push(c); } })('SIGTERM');
    answer();
    expect(await slow).toBe('slow');
    await vi.waitFor(() => expect(codes).toEqual([0]), { timeout: 3_000 });
    expect(Date.now() - started).toBeLessThan(2_000); // not the 60 s keep-alive timeout
    agent.destroy();
  });

  it('a request that outlives the HTTP bound is cut; the drain continues and the process exits 0', async () => {
    const db = openDb(':memory:');
    let arrived!: () => void;
    const inside = new Promise<void>((r) => { arrived = r; });
    const server = createServer(() => { arrived(); /* never answers */ });
    const port = await listen(server);
    const req = request({ port, host: '127.0.0.1' }); req.on('error', () => {}); req.end();
    await inside;
    const { log, lines } = recordingLog();
    const codes: number[] = [];
    const idle = vi.fn(async () => {});
    createShutdown({ server, stopUpkeep: async () => {}, keeper: { beginClosing: () => {}, idle }, db, log, httpTimeoutMs: 50, exit: (c) => { codes.push(c); } })('SIGTERM');
    await vi.waitFor(() => expect(codes).toEqual([0]));
    expect(idle).toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', obj: expect.objectContaining({ step: 'http' }) }));
    expect(db.$client.open).toBe(false);
  });

  it('a hung step hits the overall bound: a warn names it, the database is closed anyway, exit 1', async () => {
    const db = openDb(':memory:');
    const server = createServer((_req, res) => res.end('ok'));
    await listen(server);
    const { log, lines } = recordingLog();
    const codes: number[] = [];
    createShutdown({ server, stopUpkeep: async () => {}, keeper: { beginClosing: () => {}, idle: never }, db, log, timeoutMs: 80, exit: (c) => { codes.push(c); } })('SIGTERM');
    await vi.waitFor(() => expect(codes).toEqual([1]));
    expect(db.$client.open).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', obj: expect.objectContaining({ step: 'keeper', timeoutMs: 80 }) }));
    await new Promise((r) => setTimeout(r, 30));
    expect(codes).toEqual([1]); // exits once
  });

  it('a hung upkeep pass is named when it hits the bound', async () => {
    const db = openDb(':memory:');
    const server = createServer((_req, res) => res.end('ok'));
    await listen(server);
    const { log, lines } = recordingLog();
    const codes: number[] = [];
    const idle = vi.fn(async () => {});
    createShutdown({ server, stopUpkeep: never, keeper: { beginClosing: () => {}, idle }, db, log, timeoutMs: 80, exit: (c) => { codes.push(c); } })('SIGTERM');
    await vi.waitFor(() => expect(codes).toEqual([1]));
    expect(idle).not.toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', obj: expect.objectContaining({ step: 'upkeep' }) }));
    expect(db.$client.open).toBe(false);
  });

  it('a second signal during shutdown exits at once, with a log line', async () => {
    const db = openDb(':memory:');
    const server = createServer((_req, res) => res.end('ok'));
    await listen(server);
    const { log, lines } = recordingLog();
    const codes: number[] = [];
    const shutdown = createShutdown({ server, stopUpkeep: async () => {}, keeper: { beginClosing: () => {}, idle: never }, db, log, timeoutMs: 60_000, exit: (c) => { codes.push(c); } });
    shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(codes).toEqual([]);
    shutdown('SIGINT');
    expect(codes).toEqual([1]);
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', obj: expect.objectContaining({ signal: 'SIGINT' }) }));
    expect(db.$client.open).toBe(false);
    shutdown('SIGTERM');
    expect(codes).toEqual([1]);
  });

  it('a failing step is logged, the shutdown goes on, exit 1', async () => {
    const db = openDb(':memory:');
    const server = createServer((_req, res) => res.end('ok'));
    await listen(server);
    const { log, lines } = recordingLog();
    const codes: number[] = [];
    const idle = vi.fn(async () => {});
    createShutdown({ server, stopUpkeep: () => Promise.reject(new TypeError('boom')), keeper: { beginClosing: () => {}, idle }, db, log, exit: (c) => { codes.push(c); } })('SIGTERM');
    await vi.waitFor(() => expect(codes).toEqual([1]));
    expect(idle).toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', obj: expect.objectContaining({ step: 'upkeep', err: { name: 'TypeError' } }) }));
    expect(db.$client.open).toBe(false);
  });

  it('responses still to be written once the shutdown starts close their keep-alive connection', async () => {
    const db = openDb(':memory:');
    let answer!: () => void;
    let arrived!: () => void;
    const inside = new Promise<void>((r) => { arrived = r; });
    const server = createServer((_req, res) => { arrived(); answer = () => res.end('ok'); });
    server.keepAliveTimeout = 60_000;
    const port = await listen(server);
    const agent = new Agent({ keepAlive: true });
    const codes: number[] = [];
    const shutdown = createShutdown({ server, stopUpkeep: async () => {}, keeper: { beginClosing: () => {}, idle: async () => {} }, db, log: silent, exit: (c) => { codes.push(c); } });
    const res = new Promise<{ connection: string | undefined; socketClosed: Promise<void> }>((resolve, reject) => {
      get({ port, host: '127.0.0.1', agent }, (r) => {
        const socketClosed = new Promise<void>((c) => { r.socket.once('close', () => c()); });
        r.resume(); r.on('end', () => resolve({ connection: r.headers.connection, socketClosed }));
      }).on('error', reject);
    });
    await inside;
    shutdown('SIGTERM');
    answer();
    const r = await res;
    expect(r.connection).toBe('close');
    await r.socketClosed;
    await vi.waitFor(() => expect(codes).toEqual([0]));
    agent.destroy();
  });

  it('the same signal again within a second is ignored (tsx watch relays Ctrl-C twice); after a second it forces the exit', async () => {
    const db = openDb(':memory:');
    const server = createServer((_req, res) => res.end('ok'));
    await listen(server);
    const { log } = recordingLog();
    const codes: number[] = [];
    let t = 1_000_000;
    const shutdown = createShutdown({ server, stopUpkeep: async () => {}, keeper: { beginClosing: () => {}, idle: never }, db, log, timeoutMs: 60_000, now: () => t, exit: (c) => { codes.push(c); } });
    shutdown('SIGINT');
    t += 999;
    shutdown('SIGINT');
    expect(codes).toEqual([]);
    expect(db.$client.open).toBe(true);
    t += 1;
    shutdown('SIGINT');
    expect(codes).toEqual([1]);
    expect(db.$client.open).toBe(false);
  });
});

describe('createShutdown with the real keeper: a refresh during the drain is stored or refused, never lost', () => {
  const cipher = createCipher(Buffer.alloc(32, 7));
  let dir: string; let path: string; let db: Db; let fake: FakeIca; let acc: string;
  const storedRefresh = () => { const d = openDb(path); try { return loadAppSession({ db: d, cipher, icaAccountId: acc })!.state.token.refresh_token; } finally { closeDb(d); } };
  const refreshes = () => fake.seen.tokenGrants.filter((g) => g === 'refresh_token').length;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ica-hub-shutdown-'));
    path = join(dir, 'hub.db');
    db = openDb(path);
    fake = await startFakeIca({ pendingPolls: 0 });
    seedUser(db, 'u1');
    ({ icaAccountId: acc } = await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db, cipher, user: { id: 'u1', name: 'u1' } }));
    storeAppSession({ db, cipher, userId: 'u1', state: fakeAppState(), now: () => new Date() });
  });
  afterEach(async () => { if (db.$client.open) closeDb(db); await fake.close(); rmSync(dir, { recursive: true, force: true }); });

  /** A tool-like endpoint: waits for `gate`, then refreshes the app token through the keeper and answers the outcome. */
  function toolServer(keeper: ReturnType<typeof createSessionKeeper>, gate: Promise<void>, arrived: () => void) {
    return createServer((_req, res) => {
      arrived();
      void gate.then(() => keeper.refreshAppNow(acc)).then(() => res.end('refreshed'), (e: { reason?: string }) => res.end(`refused ${e.reason ?? ''}`));
    });
  }

  it('a refresh the handler would start after the signal is refused: ICA never rotates, the stored token stays valid', async () => {
    const keeper = createSessionKeeper({ db, cipher, endpoints: fake.endpoints });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let arrived!: () => void;
    const inside = new Promise<void>((r) => { arrived = r; });
    const server = toolServer(keeper, gate, arrived);
    const port = await listen(server);
    const answer = new Promise<string>((resolve, reject) => { get({ port, host: '127.0.0.1' }, (r) => { let b = ''; r.on('data', (c) => { b += String(c); }); r.on('end', () => resolve(b)); }).on('error', reject); });
    await inside;
    const codes: number[] = [];
    createShutdown({ server, stopUpkeep: async () => {}, keeper, db, log: silent, exit: (c) => { codes.push(c); } })('SIGTERM');
    open();
    expect(await answer).toBe('refused shutting-down');
    await vi.waitFor(() => expect(codes).toEqual([0]));
    expect(refreshes()).toBe(0);
    expect(storedRefresh()).toBe(FAKE_SECRETS.appRefreshToken);
    expect(fake.app.refreshToken).toBe(FAKE_SECRETS.appRefreshToken);
  });

  it('a refresh still waiting on ICA when the HTTP bound cuts its request is awaited, and the rotated token stored', async () => {
    const keeper = createSessionKeeper({ db, cipher, endpoints: fake.endpoints });
    let release!: () => void;
    fake.opts.holdRefresh = new Promise<void>((r) => { release = r; });
    let arrived!: () => void;
    const inside = new Promise<void>((r) => { arrived = r; });
    const server = toolServer(keeper, Promise.resolve(), arrived);
    const port = await listen(server);
    const req = request({ port, host: '127.0.0.1' }); req.on('error', () => {}); req.end();
    await inside;
    while (refreshes() === 0) await new Promise((r) => setTimeout(r, 2));
    const { log, lines } = recordingLog();
    const codes: number[] = [];
    createShutdown({ server, stopUpkeep: async () => {}, keeper, db, log, httpTimeoutMs: 30, exit: (c) => { codes.push(c); } })('SIGTERM');
    await vi.waitFor(() => expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', obj: expect.objectContaining({ step: 'http' }) })));
    await new Promise((r) => setTimeout(r, 30));
    expect(codes).toEqual([]); // still draining the keeper
    release();
    await vi.waitFor(() => expect(codes).toEqual([0]));
    expect(fake.app.refreshToken).toBe(`${FAKE_SECRETS.appRefreshToken}-r1`);
    expect(storedRefresh()).toBe(fake.app.refreshToken);
  });
});
