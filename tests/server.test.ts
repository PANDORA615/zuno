import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, Socket } from 'socket.io-client';
import { backup, DatabaseSync } from 'node:sqlite';
import { createApp, parseSource, position } from '../server/app.js';
const origin = 'http://localhost:5173';
const resources: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  for (const r of resources.splice(0).reverse()) await r.close();
});
async function setup(staticDir?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'zuno-test-'));
  resources.push({ close: async () => rmSync(dir, { recursive: true, force: true }) });
  let service = await createApp({
    dataDir: dir,
    secret: 'test-secret-'.repeat(4),
    origin,
    logger: false,
    staticDir: staticDir ?? '/does-not-exist',
  });
  await service.app.listen({ host: '127.0.0.1', port: 0 });
  resources.push({ close: () => service.app.close() });
  const address = service.app.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  async function user() {
    const result = await service.app.inject({ url: '/api/me' });
    const cookie = result.headers['set-cookie']!.toString().split(';')[0];
    const request = (
      method: string,
      path: string,
      body?: any,
      custom: Record<string, string> = {},
    ) =>
      service.app.inject({
        method: method as any,
        url: path,
        headers: { origin, cookie, ...custom },
        payload: body,
      });
    const socket = () =>
      new Promise<Socket>((resolve, reject) => {
        const s = io(url, {
          extraHeaders: { origin, cookie },
          transports: ['websocket'],
          forceNew: true,
        });
        resources.push({
          close: async () => {
            s.disconnect();
          },
        });
        s.on('connect', () => resolve(s));
        s.on('connect_error', reject);
      });
    return { request, cookie, me: result.json().user, socket };
  }
  async function restart() {
    await service.app.close();
    service = await createApp({
      dataDir: dir,
      secret: 'test-secret-'.repeat(4),
      origin,
      logger: false,
      staticDir: staticDir ?? '/does-not-exist',
    });
    await service.app.listen({ host: '127.0.0.1', port: 0 });
    return service;
  }
  return { ...service, user, dir, restart };
}
const ack = (s: Socket, event: string, payload: any) =>
  new Promise<any>((resolve, reject) =>
    s.timeout(2000).emit(event, payload, (e: any, r: any) => (e ? reject(e) : resolve(r))),
  );
