import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('five participants: private MP4, chat, control, seek, reconnect, history', async ({
  browser,
}) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'zuno-mp4-'));
  const file = join(fixtureDir, 'test.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=purple:s=320x180:r=10',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=stereo',
    '-t',
    '30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    file,
  ]);
  const extras = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const hc = await browser.newContext(),
    vc = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    }),
    sc = await browser.newContext();
  const host = await hc.newPage(),
    viewer = await vc.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: 'Настройки', exact: true }).click();
    await host.getByLabel('Ваш ник').fill('Аня');
    await host.getByRole('button', { name: 'Сохранить ник' }).click();
    await host.getByRole('button', { name: 'Свои видео', exact: true }).click();
    await host.locator('input[type=file]').setInputFiles(file);
    await expect(host.getByText('test.mp4', { exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Смотреть вместе' }).click();
    await expect(host.getByText('Ваш общий вечер', { exact: true })).toBeVisible();
    const invite = await host.getByLabel('Приватная ссылка').inputValue();
    await host.getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(host.locator('video')).toBeVisible();
    await viewer.goto(invite);
    await expect(viewer.locator('video')).toBeVisible();
    const third = await sc.newPage();
    await third.goto(invite);
    await expect(third.locator('video')).toBeVisible();
    const fourth = await extras[0].newPage(),
      fifth = await extras[1].newPage(),
      sixth = await extras[2].newPage();
    for (const p of [fourth, fifth]) {
      await p.goto(invite);
      await expect(p.locator('video')).toBeVisible();
      await p.getByRole('button', { name: 'Разрешить воспроизведение' }).click();
    }
    await sixth.goto(invite);
    await expect(sixth.getByText('В комнате уже пять участников')).toBeVisible();
    await third.getByRole('button', { name: 'Разрешить воспроизведение' }).click();
    await viewer.getByRole('button', { name: 'Разрешить воспроизведение' }).click();
    await host.getByRole('button', { name: 'Разрешить воспроизведение' }).click();
    await host.getByRole('button', { name: 'Смотреть', exact: true }).click();
    await expect
      .poll(() => host.locator('video').evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(false);
    await expect
      .poll(() => viewer.locator('video').evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(false);
    for (const p of [third, fourth, fifth])
      await expect
        .poll(() => p.locator('video').evaluate((v: HTMLVideoElement) => v.paused))
        .toBe(false);
    await host.getByRole('button', { name: '+10 с', exact: true }).click();
    await expect
      .poll(() => viewer.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(9);
    await host.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect
      .poll(() => viewer.locator('video').evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(true);
    const hp = await host.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      vp = await viewer.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(Math.abs(hp - vp)).toBeLessThan(1.5);
    await expect(viewer.getByRole('button', { name: 'Смотреть', exact: true })).toBeDisabled();
    await viewer.getByLabel('Сообщение', { exact: true }).fill('<b>Привет!</b>');
    await viewer.getByRole('button', { name: 'Отправить ↑' }).click();
    await expect(host.getByText('<b>Привет!</b>', { exact: true })).toBeVisible();
    expect(await host.locator('.message b').count()).toBe(0);
    await viewer.reload();
    await expect(viewer.getByText('<b>Привет!</b>', { exact: true })).toBeVisible();
    await expect
      .poll(() => viewer.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(9);
    await vc.setOffline(true);
    await expect(viewer.getByText('Переподключение…', { exact: true })).toBeVisible();
    await vc.setOffline(false);
    await expect(viewer.getByText('В комнате', { exact: true })).toBeVisible({ timeout: 20000 });
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await host.screenshot({ path: 'artifacts/room-desktop.png', fullPage: true });
    await viewer.screenshot({ path: 'artifacts/room-mobile.png', fullPage: true });
    await host.getByRole('button', { name: 'История', exact: true }).click();
    await expect(host.getByText('Вернуться в комнату →')).toBeVisible();
  } finally {
    await hc.close();
    await vc.close();
    await sc.close();
    await Promise.all(extras.map((c) => c.close()));
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
