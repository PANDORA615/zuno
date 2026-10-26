import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { Server } from 'socket.io';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statfsSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { openDatabase } from './db.js';

export interface Playback {
  sourceType: 'none' | 'mp4' | 'youtube' | 'file';
  sourceId: string;
  positionSeconds: number;
  isPlaying: boolean;
  updatedAt: number;
  revision: number;
  actorId: string;
}
type Room = {
  id: string;
  host_id: string;
  invite_hash: string;
  both_control: number;
  state: string;
  touched_at: number;
};
const id = () => randomBytes(24).toString('base64url');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function position(s: Playback, now = Date.now()) {
  return s.positionSeconds + (s.isPlaying ? Math.max(0, now - s.updatedAt) / 1000 : 0);
}
export function parseSource(
  type: unknown,
  value: unknown,
): { sourceType: Playback['sourceType']; sourceId: string } {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Некорректный источник');
  if (type === 'file' && /^[\w-]{32}$/.test(value)) return { sourceType: 'file', sourceId: value };
  if (type === 'youtube') {
    let videoId = value;
    if (!/^[\w-]{11}$/.test(value)) {
      const u = new URL(value);
      if (u.protocol !== 'https:') throw Error('Требуется HTTPS');
      if (u.hostname === 'youtu.be') videoId = u.pathname.slice(1);
      else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname))
        videoId =
          u.searchParams.get('v') ||
          u.pathname.match(/^\/(?:embed|shorts)\/([\w-]{11})$/)?.[1] ||
          '';
      else throw Error('Требуется ссылка YouTube');
    }
    if (!/^[\w-]{11}$/.test(videoId)) throw Error('Некорректный YouTube ID');
    return { sourceType: 'youtube', sourceId: videoId };
  }
  if (type === 'mp4') {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password)
      throw Error('Требуется прямая HTTPS-ссылка MP4');
    return { sourceType: 'mp4', sourceId: u.href };
  }
  throw Error('Источник пока не поддерживается');
}
export async function createApp(
  options: {
    dataDir?: string;
    secret?: string;
    origin?: string;
    production?: boolean;
    staticDir?: string;
    logger?: boolean;
  } = {},
) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const secret = options.secret ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw Error('SESSION_SECRET должен содержать минимум 32 символа');
  const origin = options.origin ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173';
  if (production && !origin.startsWith('https://'))
    throw Error('PUBLIC_ORIGIN должен использовать HTTPS');
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? '.data');
  const db = openDatabase(dataDir);
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 16 * 1024,
    trustProxy: '127.0.0.1',
  });
  const maxUpload = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 50)) * 1024 ** 2;
  const quota = Math.max(1, Number(process.env.STORAGE_QUOTA_MB || 200)) * 1024 ** 2;
  await app.register(cookie, { secret });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: maxUpload, files: 1, fields: 0, parts: 1 } });
  const getRoom = (roomId: string) =>
    db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId) as Room | undefined;
  const member = (roomId: string, userId: string) =>
    !!db.prepare('SELECT 1 FROM members WHERE room_id=? AND user_id=?').get(roomId, userId);
  const canFile = (fileId: string, userId: string) => {
    const v = db.prepare('SELECT * FROM videos WHERE id=?').get(fileId) as any;
    if (!v) return undefined;
    if (v.owner_id === userId) return v;
    const rows = db
      .prepare('SELECT r.state FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=?')
      .all(userId);
    return rows.some((r) => {
      const s = JSON.parse(String(r.state));
      return s.sourceType === 'file' && s.sourceId === fileId;
    })
      ? v
      : undefined;
  };
  const userFromCookie = (header: string | undefined) => {
    const signed = app.parseCookie(header || '').zuno;
    if (!signed) return undefined;
    const decoded = app.unsignCookie(signed);
    return decoded.valid && decoded.value
      ? (db.prepare('SELECT id,nickname FROM users WHERE id=?').get(decoded.value) as
          { id: string; nickname: string } | undefined)
      : undefined;
  };
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && req.url !== '/api/health') {
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin)
        return reply.code(403).send({ error: 'Недопустимый Origin' });
      let user = userFromCookie(req.headers.cookie);
      if (!user) {
        if (req.url.startsWith('/api/videos/') && ['GET', 'HEAD'].includes(req.method))
          return reply.code(401).send({ error: 'Требуется сессия' });
        user = { id: id(), nickname: 'Гость' };
        db.prepare('INSERT INTO users VALUES(?,?,?)').run(user.id, user.nickname, Date.now());
        reply.setCookie('zuno', user.id, {
          signed: true,
          httpOnly: true,
          secure: production,
          sameSite: 'strict',
          path: '/',
          maxAge: 365 * 24 * 3600,
        });
      }
      (req as any).user = user;
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; connect-src 'self' ws: wss:; media-src 'self' https: blob:; frame-src https://www.youtube.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    if (_req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const uid = (req: any): string => req.user.id;
  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({ user: (req as any).user, limits: { maxUpload, quota } }));
  app.patch('/api/me', async (req, reply) => {
    const nickname = String((req.body as any)?.nickname || '').trim();
    if (!nickname || nickname.length > 32)
      return reply.code(400).send({ error: 'Ник: от 1 до 32 символов' });
    db.prepare('UPDATE users SET nickname=? WHERE id=?').run(nickname, uid(req));
    return { id: uid(req), nickname };
  });
  app.post('/api/rooms', async (req, reply) => {
    if (
      Number(db.prepare('SELECT count(*) AS n FROM rooms WHERE host_id=?').get(uid(req))!.n) >= 20
    )
      return reply.code(429).send({ error: 'Лимит: 20 комнат на ведущего' });
    const roomId = id(),
      token = id();
    const state: Playback = {
      sourceType: 'none',
      sourceId: '',
      positionSeconds: 0,
      isPlaying: false,
      updatedAt: Date.now(),
      revision: 0,
      actorId: uid(req),
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO rooms VALUES(?,?,?,?,?,?)').run(
        roomId,
        uid(req),
        hash(token),
        0,
        JSON.stringify(state),
        Date.now(),
      );
      db.prepare('INSERT INTO members VALUES(?,?)').run(roomId, uid(req));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { id: roomId, inviteToken: token };
  });
  app.post('/api/join', async (req, reply) => {
    const token = (req.body as any)?.token;
    if (typeof token !== 'string' || !/^[\w-]{32}$/.test(token))
      return reply.code(404).send({ error: 'Приглашение недействительно' });
    const r = db.prepare('SELECT * FROM rooms WHERE invite_hash=?').get(hash(token)) as
      Room | undefined;
    if (!r) return reply.code(404).send({ error: 'Приглашение отозвано или комната удалена' });
    if (!member(r.id, uid(req))) {
      const count = db
        .prepare('SELECT count(*) AS n FROM members WHERE room_id=?')
        .get(r.id) as any;
      if (count.n >= 5) return reply.code(409).send({ error: 'В комнате уже пять участников' });
      db.prepare('INSERT INTO members VALUES(?,?)').run(r.id, uid(req));
    }
    db.prepare('UPDATE rooms SET touched_at=? WHERE id=?').run(Date.now(), r.id);
    return { id: r.id };
  });
  app.get('/api/rooms', async (req) =>
    db
      .prepare(
        'SELECT r.id,r.host_id,r.state,r.touched_at FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=? ORDER BY r.touched_at DESC',
      )
      .all(uid(req)),
  );
  app.get('/api/history', async (req) =>
    db
      .prepare('SELECT * FROM history WHERE user_id=? ORDER BY updated_at DESC LIMIT 100')
      .all(uid(req)),
  );
  app.post('/api/rooms/:id/invite', async (req, reply) => {
    const r = getRoom((req.params as any).id);
    if (!r || r.host_id !== uid(req))
      return reply.code(403).send({ error: 'Только создатель комнаты' });
    const token = id();
    db.prepare('UPDATE rooms SET invite_hash=? WHERE id=?').run(hash(token), r.id);
    return { inviteToken: token };
  });
  app.post('/api/rooms/:id/control', async (req, reply) => {
    const r = getRoom((req.params as any).id);
    if (!r || r.host_id !== uid(req))
      return reply.code(403).send({ error: 'Только создатель комнаты' });
    db.prepare('UPDATE rooms SET both_control=? WHERE id=?').run(
      (req.body as any)?.enabled === true ? 1 : 0,
      r.id,
    );
    io.to(r.id).emit('snapshot', snapshot(r.id));
    return { ok: true };
  });
  app.post('/api/rooms/:id/revoke', async (req, reply) => {
    const r = getRoom((req.params as any).id);
    if (!r || r.host_id !== uid(req))
      return reply.code(403).send({ error: 'Только создатель комнаты' });
    db.prepare('DELETE FROM members WHERE room_id=? AND user_id!=?').run(r.id, r.host_id);
    db.prepare('UPDATE rooms SET invite_hash=? WHERE id=?').run(hash(id()), r.id);
    for (const s of io.sockets.sockets.values())
      if (s.rooms.has(r.id) && s.data.user.id !== r.host_id) s.disconnect(true);
    io.to(r.id).emit('snapshot', snapshot(r.id));
    return { ok: true };
  });
  app.get('/api/videos', async (req) =>
    db
      .prepare('SELECT id,name,size FROM videos WHERE owner_id=? ORDER BY created_at DESC')
      .all(uid(req)),
  );
  let uploading = false;
  app.post(
    '/api/videos',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (uploading) return reply.code(429).send({ error: 'Дождитесь окончания текущей загрузки' });
      uploading = true;
      const fileId = id(),
        path = join(dataDir, 'videos', fileId);
      let saved = false;
      try {
        const used = Number(db.prepare('SELECT coalesce(sum(size),0) AS n FROM videos').get()!.n);
        const fs = statfsSync(dataDir);
        const remaining = Math.min(maxUpload, quota - used, fs.bavail * fs.bsize - 100 * 1024 ** 2);
        if (remaining <= 0)
          return reply.code(507).send({ error: 'Недостаточно места или исчерпана квота' });
        const part = await req.file();
        if (!part || part.mimetype !== 'video/mp4')
          return reply.code(400).send({ error: 'Принимаются только MP4' });
        let size = 0;
        let header = Buffer.alloc(0);
        const guard = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            if (header.length < 12) header = Buffer.concat([header, chunk]).subarray(0, 12);
            cb(size > remaining ? Error('Превышен лимит файла/диска') : null, chunk);
          },
        });
        await pipeline(part.file, guard, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated || header.length < 12 || header.toString('ascii', 4, 8) !== 'ftyp')
          return reply.code(400).send({ error: 'Неверная MP4-сигнатура или превышен лимит' });
        // Filenames are display-only; strip control characters and path separators.
        // eslint-disable-next-line no-control-regex
        const name = part.filename.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 120) || 'video.mp4';
        db.prepare('INSERT INTO videos VALUES(?,?,?,?,?)').run(
          fileId,
          uid(req),
          name,
          size,
          Date.now(),
        );
        saved = true;
        return { id: fileId, name, size };
      } finally {
        uploading = false;
        if (!saved && existsSync(path)) unlinkSync(path);
      }
    },
  );
  app.delete('/api/videos/:id', async (req, reply) => {
    const fileId = (req.params as any).id;
    const v = db.prepare('SELECT * FROM videos WHERE id=? AND owner_id=?').get(fileId, uid(req));
    if (!v) return reply.code(404).send({ error: 'Файл не найден' });
    const inUse = db
      .prepare('SELECT state FROM rooms')
      .all()
      .some((r) => {
        const s = JSON.parse(String(r.state));
        return s.sourceType === 'file' && s.sourceId === fileId;
      });
    if (inUse)
      return reply
        .code(409)
        .send({ error: 'Сначала смените видео в комнатах, использующих этот файл' });
    if (existsSync(join(dataDir, 'videos', fileId))) unlinkSync(join(dataDir, 'videos', fileId));
    db.prepare('DELETE FROM videos WHERE id=?').run(fileId);
    return { ok: true };
  });
  app.get('/api/videos/:id', async (req, reply) => {
    const fileId = (req.params as any).id;
    const v = canFile(fileId, uid(req));
    if (!v) return reply.code(404).send({ error: 'Файл недоступен' });
    const size = Number(v.size),
      range = req.headers.range;
    reply.type('video/mp4').header('Accept-Ranges', 'bytes');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2]))
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      )
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', end - start + 1)
        .send(createReadStream(join(dataDir, 'videos', fileId), { start, end }));
    }
    return reply
      .header('Content-Length', size)
      .send(createReadStream(join(dataDir, 'videos', fileId)));
  });
  const io = new Server(app.server, {
    maxHttpBufferSize: 16 * 1024,
    serveClient: false,
    allowRequest: (req, cb) =>
      cb(
        null,
        req.headers.origin === origin ||
          (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin'),
      ),
  });
  const snapshot = (roomId: string) => {
    const r = getRoom(roomId)!;
    const online = new Set(
      [...io.sockets.sockets.values()]
        .filter((s) => s.rooms.has(roomId))
        .map((s) => s.data.user.id),
    );
    return {
      id: r.id,
      hostId: r.host_id,
      bothControl: !!r.both_control,
      state: JSON.parse(r.state),
      serverNow: Date.now(),
      members: db
        .prepare(
          'SELECT u.id,u.nickname FROM users u JOIN members m ON m.user_id=u.id WHERE m.room_id=?',
        )
        .all(roomId)
        .map((u) => ({ ...u, online: online.has(u.id) })),
      messages: db
        .prepare(
          'SELECT id,user_id AS userId,nickname,text,created_at AS createdAt FROM (SELECT * FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 100) ORDER BY id',
        )
        .all(roomId),
    };
  };
  const saveProgress = (userId: string, r: Room, duration?: number) => {
    const s = JSON.parse(r.state) as Playback;
    if (s.sourceType === 'none') return;
    const pos = position(s);
    db.prepare(
      'INSERT INTO history VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,room_id,source_id) DO UPDATE SET position=excluded.position,duration=coalesce(excluded.duration,history.duration),updated_at=excluded.updated_at',
    ).run(userId, r.id, s.sourceId, s.sourceType, pos, duration ?? null, Date.now());
  };
  io.use((s, next) => {
    const u = userFromCookie(s.request.headers.cookie);
    if (!u) return next(Error('Требуется сессия'));
    s.data.user = u;
    next();
  });
  io.on('connection', (s) => {
    const userId = s.data.user.id;
    let windowStart = Date.now(),
      events = 0;
    s.use((_packet, next) => {
      if (Date.now() - windowStart > 10000) {
        windowStart = Date.now();
        events = 0;
      }
      next(++events > 100 ? Error('Слишком много событий') : undefined);
    });
    s.on('error', () => s.emit('problem', 'Слишком много команд. Подождите.'));
    s.on('join', (roomId: unknown, ack) => {
      if (typeof roomId !== 'string' || !member(roomId, userId))
        return typeof ack === 'function' && ack({ error: 'Нет доступа к комнате' });
      for (const old of s.rooms)
        if (old !== s.id) {
          s.leave(old);
          io.to(old).emit('snapshot', snapshot(old));
        }
      s.join(roomId);
      db.prepare('UPDATE rooms SET touched_at=? WHERE id=?').run(Date.now(), roomId);
      io.to(roomId).emit('snapshot', snapshot(roomId));
      if (typeof ack === 'function') ack({ ok: true });
    });
    const allowed = (roomId: unknown) =>
      typeof roomId === 'string' && s.rooms.has(roomId) && member(roomId, userId)
        ? getRoom(roomId)
        : undefined;
    s.on('command', (cmd: any, ack) => {
      const respond = (v: any) => {
        if (typeof ack === 'function') ack(v);
      };
      const r = allowed(cmd?.roomId);
      if (!r || (r.host_id !== userId && !r.both_control))
        return respond({ error: 'Управлять может только ведущий' });
      const state = JSON.parse(r.state) as Playback;
      if (cmd.revision !== state.revision)
        return respond({
          error: 'Состояние изменилось; повторите действие',
          snapshot: snapshot(r.id),
        });
      try {
        if (cmd.action === 'source') {
          const source = parseSource(cmd.sourceType, cmd.sourceId);
          if (source.sourceType === 'file' && !canFile(source.sourceId, userId))
            throw Error('Нет доступа к файлу');
          saveProgress(userId, r);
          Object.assign(state, source, { positionSeconds: 0, isPlaying: false });
        } else if (['play', 'pause', 'seek'].includes(cmd.action)) {
          if (state.sourceType === 'none') throw Error('Сначала выберите видео');
          const pos = Number(cmd.positionSeconds);
          if (!Number.isFinite(pos) || pos < 0 || pos > 604800) throw Error('Некорректная позиция');
          state.positionSeconds = pos;
          if (cmd.action === 'play') state.isPlaying = true;
          if (cmd.action === 'pause') state.isPlaying = false;
        } else throw Error('Неизвестная команда');
        state.revision++;
        state.updatedAt = Date.now();
        state.actorId = userId;
        db.prepare('UPDATE rooms SET state=?,touched_at=? WHERE id=?').run(
          JSON.stringify(state),
          Date.now(),
          r.id,
        );
        const watching = new Set(
          [...io.sockets.sockets.values()]
            .filter((sock) => sock.rooms.has(r.id))
            .map((sock) => String(sock.data.user.id)),
        );
        for (const watchingId of watching)
          saveProgress(watchingId, { ...r, state: JSON.stringify(state) });
        io.to(r.id).emit('state', { state, serverNow: Date.now() });
        respond({ ok: true });
      } catch (e) {
        respond({ error: (e as Error).message });
      }
    });
    s.on('chat', (payload: any, ack) => {
      const r = allowed(payload?.roomId),
        text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!r || !text || text.length > 1000)
        return typeof ack === 'function' && ack({ error: 'Сообщение: 1–1000 символов' });
      const last = db
        .prepare('SELECT created_at FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 1')
        .get(userId) as any;
      if (last && Date.now() - last.created_at < 700)
        return typeof ack === 'function' && ack({ error: 'Подождите перед следующим сообщением' });
      const nickname = String(
          db.prepare('SELECT nickname FROM users WHERE id=?').get(userId)!.nickname,
        ),
        now = Date.now();
      const result = db
        .prepare('INSERT INTO messages(room_id,user_id,nickname,text,created_at) VALUES(?,?,?,?,?)')
        .run(r.id, userId, nickname, text, now);
      db.prepare(
        'DELETE FROM messages WHERE room_id=? AND id NOT IN (SELECT id FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 100)',
      ).run(r.id, r.id);
      db.prepare('UPDATE rooms SET touched_at=? WHERE id=?').run(now, r.id);
      io.to(r.id).emit('message', {
        id: Number(result.lastInsertRowid),
        userId,
        nickname,
        text,
        createdAt: now,
      });
      if (typeof ack === 'function') ack({ ok: true });
    });
    s.on('sync', (roomId: unknown) => {
      const r = allowed(roomId);
      if (r) s.emit('state', { state: JSON.parse(r.state), serverNow: Date.now() });
    });
    s.on('progress', (p: any) => {
      const r = allowed(p?.roomId);
      if (!r) return;
      const d = Number(p.duration);
      saveProgress(userId, r, Number.isFinite(d) && d > 0 && d <= 604800 ? d : undefined);
      db.prepare('UPDATE rooms SET touched_at=? WHERE id=?').run(Date.now(), r.id);
    });
    s.on('disconnecting', () => {
      for (const roomId of s.rooms)
        if (roomId !== s.id) {
          const r = getRoom(roomId);
          if (r && member(roomId, userId)) saveProgress(userId, r);
        }
    });
    s.on('disconnect', () => {
      for (const r of db.prepare('SELECT room_id FROM members WHERE user_id=?').all(userId))
        io.to(String(r.room_id)).emit('snapshot', snapshot(String(r.room_id)));
    });
  });
  const cleanup = () =>
    db
      .prepare('DELETE FROM rooms WHERE touched_at<?')
      .run(Date.now() - Number(process.env.ROOM_TTL_DAYS || 30) * 86400000);
  cleanup();
  const timer = setInterval(cleanup, 3600000);
  timer.unref();
  const web = options.staticDir ?? resolve('dist/web');
  if (existsSync(web)) {
    // Serve only a pre-enumerated set of public build files. Never map a request
    // path onto the filesystem; dataDir and uploaded files are not in this map.
    const publicFiles = new Map<string, string>();
    const scan = (dir: string, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix + '/' + entry.name,
          absolute = join(dir, entry.name);
        if (entry.isDirectory()) scan(absolute, relative);
        else if (entry.isFile()) publicFiles.set(relative, absolute);
      }
    };
    scan(web);
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
    };
    app.get('/*', async (req, reply) => {
      let path: string;
      try {
        path = decodeURIComponent(req.url.split('?')[0]);
      } catch {
        return reply.code(400).send({ error: 'Invalid path' });
      }
      const spa =
        ['/', '/sources', '/history', '/settings', '/videos'].includes(path) ||
        /^\/room\/[\w-]{32}$/.test(path);
      const file = publicFiles.get(path) || (spa ? publicFiles.get('/index.html') : undefined);
      if (!file) return reply.code(404).send({ error: 'Не найдено' });
      reply.type(mime[extname(file)] || 'application/octet-stream');
      reply.header(
        'Cache-Control',
        path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      return reply.send(createReadStream(file));
    });
  }
  app.setErrorHandler((error, req, reply) => {
    req.log.error({ err: error }, 'Request failed');
    reply.code((error as any).statusCode || 400).send({ error: (error as Error).message });
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    db.close();
  });
  return { app, io, db };
}