describe('protocol', () => {
  it('does not expose filesystem paths through static fallback or encoded traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zuno-static-'));
    resources.push({ close: async () => rmSync(dir, { recursive: true, force: true }) });
    writeFileSync(join(dir, 'index.html'), '<html>Zuno</html>');
    const x = await setup(dir);
    expect((await x.app.inject({ url: '/' })).body).toContain('Zuno');
    for (const url of [
      '/.env',
      '/%2e%2e/.env',
      '/assets/..%2f..%2f.env',
      '/api/private',
      '/missing.js',
    ]) {
      expect((await x.app.inject({ url })).statusCode).toBe(404);
    }
    const before = x.db.prepare('SELECT count(*) AS n FROM users').get()!.n;
    await x.app.inject({ url: '/api/health' });
    expect(x.db.prepare('SELECT count(*) AS n FROM users').get()!.n).toBe(before);
  });

  it('validates sources and computes elapsed playback', () => {
    expect(parseSource('youtube', 'https://youtu.be/dQw4w9WgXcQ').sourceId).toBe('dQw4w9WgXcQ');
    for (const url of [
      'http://example.org/v.mp4',
      'file:///etc/passwd',
      'https://user:pass@example.org/v',
    ])
      expect(() => parseSource('mp4', url)).toThrow();
    expect(() => parseSource('youtube', 'https://evil.example/dQw4w9WgXcQ')).toThrow();
    expect(
      position(
        {
          sourceType: 'mp4',
          sourceId: '',
          positionSeconds: 10,
          isPlaying: true,
          updatedAt: 1000,
          revision: 1,
          actorId: 'x',
        },
        4000,
      ),
    ).toBe(13);
  });
  it('enforces membership, host control, revisions, invite rotation and revocation', async () => {
    const x = await setup(),
      host = await x.user(),
      viewer = await x.user(),
      stranger = await x.user();
    const room = (await host.request('POST', '/api/rooms', {})).json();
    expect(
      (await viewer.request('POST', '/api/join', { token: room.inviteToken })).statusCode,
    ).toBe(200);
    for (let i = 0; i < 3; i++) {
      const extra = await x.user();
      expect(
        (await extra.request('POST', '/api/join', { token: room.inviteToken })).statusCode,
      ).toBe(200);
    }
    expect(
      (await stranger.request('POST', '/api/join', { token: room.inviteToken })).statusCode,
    ).toBe(409);
    const h = await host.socket(),
      v = await viewer.socket(),
      n = await stranger.socket();
    expect((await ack(n, 'join', room.id)).error).toBeTruthy();
    await ack(h, 'join', room.id);
    await ack(v, 'join', room.id);
    const cmd = {
      roomId: room.id,
      revision: 0,
      action: 'source',
      sourceType: 'mp4',
      sourceId: 'https://example.org/video.mp4',
    };
    expect((await ack(v, 'command', cmd)).error).toBeTruthy();
    expect((await ack(h, 'command', cmd)).ok).toBe(true);
    expect((await ack(h, 'command', cmd)).snapshot.state.revision).toBe(1);
    expect(
      (
        await ack(h, 'command', {
          roomId: room.id,
          revision: 1,
          action: 'play',
          positionSeconds: 15,
        })
      ).ok,
    ).toBe(true);
    h.disconnect();
    const reconnected = await host.socket();
    const snapshot = new Promise<any>((r) => reconnected.once('snapshot', r));
    await ack(reconnected, 'join', room.id);
    expect((await snapshot).state.isPlaying).toBe(true);
    expect(
      (await viewer.request('POST', `/api/rooms/${room.id}/control`, { enabled: true })).statusCode,
    ).toBe(403);
    await host.request('POST', `/api/rooms/${room.id}/control`, { enabled: true });
    expect(
      (
        await ack(v, 'command', {
          roomId: room.id,
          revision: 2,
          action: 'pause',
          positionSeconds: 20,
        })
      ).ok,
    ).toBe(true);
    expect((await ack(v, 'chat', { roomId: room.id, text: '<script>alert(1)</script>' })).ok).toBe(
      true,
    );
    const rotated = (await host.request('POST', `/api/rooms/${room.id}/invite`, {})).json();
    expect(rotated.inviteToken).not.toBe(room.inviteToken);
    expect(
      (await stranger.request('POST', '/api/join', { token: room.inviteToken })).statusCode,
    ).toBe(404);
    await host.request('POST', `/api/rooms/${room.id}/revoke`, {});
    expect((await viewer.request('GET', '/api/rooms')).json()).toHaveLength(0);
    expect((await host.request('GET', '/api/history')).json()[0].position).toBe(20);
  });

  it('keeps sessions, membership, chat, state and personal history after process restart', async () => {
    const x = await setup(),
      u = await x.user();
    const room = (await u.request('POST', '/api/rooms', {})).json();
    const s = await u.socket();
    await ack(s, 'join', room.id);
    await ack(s, 'command', {
      roomId: room.id,
      revision: 0,
      action: 'source',
      sourceType: 'youtube',
      sourceId: 'dQw4w9WgXcQ',
    });
    await ack(s, 'command', { roomId: room.id, revision: 1, action: 'pause', positionSeconds: 42 });
    await ack(s, 'chat', { roomId: room.id, text: 'После рестарта' });
    s.disconnect();
    const restarted = await x.restart();
    const rooms = await restarted.app.inject({ url: '/api/rooms', headers: { cookie: u.cookie } });
    expect(rooms.json()[0].id).toBe(room.id);
    expect(JSON.parse(rooms.json()[0].state).positionSeconds).toBe(42);
    expect(restarted.db.prepare('SELECT text FROM messages').get()!.text).toBe('После рестарта');
    const history = await restarted.app.inject({
      url: '/api/history',
      headers: { cookie: u.cookie },
    });
    expect(history.json()[0].position).toBe(42);
  });
  it('rejects cross-origin requests and forged sessions', async () => {
    const x = await setup(),
      u = await x.user();
    expect(
      (await u.request('POST', '/api/rooms', {}, { origin: 'https://evil.example' })).statusCode,
    ).toBe(403);
    const forged = await x.app.inject({
      url: '/api/me',
      headers: { cookie: u.cookie + 'tampered' },
    });
    expect(forged.json().user.id).not.toBe(u.me.id);
  });
  it('checks MP4 signatures, private Range access, and restores a live SQLite backup', async () => {
    const x = await setup(),
      owner = await x.user(),
      stranger = await x.user();
    const boundary = 'zuno-boundary';
    const upload = async (data: Buffer) =>
      x.app.inject({
        method: 'POST',
        url: '/api/videos',
        headers: {
          cookie: owner.cookie,
          origin,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
          ),
          data,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    expect((await upload(Buffer.from('not a video'))).statusCode).toBe(400);
    const file = (await upload(Buffer.from('0000ftypisom00000000000000000000'))).json();
    expect(file.id).toBeTruthy();
    expect((await x.app.inject({ url: '/api/videos/' + file.id })).statusCode).toBe(401);
    expect((await stranger.request('GET', '/api/videos/' + file.id)).statusCode).toBe(404);
    const partial = await owner.request('GET', '/api/videos/' + file.id, undefined, {
      range: 'bytes=4-7',
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe('ftyp');
    expect(
      (await owner.request('GET', '/api/videos/' + file.id, undefined, { range: 'bytes=999-' }))
        .statusCode,
    ).toBe(416);
    const room = (await owner.request('POST', '/api/rooms', {})).json();
    await stranger.request('POST', '/api/join', { token: room.inviteToken });
    const s = await owner.socket();
    await ack(s, 'join', room.id);
    await ack(s, 'command', {
      roomId: room.id,
      revision: 0,
      action: 'source',
      sourceType: 'file',
      sourceId: file.id,
    });
    expect((await stranger.request('GET', '/api/videos/' + file.id)).statusCode).toBe(200);
    await ack(s, 'chat', { roomId: room.id, text: 'Сохраняется после восстановления' });
    const dest = join(x.dir, 'restore.sqlite');
    await backup(x.db, dest);
    const restored = new DatabaseSync(dest);
    expect(restored.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    expect(restored.prepare('SELECT text FROM messages').get()!.text).toBe(
      'Сохраняется после восстановления',
    );
    restored.close();
  });
});
