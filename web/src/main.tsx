import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  CssBaseline,
  Divider,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  ThemeProvider,
  Toolbar,
  Typography,
  createTheme,
} from '@mui/material';
import { io, Socket } from 'socket.io-client';
import { Player, Playback } from './player';
import './style.css';
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch('/api' + path, {
    method,
    headers:
      body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Ошибка запроса');
  return data;
}
type User = { id: string; nickname: string };
type Message = { id: number; userId: string; nickname: string; text: string; createdAt: number };
type Snapshot = {
  id: string;
  hostId: string;
  bothControl: boolean;
  state: Playback;
  serverNow: number;
  members: (User & { online: boolean })[];
  messages: Message[];
};
const sources = [
  {
    name: 'Прямая ссылка',
    symbol: '↗',
    type: 'mp4',
    status: 'MP4 · основной сценарий',
    text: 'Прямое HTTPS-видео. Файл загружается с источника в ваш браузер.',
  },
  {
    name: 'YouTube',
    symbol: '▶',
    type: 'youtube',
    status: 'Нужна проверка на устройствах',
    text: 'Официальный IFrame API. Доступность зависит от видео и региона.',
  },
  {
    name: 'Свои видео',
    symbol: '▣',
    type: 'file',
    status: 'MP4 · до 50 МБ по умолчанию',
    text: 'Приватные файлы с проверкой доступа и поддержкой перемотки.',
  },
  {
    name: 'RUTUBE',
    symbol: 'R',
    type: 'rutube',
    status: 'Недоступно',
    text: 'Адаптер зарезервирован. Управление плеером ещё не проверено.',
  },
  {
    name: 'VK Видео',
    symbol: 'VK',
    type: 'vk',
    status: 'Недоступно',
    text: 'Официальная интеграция требует исследования API.',
  },
  {
    name: 'Другие сайты',
    symbol: '◇',
    type: 'other',
    status: 'Недоступно',
    text: 'Произвольные iframe не поддерживаются. HLS — следующий этап.',
  },
];
function App() {
  const [mode, setMode] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('zuno-theme') === 'light' ? 'light' : 'dark',
  );
  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode,
          primary: { main: mode === 'dark' ? '#c8adff' : '#6841b7' },
          secondary: { main: '#91d7c5' },
          background: {
            default: mode === 'dark' ? '#100f16' : '#f7f4fb',
            paper: mode === 'dark' ? '#1c1925' : '#fff',
          },
        },
        shape: { borderRadius: 20 },
        typography: { fontFamily: 'Inter, system-ui, sans-serif', h3: { fontWeight: 700 } },
        components: {
          MuiButton: {
            styleOverrides: {
              root: { textTransform: 'none', borderRadius: 24, padding: '10px 22px' },
            },
          },
          MuiCard: {
            styleOverrides: {
              root: {
                backgroundImage: 'none',
                border: '1px solid ' + (mode === 'dark' ? '#302a3d' : '#e9e1f2'),
              },
            },
          },
        },
      }),
    [mode],
  );
  const [page, setPage] = useState(location.pathname),
    [me, setMe] = useState<User>(),
    [error, setError] = useState(''),
    [nickname, setNickname] = useState(''),
    [rooms, setRooms] = useState<any[]>([]),
    [history, setHistory] = useState<any[]>([]),
    [videos, setVideos] = useState<any[]>([]),
    [limits, setLimits] = useState({ maxUpload: 50 * 1024 ** 2, quota: 200 * 1024 ** 2 });
  const [snap, setSnap] = useState<Snapshot>(),
    [connected, setConnected] = useState(false),
    [clockOffset, setClockOffset] = useState(0),
    [chat, setChat] = useState(''),
    [sourceType, setSourceType] = useState('mp4'),
    [source, setSource] = useState(''),
    [invite, setInvite] = useState(''),
    [busy, setBusy] = useState(false);
  const socket = useRef<Socket | null>(null),
    latest = useRef(snap),
    duration = useRef<number>(0);
  latest.current = snap;
  const roomId = page.match(/^\/room\/([\w-]+)$/)?.[1];
  const go = (p: string) => {
    window.history.pushState({}, '', p);
    setPage(p);
    setError('');
  };
  const refresh = async () => {
    setRooms(await api('/rooms'));
    setVideos(await api('/videos'));
    setHistory(await api('/history'));
  };
  const act = (fn: () => Promise<void>) => {
    setError('');
    void fn().catch((e) => setError(e.message));
  };
  useEffect(() => {
    const f = () => setPage(location.pathname);
    addEventListener('popstate', f);
    return () => removeEventListener('popstate', f);
  }, []);
  useEffect(() => {
    act(async () => {
      const data = await api('/me');
      setMe(data.user);
      setNickname(data.user.nickname);
      setLimits(data.limits);
      const token = new URLSearchParams(location.hash.slice(1)).get('invite');
      if (token) {
        window.history.replaceState({}, '', location.pathname);
        const r = await api('/join', 'POST', { token });
        go('/room/' + r.id);
      }
      await refresh();
    });
  }, []);
  useEffect(() => {
    if (!me || !roomId) return;
    setSnap(undefined);
    setConnected(false);
    setInvite('');
    duration.current = 0;
    const s = io({ autoConnect: false });
    socket.current = s;
    s.on('connect', () => {
      s.emit('join', roomId, (r: any) => {
        if (r.error) setError(r.error);
        else setConnected(true);
      });
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () =>
      setError('Не удалось подключиться. Обновите страницу или проверьте сеть.'),
    );
    s.on('snapshot', (data: Snapshot) => {
      setSnap(data);
      setClockOffset(data.serverNow - Date.now());
    });
    s.on('state', (data: { state: Playback; serverNow: number }) => {
      setSnap((old) =>
        old && data.state.revision >= old.state.revision ? { ...old, state: data.state } : old,
      );
      setClockOffset(data.serverNow - Date.now());
    });
    s.on('message', (m: Message) =>
      setSnap((old) => (old ? { ...old, messages: [...old.messages, m].slice(-100) } : old)),
    );
    s.on('problem', setError);
    s.connect();
    const t = setInterval(() => {
      if (latest.current?.state.isPlaying)
        s.emit('progress', { roomId, duration: duration.current });
    }, 12000);
    const progress = () => s.emit('progress', { roomId, duration: duration.current });
    addEventListener('pagehide', progress);
    const offline = () => {
        setConnected(false);
        s.disconnect();
      },
      online = () => s.connect();
    addEventListener('offline', offline);
    addEventListener('online', online);
    return () => {
      progress();
      removeEventListener('offline', offline);
      removeEventListener('online', online);
      removeEventListener('pagehide', progress);
      clearInterval(t);
      s.disconnect();
      socket.current = null;
    };
  }, [me?.id, roomId]);
  useEffect(() => {
    if (me) act(refresh);
  }, [page]);
  const create = () =>
    act(async () => {
      const r = await api('/rooms', 'POST', {});
      sessionStorage.setItem('invite:' + r.id, r.inviteToken);
      go('/room/' + r.id);
    });
  const command = (action: string, positionSeconds = 0, extra: Record<string, unknown> = {}) => {
    const r = latest.current;
    if (!r || !socket.current?.connected) {
      setError('Нет соединения с комнатой');
      return;
    }
    socket.current
      .timeout(5000)
      .emit(
        'command',
        { roomId: r.id, revision: r.state.revision, action, positionSeconds, ...extra },
        (err: any, result: any) => {
          if (err) setError('Команда не подтверждена. Синхронизируйте состояние.');
          else if (result.error) {
            setError(result.error);
            if (result.snapshot) setSnap(result.snapshot);
          }
        },
      );
  };
  const host = me?.id === snap?.hostId,
    canControl = !!(host || snap?.bothControl);
  const invitation = invite || (roomId ? sessionStorage.getItem('invite:' + roomId) || '' : '');
  const upload = (file: File) =>
    act(async () => {
      setBusy(true);
      try {
        const body = new FormData();
        body.append('file', file);
        await api('/videos', 'POST', body);
        await refresh();
      } finally {
        setBusy(false);
      }
    });
  const nav = [
    ['/', 'Главная'],
    ['/sources', 'Сервисы'],
    ['/videos', 'Свои видео'],
    ['/history', 'История'],
    ['/settings', 'Настройки'],
  ];
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar className="toolbar">
          <Button className="brand" onClick={() => go('/')}>
            zuno<span>●</span>
          </Button>
          <Box className="nav">
            {nav.map(([p, label]) => (
              <Button key={p} color={page === p ? 'primary' : 'inherit'} onClick={() => go(p)}>
                {label}
              </Button>
            ))}
          </Box>
          <Chip label={me?.nickname || 'Подключение…'} variant="outlined" />
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 5 } }}>
        {error && (
          <Alert severity="error" onClose={() => setError('')} sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}
        {page === '/' && (
          <>
            <section className="hero">
              <Chip label="ДО 5 ЧЕЛОВЕК · ПРИВАТНО" />
              <Typography
                variant="h3"
                component="h1"
                sx={{ mt: 3, mb: 2, fontSize: { xs: '2.5rem', md: '4.5rem' }, maxWidth: 700 }}
              >
                Далеко друг от друга.
                <br />
                <span className="accent">Близко в одном кадре.</span>
              </Typography>
              <Typography color="text.secondary" sx={{ maxWidth: 520, mb: 4 }}>
                Фильм, разговор и человек рядом. Создайте комнату, отправьте приглашение и смотрите
                вместе в своём ритме.
              </Typography>
              <Button variant="contained" size="large" onClick={create} disabled={!me}>
                Создать комнату ↗
              </Button>
              <Typography variant="caption" display="block" sx={{ mt: 2 }} color="text.secondary">
                До 5 участников · без регистрации · видео без проксирования
              </Typography>
            </section>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ mt: 5, mb: 2 }}
            >
              <Typography variant="h5">Ваши комнаты</Typography>
              <Button onClick={() => go('/sources')}>Все источники →</Button>
            </Stack>
            {rooms.length ? (
              <div className="grid">
                {rooms.map((r) => (
                  <Card key={r.id}>
                    <CardContent>
                      <Typography variant="h6">Ваш общий вечер</Typography>
                      <Typography color="text.secondary" sx={{ my: 1 }}>
                        Последняя активность: {new Date(r.touched_at).toLocaleString('ru-RU')}
                      </Typography>
                      <Button onClick={() => go('/room/' + r.id)}>Войти в комнату →</Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent>
                  <Typography color="text.secondary">
                    Здесь появятся ваши комнаты. Первая — в одном нажатии.
                  </Typography>
                </CardContent>
              </Card>
            )}
          </>
        )}
        {page === '/sources' && (
          <>
            <Typography variant="h3" component="h1" gutterBottom>
              Что посмотрим?
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 4 }}>
              Состояние интеграций указано честно: внешние сервисы требуют проверки на ваших
              устройствах.
            </Typography>
            <div className="grid">
              {sources.map((s) => (
                <Card key={s.type}>
                  <CardContent>
                    <div className={'source-icon ' + s.type}>{s.symbol}</div>
                    <Typography variant="h5" sx={{ my: 2 }}>
                      {s.name}
                    </Typography>
                    <Chip size="small" label={s.status} />
                    <Typography color="text.secondary" sx={{ my: 2, minHeight: 60 }}>
                      {s.text}
                    </Typography>
                    <Button
                      disabled={!['mp4', 'file', 'youtube'].includes(s.type)}
                      onClick={
                        s.type === 'file'
                          ? () => go('/videos')
                          : () => {
                              setSourceType(s.type);
                              create();
                            }
                      }
                    >
                      Выбрать →
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
            <Alert severity="info" sx={{ mt: 3 }}>
              Здесь используются текстовые названия и нейтральные значки. Официальные бренд-ассеты
              не включены: разрешённые файлы и условия их использования ещё не проверены.
            </Alert>
          </>
        )}
        {roomId && (
          <>
            {snap ? (
              <>
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  flexWrap="wrap"
                  gap={2}
                  sx={{ mb: 3 }}
                >
                  <div>
                    <Typography variant="h4">Ваш общий вечер</Typography>
                    <Typography color="text.secondary">
                      {snap.members
                        .map(
                          (m) =>
                            `${m.online ? '●' : '○'} ${m.nickname}${m.id === snap.hostId ? ' · ведущий' : ''}`,
                        )
                        .join('   /   ')}
                    </Typography>
                  </div>
                  <Stack direction="row" spacing={1}>
                    <Chip
                      color={connected ? 'success' : 'warning'}
                      label={connected ? 'В комнате' : 'Переподключение…'}
                    />
                    <Button onClick={() => socket.current?.emit('sync', roomId)}>
                      Синхронизировать
                    </Button>
                  </Stack>
                </Stack>
                <div className="room-layout">
                  <Stack spacing={3}>
                    <Card>
                      <CardContent>
                        <Player
                          state={snap.state}
                          clockOffset={clockOffset}
                          connected={connected}
                          canControl={canControl}
                          onCommand={command}
                          onDuration={(d) => {
                            duration.current = d;
                            socket.current?.emit('progress', { roomId, duration: d });
                          }}
                        />
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Видео для вашего вечера
                        </Typography>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                          <Select
                            size="small"
                            value={sourceType}
                            onChange={(e) => {
                              setSourceType(e.target.value);
                              setSource('');
                            }}
                            aria-label="Источник"
                          >
                            <MenuItem value="mp4">Прямая MP4-ссылка</MenuItem>
                            <MenuItem value="youtube">YouTube</MenuItem>
                            <MenuItem value="file">Свой файл</MenuItem>
                          </Select>
                          {sourceType === 'file' ? (
                            <Select
                              fullWidth
                              size="small"
                              value={source}
                              onChange={(e) => setSource(e.target.value)}
                              displayEmpty
                              aria-label="Файл"
                            >
                              <MenuItem value="">Выберите MP4</MenuItem>
                              {videos.map((v) => (
                                <MenuItem key={v.id} value={v.id}>
                                  {v.name}
                                </MenuItem>
                              ))}
                            </Select>
                          ) : (
                            <TextField
                              fullWidth
                              size="small"
                              label={
                                sourceType === 'youtube'
                                  ? 'Ссылка YouTube или ID'
                                  : 'HTTPS-ссылка на MP4'
                              }
                              value={source}
                              onChange={(e) => setSource(e.target.value)}
                            />
                          )}
                          <Button
                            variant="contained"
                            disabled={!connected || !canControl || !source}
                            onClick={() => command('source', 0, { sourceType, sourceId: source })}
                          >
                            Открыть
                          </Button>
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          Управляет:{' '}
                          {snap.members.find((m) => m.id === snap.state.actorId)?.nickname ||
                            'ведущий'}
                          . {canControl ? 'Вы можете управлять видео.' : 'Управление у ведущего.'}
                        </Typography>
                      </CardContent>
                    </Card>
                    {host && (
                      <Card>
                        <CardContent>
                          <Typography variant="h6">Приглашение и доступ</Typography>
                          <Typography color="text.secondary" sx={{ my: 1 }}>
                            Ссылка открывает доступ участникам (до 5 человек). Не публикуйте её.
                          </Typography>
                          {invitation && (
                            <TextField
                              fullWidth
                              size="small"
                              label="Приватная ссылка"
                              value={`${location.origin}/#invite=${invitation}`}
                              slotProps={{ input: { readOnly: true } }}
                              sx={{ my: 1 }}
                            />
                          )}
                          <Stack direction="row" flexWrap="wrap" gap={1}>
                            <Button
                              onClick={() =>
                                act(async () => {
                                  if (!invitation) throw Error('Сначала создайте новую ссылку');
                                  await navigator.clipboard.writeText(
                                    `${location.origin}/#invite=${invitation}`,
                                  );
                                })
                              }
                            >
                              Копировать ссылку
                            </Button>
                            <Button
                              onClick={() =>
                                act(async () => {
                                  const r = await api(`/rooms/${roomId}/invite`, 'POST', {});
                                  setInvite(r.inviteToken);
                                  sessionStorage.setItem('invite:' + roomId, r.inviteToken);
                                })
                              }
                            >
                              Новая ссылка
                            </Button>
                            <Button
                              color="warning"
                              onClick={() => {
                                if (
                                  confirm(
                                    'Удалить всех приглашённых участников и отозвать приглашения?',
                                  )
                                )
                                  act(async () => {
                                    await api(`/rooms/${roomId}/revoke`, 'POST', {});
                                    setInvite('');
                                    sessionStorage.removeItem('invite:' + roomId);
                                  });
                              }}
                            >
                              Отозвать доступ
                            </Button>
                          </Stack>
                          <FormControlLabel
                            control={
                              <Switch
                                checked={snap.bothControl}
                                onChange={(_, enabled) =>
                                  act(async () => {
                                    await api(`/rooms/${roomId}/control`, 'POST', { enabled });
                                  })
                                }
                              />
                            }
                            label="Управлять могут все"
                          />
                        </CardContent>
                      </Card>
                    )}
                  </Stack>
                  <Card className="chat-card">
                    <CardContent>
                      <Typography variant="h6">
                        Разговор рядом <span className="accent">✦</span>
                      </Typography>
                      <Divider sx={{ my: 2 }} />
                      <div className="messages" aria-label="Сообщения чата">
                        {snap.messages.length ? (
                          snap.messages.map((m) => (
                            <div
                              className={'message ' + (m.userId === me?.id ? 'own' : '')}
                              key={m.id}
                            >
                              <Typography variant="caption" color="text.secondary">
                                {m.nickname} ·{' '}
                                {new Date(m.createdAt).toLocaleTimeString('ru-RU', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </Typography>
                              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                {m.text}
                              </Typography>
                            </div>
                          ))
                        ) : (
                          <Typography color="text.secondary">
                            Пока тихо. Поздоровайтесь 👋
                          </Typography>
                        )}
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          socket.current
                            ?.timeout(5000)
                            .emit('chat', { roomId, text: chat }, (err: any, r: any) => {
                              if (err || r.error)
                                setError(err ? 'Сообщение не доставлено' : r.error);
                              else setChat('');
                            });
                        }}
                      >
                        <TextField
                          fullWidth
                          size="small"
                          label="Сообщение"
                          value={chat}
                          onChange={(e) => setChat(e.target.value)}
                          slotProps={{ htmlInput: { maxLength: 1000 } }}
                        />
                        <Button
                          fullWidth
                          type="submit"
                          disabled={!connected || !chat.trim()}
                          sx={{ mt: 1 }}
                        >
                          Отправить ↑
                        </Button>
                      </form>
                    </CardContent>
                  </Card>
                </div>
              </>
            ) : (
              <Typography>Подключение к комнате…</Typography>
            )}
          </>
        )}
        {page === '/videos' && (
          <>
            <Typography variant="h3" component="h1" gutterBottom>
              Свои видео
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              MP4 (H.264/AAC), до {limits.maxUpload / 1024 ** 2} МБ. Общая квота:{' '}
              {limits.quota / 1024 ** 2} МБ. Крупные фильмы размещайте во внешнем хранилище с прямой
              HTTPS-ссылкой.
            </Typography>
            <Button component="label" variant="contained" disabled={busy}>
              {busy ? 'Загрузка…' : 'Загрузить MP4'}
              <input
                hidden
                type="file"
                accept="video/mp4"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                  e.target.value = '';
                }}
              />
            </Button>
            <div className="grid" style={{ marginTop: 24 }}>
              {videos.map((v) => (
                <Card key={v.id}>
                  <CardContent>
                    <Typography variant="h6">{v.name}</Typography>
                    <Typography color="text.secondary">
                      {(v.size / 1024 ** 2).toFixed(1)} МБ · приватно
                    </Typography>
                    <Button
                      onClick={() => {
                        setSourceType('file');
                        setSource(v.id);
                        create();
                      }}
                    >
                      Смотреть вместе
                    </Button>
                    <Button
                      color="warning"
                      onClick={() => {
                        if (confirm('Удалить видео?'))
                          act(async () => {
                            await api('/videos/' + v.id, 'DELETE');
                            await refresh();
                          });
                      }}
                    >
                      Удалить
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
        {page === '/history' && (
          <>
            <Typography variant="h3" component="h1" gutterBottom>
              Ваши истории вечеров
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              Личный прогресс сохраняется каждые 12 секунд воспроизведения и при паузе. Он привязан
              к cookie этого браузера.
            </Typography>
            <Stack spacing={2}>
              {history.length ? (
                history.map((h, i) => (
                  <Card key={i}>
                    <CardContent>
                      <Chip label={h.source_type} />
                      <Typography sx={{ my: 1, overflowWrap: 'anywhere' }}>
                        {h.source_id}
                      </Typography>
                      <Typography color="text.secondary">
                        {Math.floor(h.position / 60)} мин {Math.floor(h.position % 60)} с{' '}
                        {h.duration
                          ? `· ${Math.min(100, Math.round((h.position / h.duration) * 100))}%`
                          : ''}{' '}
                        · {new Date(h.updated_at).toLocaleString('ru-RU')}
                      </Typography>
                      <Button onClick={() => go('/room/' + h.room_id)}>
                        Вернуться в комнату →
                      </Button>
                    </CardContent>
                  </Card>
                ))
              ) : (
                <Typography>Первый просмотр ещё впереди.</Typography>
              )}
            </Stack>
          </>
        )}
        {page === '/settings' && (
          <Stack spacing={3} maxWidth={600}>
            <Typography variant="h3" component="h1">
              Как вам удобно
            </Typography>
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Ваш профиль
                </Typography>
                <TextField
                  fullWidth
                  label="Ваш ник"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  slotProps={{ htmlInput: { maxLength: 32 } }}
                />
                <Button
                  onClick={() =>
                    act(async () => {
                      setMe(await api('/me', 'PATCH', { nickname }));
                    })
                  }
                >
                  Сохранить ник
                </Button>
                <Typography color="text.secondary" variant="body2">
                  Сессия сохраняется на год. Не очищайте cookie, чтобы сохранить доступ к своим
                  комнатам и истории.
                </Typography>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <FormControlLabel
                  label="Светлая тема"
                  control={
                    <Switch
                      checked={mode === 'light'}
                      onChange={(_, light) => {
                        const m = light ? 'light' : 'dark';
                        setMode(m);
                        localStorage.setItem('zuno-theme', m);
                      }}
                    />
                  }
                />
              </CardContent>
            </Card>
          </Stack>
        )}
        {!['/', '/sources', '/videos', '/history', '/settings'].includes(page) && !roomId && (
          <Alert severity="info">
            Страница не найдена. <Button onClick={() => go('/')}>На главную</Button>
          </Alert>
        )}
        <footer>
          <span className="accent">zuno</span> · Одно видео. До пяти человек. Ваше пространство.
        </footer>
      </Container>
    </ThemeProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
