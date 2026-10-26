# Проверки Zuno MVP

Проверено в облачной среде разработки 26 октября 2026 года, Node.js 24.19.0, Linux x64, Chromium. Это не проверка вашего VPS и не публикация в GitHub.

| Проверка | Результат |
|---|---|
| `npm run lint` | Успешно |
| `npm run typecheck` / `npm run build` | Успешно, React/Vite и TypeScript backend собраны |
| `npm test` | 6 tests passed: источники/позиция, членство/5 мест/права/revision/отзыв, рестарт, Origin/подпись сессии, MIME/Range/backup, обходы путей статических файлов |
| `npm run test:e2e` | 1 сквозной сценарий passed: 5 независимых браузерных сессий, реальное H.264/AAC MP4, отказ шестому, play/pause/seek, drift <1.5 c при паузе, чат/XSS, reload, offline/reconnect, история, мобильная ширина 390px |
| SQLite backup | Восстановленная online-копия открыта, `integrity_check=ok`, сообщения сохранены |
| Caddyfile | Успешно провалидирован Caddy 2.6.2 (Ubuntu) и 2.10.2; бинарные архивы проверены по официальным контрольным суммам |
| Node installer | Проверено наличие официальных SHA-256 для 24.19.0 x64/arm64; установка в `/usr/local` на VPS не выполнялась |
| systemd units | Синтаксис проверен `systemd-analyze verify` с заменой пути Node на путь текущей среды; runtime systemd на VPS ещё не проверен |
| Повторная облачная установка | `npm ci` с кэшем `/tmp/zuno-npm-cache`, затем build — успешно; `.env` сохранён |
| Production-only архив | Распакован отдельно, `npm ci --omit=dev`, health/SPA/cookie/создание комнаты и CLI backup/restore — успешно |
| Shell scripts | `bash -n` без ошибок |
| `npm audit` и `npm audit --omit=dev` | 0 известных уязвимостей на момент проверки |

Скриншоты browser E2E: `artifacts/room-desktop.png`, `artifacts/room-mobile.png` (тестовое одноцветное видео, настоящий HTML5 playback).

Vite предупреждает о JS bundle около 531 КБ (165 КБ gzip): это не ошибка сборки; lazy loading можно добавить позже.

Оставшиеся проверки на реальном сервере: HTTPS/DNS/сертификат, systemd после reboot, внешний доступ с ПК/Android, YouTube с разрешённым роликом, RAM/CPU/network на 1 vCPU / 1 ГБ и внешнее хранилище backup. RUTUBE/VK/HLS и официальные логотипы не считаются реализованными. Возможности и ограничения описаны в README.

При smoke-запуске одного Node-процесса наблюдалось около 65 МБ RSS без видеонагрузки. Это измерение в облачной среде, не полный бюджет VPS и не нагрузочный тест пяти зрителей.
