import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir = resolve(process.env.DATA_DIR || '.data');
const dest = resolve(
  process.argv[2] ||
    join(dir, 'backups', `zuno-${new Date().toISOString().replaceAll(':', '-')}.sqlite`),
);
mkdirSync(resolve(dest, '..'), { recursive: true, mode: 0o700 });
const source = new DatabaseSync(join(dir, 'zuno.sqlite'), { readOnly: true });
try {
  await backup(source, dest);
  chmodSync(dest, 0o600);
  const check = new DatabaseSync(dest, { readOnly: true });
  try {
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw Error('Backup integrity check failed');
  } finally {
    check.close();
  }
  console.log(`SQLite backup verified: ${dest}`);
} finally {
  source.close();
}
