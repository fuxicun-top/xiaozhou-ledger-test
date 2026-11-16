-- 迁移：Web 账号体系（手机号 + 密码，JWT 登录）
-- 数据作用域 user:<phone>；旧 PIN 账号（accounts 表，phone: 作用域）在注册新账号时自动并入。
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
