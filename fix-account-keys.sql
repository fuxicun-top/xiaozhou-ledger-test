-- 修复脚本：account_keys.phone 历史截断数据（配合 Worker 代码 P0 修复使用）
--
-- 背景：旧版 accountPhone() 对 user: 账号做 slice(6)，把手机号首位切掉，
--       /api/apikey/rotate、/api/apikey/port、/api/import/backup 写入的
--       account_keys.phone 存了截断值（如 13800138000 → 3800138000），
--       导致 X-Api-Key 认证映射到错误账号（user:3800138000），小程序端读不到数据。
--       （/api/account/register 的密钥并入路径写的是完整手机号，不受影响。）
--
-- 用法（远程库）：
--   1. 先执行下面的【检查】SELECT，人工核对受影响行数与补全结果是否合理；
--   2. 再执行【修复】UPDATE；
--   3. 重新用 X-Api-Key 调 /api/session 验证 uid 已是完整 user:<手机号>。
--
-- 幂等：已正确的行不会被修改；无法唯一定位补全值的行保持原样（需人工处理）。

-- ---------- 检查：列出会被修复的行 ----------
SELECT account_keys.key,
       account_keys.phone AS stored_phone,
       (SELECT u.phone FROM users u
         WHERE substr(u.phone, 2) = account_keys.phone
           AND length(u.phone) = length(account_keys.phone) + 1) AS corrected_phone
FROM account_keys
WHERE account_keys.phone NOT IN (SELECT phone FROM users)
  AND (SELECT COUNT(*) FROM users u2
        WHERE substr(u2.phone, 2) = account_keys.phone
          AND length(u2.phone) = length(account_keys.phone) + 1) = 1;

-- ---------- 修复：把截断手机号补全为 users 表中的完整手机号 ----------
UPDATE account_keys
SET phone = (SELECT u.phone FROM users u
              WHERE substr(u.phone, 2) = account_keys.phone
                AND length(u.phone) = length(account_keys.phone) + 1)
WHERE phone NOT IN (SELECT phone FROM users)
  AND (SELECT COUNT(*) FROM users u2
        WHERE substr(u2.phone, 2) = account_keys.phone
          AND length(u2.phone) = length(account_keys.phone) + 1) = 1;

-- ---------- 检查：修复后仍无法匹配的残留行（如有，需人工核对手机号后手工 UPDATE） ----------
SELECT key, phone, created_at FROM account_keys
WHERE phone NOT IN (SELECT phone FROM users);
