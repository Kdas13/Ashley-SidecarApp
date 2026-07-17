import * as SQLite from 'expo-sqlite';

import type { ChatMessage } from '@/types/api';

const db = SQLite.openDatabaseSync('atlas-one-mobile.db');
db.execSync(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    image_url TEXT,
    image_uri TEXT,
    file_name TEXT,
    mime_type TEXT
  );
`);
for (const statement of [
  'ALTER TABLE messages ADD COLUMN image_url TEXT',
  'ALTER TABLE messages ADD COLUMN image_uri TEXT',
  'ALTER TABLE messages ADD COLUMN file_name TEXT',
  'ALTER TABLE messages ADD COLUMN mime_type TEXT',
]) {
  try {
    db.execSync(statement);
  } catch {
    // Column already exists.
  }
}

export const chatStore = {
  list(): ChatMessage[] {
    return db.getAllSync<{
      id: string;
      role: ChatMessage['role'];
      content: string;
      created_at: string;
      image_url?: string | null;
      image_uri?: string | null;
      file_name?: string | null;
      mime_type?: string | null;
    }>('SELECT id, role, content, created_at, image_url, image_uri, file_name, mime_type FROM messages ORDER BY created_at ASC LIMIT 500')
      .map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        imageUrl: row.image_url,
        imageUri: row.image_uri,
        fileName: row.file_name,
        mimeType: row.mime_type,
      }));
  },
  add(message: ChatMessage): void {
    db.runSync(
      'INSERT OR REPLACE INTO messages (id, role, content, created_at, image_url, image_uri, file_name, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      message.id,
      message.role,
      message.content,
      message.createdAt,
      message.imageUrl || null,
      message.imageUri || null,
      message.fileName || null,
      message.mimeType || null,
    );
  },
  clear(): void {
    db.runSync('DELETE FROM messages');
  },
};
