-- 初始化 notes 表
-- 注意：这里只存加密后的密文、salt、iv，服务器不接触明文

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  burn_after_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER  -- NULL 表示永久保存，否则是毫秒时间戳
);

CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes(expires_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
