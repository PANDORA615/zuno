import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function openDatabase(dir: string) {
  mkdirSync(join(dir, 'videos'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'zuno.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, nickname TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES users(id), invite_hash TEXT UNIQUE NOT NULL, both_control INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, touched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS members(room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), PRIMARY KEY(room_id,user_id));
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), nickname TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), name TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS history(user_id TEXT REFERENCES users(id), room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, source_id TEXT NOT NULL, source_type TEXT NOT NULL, position REAL NOT NULL, duration REAL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,room_id,source_id));
    CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id,id);
    INSERT OR IGNORE INTO migrations VALUES(1);`);
  return db;
}
