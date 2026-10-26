import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
export type Playback = {
  sourceType: 'none' | 'mp4' | 'file' | 'youtube';
  sourceId: string;
  positionSeconds: number;
  isPlaying: boolean;
  updatedAt: number;
  revision: number;
  actorId: string;
};
export function Player({
  state,
  clockOffset,
  canControl,
  onCommand,
  onDuration,
  connected,
}: {
  state: Playback;
  clockOffset: number;
  canControl: boolean;
  onCommand: (action: string, positionSeconds: number) => void;
  onDuration: (d: number) => void;
  connected: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null),
    yt = useRef<any>(null),
    mount = useRef<HTMLDivElement>(null);
  const current = useRef({ state, clockOffset, canControl, onCommand, onDuration, connected });
  current.current = { state, clockOffset, canControl, onCommand, onDuration, connected };
  const suppressUntil = useRef(0),
    [notice, setNotice] = useState('Нажмите «Разрешить воспроизведение» на каждом устройстве.'),
    [status, setStatus] = useState('Ожидание');
  const target = () => {
    const { state: s, clockOffset: o } = current.current;
    return s.positionSeconds + (s.isPlaying ? Math.max(0, Date.now() + o - s.updatedAt) / 1000 : 0);
  };
  const apply = () => {
    const { state: s } = current.current;
    const p = yt.current,
      v = video.current;
    const suppress = () => {
      suppressUntil.current = Date.now() + 700;
    };
    if (s.sourceType === 'youtube' && p?.getPlayerState) {
      const d = p.getDuration() || Infinity;
      const next = Math.min(target(), d);
      if (Math.abs((p.getCurrentTime() || 0) - next) > 1.3) {
        suppress();
        p.seekTo(next, true);
      }
      if (s.isPlaying && p.getPlayerState() !== 1 && p.getPlayerState() !== 3) {
        suppress();
        p.playVideo();
      } else if (!s.isPlaying && ![0, 2, 5, -1].includes(p.getPlayerState())) {
        suppress();
        p.pauseVideo();
      }
    } else if (v && v.readyState >= 1) {
      const next = Math.min(target(), Number.isFinite(v.duration) ? v.duration : Infinity);
      if (Math.abs(v.currentTime - next) > 1.3) {
        suppress();
        v.currentTime = next;
      }
      if (s.isPlaying && v.paused && !v.ended) {
        suppress();
        void v.play().catch(() => setNotice('Браузер ждёт нажатия: разрешите воспроизведение.'));
      } else if (!s.isPlaying && !v.paused) {
        suppress();
        v.pause();
      }
    }
  };
  const emit = (action: string) => {
    const c = current.current;
    if (Date.now() < suppressUntil.current) return;
    if (action === 'play' && c.state.isPlaying) return;
    if (action === 'pause' && !c.state.isPlaying) return;
    if (!c.connected || !c.canControl) {
      apply();
      return;
    }
    const pos =
      c.state.sourceType === 'youtube' ? yt.current?.getCurrentTime() : video.current?.currentTime;
    if (action === 'seek' && Math.abs(pos - target()) < 0.3) return;
    if (Number.isFinite(pos)) c.onCommand(action, pos);
  };
  useEffect(() => {
    if (state.sourceType !== 'youtube') return;
    let disposed = false,
      created = false;
    const create = () => {
      if (disposed || created || !mount.current || !(window as any).YT?.Player) return;
      created = true;
      const child = document.createElement('div');
      mount.current.replaceChildren(child);
      yt.current = new (window as any).YT.Player(child, {
        videoId: state.sourceId,
        playerVars: { playsinline: 1, controls: 0, origin: location.origin, enablejsapi: 1 },
        events: {
          onReady: () => {
            setStatus('YouTube готов');
            apply();
          },
          onStateChange: (e: any) => {
            setStatus(
              e.data === 3
                ? 'Буферизация'
                : e.data === 1
                  ? 'Воспроизводится'
                  : e.data === 2
                    ? 'Пауза'
                    : 'Готов',
            );
            if (e.data === 1) {
              setNotice('');
              emit('play');
            }
            if (e.data === 2) emit('pause');
            if (e.data === 0) emit('pause');
          },
          onError: (e: any) =>
            setNotice(
              `YouTube: ошибка ${e.data}. Видео недоступно или автор запретил встраивание.`,
            ),
        },
      });
    };
    if (!(window as any).YT) {
      let script = document.querySelector('script[data-youtube]');
      if (!script) {
        script = document.createElement('script');
        script.setAttribute('data-youtube', '1');
        (script as HTMLScriptElement).src = 'https://www.youtube.com/iframe_api';
        document.head.append(script);
      }
    }
    const timer = setInterval(create, 150);
    create();
    return () => {
      disposed = true;
      clearInterval(timer);
      yt.current?.destroy?.();
      yt.current = null;
    };
    // The player is recreated only when the source changes. All events use current refs.
  }, [state.sourceType, state.sourceId]);
  useEffect(() => {
    apply();
  }, [state.revision, clockOffset]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (current.current.connected) apply();
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      const d =
        current.current.state.sourceType === 'youtube'
          ? yt.current?.getDuration?.()
          : video.current?.duration;
      if (Number.isFinite(d)) current.current.onDuration(d);
    }, 12000);
    return () => clearInterval(t);
  }, []);
  const localEnable = () => {
    suppressUntil.current = Date.now() + 900;
    if (state.sourceType === 'youtube') {
      yt.current?.playVideo?.();
      if (!state.isPlaying) setTimeout(() => yt.current?.pauseVideo?.(), 600);
    } else if (video.current)
      void video.current
        .play()
        .then(() => {
          if (!current.current.state.isPlaying) video.current?.pause();
          setNotice('');
        })
        .catch(() => setNotice('Не удалось воспроизвести видео. Проверьте формат и доступность.'));
  };
  const directCommand = (action: string, delta = 0) => {
    const pos =
      state.sourceType === 'youtube' ? yt.current?.getCurrentTime?.() : video.current?.currentTime;
    onCommand(action, Math.max(0, (Number.isFinite(pos) ? pos : target()) + delta));
  };
  return (
    <Stack spacing={2}>
      <div className="screen">
        {state.sourceType === 'none' ? (
          <div className="empty-player">
            <span>▶</span>
            <h2>Ваш вечер начинается здесь</h2>
            <p>Выберите видео и пригласите близкого человека</p>
          </div>
        ) : state.sourceType === 'youtube' ? (
          <div className="youtube" ref={mount} />
        ) : (
          <video
            key={state.sourceId}
            ref={video}
            src={state.sourceType === 'file' ? `/api/videos/${state.sourceId}` : state.sourceId}
            controls={canControl && connected}
            playsInline
            preload="metadata"
            onLoadedMetadata={() => {
              if (video.current) {
                onDuration(video.current.duration);
                apply();
              }
            }}
            onPlay={() => {
              setNotice('');
              setStatus('Воспроизводится');
              emit('play');
            }}
            onPause={() => {
              setStatus('Пауза');
              emit('pause');
              onDuration(video.current?.duration || 0);
            }}
            onSeeked={() => emit('seek')}
            onWaiting={() => setStatus('Буферизация')}
            onPlaying={() => setStatus('Воспроизводится')}
            onEnded={() => {
              if (
                current.current.canControl &&
                current.current.connected &&
                current.current.state.isPlaying
              )
                current.current.onCommand('pause', video.current?.duration || 0);
            }}
            onError={() =>
              setNotice(
                'MP4 недоступен. Нужен H.264/AAC, HTTPS и поддержка Range; браузер должен иметь доступ к источнику.',
              )
            }
          />
        )}
      </div>
      {state.sourceType !== 'none' && (
        <>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button onClick={localEnable}>Разрешить воспроизведение</Button>
            <Button
              variant="contained"
              disabled={!connected || !canControl}
              onClick={() => directCommand(state.isPlaying ? 'pause' : 'play')}
            >
              {state.isPlaying ? 'Пауза' : 'Смотреть'}
            </Button>
            <Button disabled={!connected || !canControl} onClick={() => directCommand('seek', -10)}>
              −10 с
            </Button>
            <Button disabled={!connected || !canControl} onClick={() => directCommand('seek', 10)}>
              +10 с
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {status} · {connected ? 'связь с комнатой есть' : 'соединение потеряно'} · отклонение
            корректируется каждые 3 с
          </Typography>
          {notice && <Alert severity="info">{notice}</Alert>}
        </>
      )}
    </Stack>
  );
}
