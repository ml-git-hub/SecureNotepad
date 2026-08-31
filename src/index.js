/**
 * Secure Notepad - 类 protectedtext.com 的客户端加密在线记事本
 * 存储层：Cloudflare D1（SQLite）
 * 页面：public/ 目录下的静态文件（index.html / admin.html / styles.css），
 *       由 Cloudflare Workers 的 [assets] 功能直接托管，本文件只负责 API。
 *
 * 路由行为（由 wrangler.toml 里的 assets 配置决定，无需在这里手写）：
 *   - 浏览器直接访问 /、/my-note、/admin 这类"导航"请求 -> 命中 public/ 里的
 *     真实文件，或者落到 not_found_handling = single-page-application 的兜底，
 *     统一返回 index.html，由前端 JS 根据 location.pathname 自己判断显示什么。
 *   - 前端 JS 用 fetch() 发起的 /api/* 请求（非导航请求）-> 落不到任何静态文件，
 *     会被转发到这个 Worker 脚本处理。
 *
 * 安全模型说明（和 protectedtext 一致）:
 *   - 服务器永远不会看到明文，也不会看到密码本身。
 *   - 密码只用来在浏览器里通过 PBKDF2 派生出 AES-GCM 密钥，加密后的密文才会上传。
 *   - 任何知道笔记名字（URL）的人都能看到"存在这个笔记"以及删除它，
 *     但看不到内容——内容的保密性来自密码，而不是访问控制。
 *   - 管理后台（/admin）只暴露元数据，用 ADMIN_TOKEN 密钥保护。
 */

const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const TTL_OPTIONS = {
  "0": 0,
  "3600": 3600, // 1 小时
  "86400": 86400, // 1 天
  "604800": 604800, // 7 天
  "2592000": 2592000, // 30 天
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function checkAdminAuth(request, env) {
  if (!env.ADMIN_TOKEN) return false; // 没配置就整体禁用管理后台
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return token && token === env.ADMIN_TOKEN;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/admin/notes") {
      if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        "SELECT id, burn_after_read, created_at, updated_at, expires_at FROM notes ORDER BY updated_at DESC LIMIT 500"
      ).all();
      return json({ notes: results });
    }

    if (pathname.startsWith("/api/note/")) {
      const id = decodeURIComponent(pathname.slice("/api/note/".length));
      if (!NOTE_ID_RE.test(id)) {
        return json({ error: "笔记名不合法（仅支持字母、数字、- 和 _，长度1-64）" }, 400);
      }

      if (request.method === "GET") return handleGet(id, env, ctx);
      if (request.method === "PUT") return handlePut(id, request, env);
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM notes WHERE id = ?1").bind(id).run();
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // 理论上不会走到这里（静态资源应该已经处理了非 /api/* 的请求），
    // 但保留一个兜底，直接把请求转给静态资源层。
    return env.ASSETS.fetch(request);
  },

  // 定时任务：清理已过期的笔记（D1 没有 KV 那种原生 TTL）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?1")
        .bind(Date.now())
        .run()
    );
  },
};

async function handleGet(id, env, ctx) {
  const row = await env.DB.prepare("SELECT * FROM notes WHERE id = ?1").bind(id).first();
  if (!row) return json({ exists: false });

  // 双保险：万一定时清理还没扫到这条已过期的数据，读取时也当作不存在
  if (row.expires_at && row.expires_at < Date.now()) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM notes WHERE id = ?1").bind(id).run());
    return json({ exists: false });
  }

  const resp = json({
    exists: true,
    salt: row.salt,
    iv: row.iv,
    ciphertext: row.ciphertext,
    burnAfterRead: !!row.burn_after_read,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || null,
  });

  if (row.burn_after_read) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM notes WHERE id = ?1").bind(id).run());
  }

  return resp;
}

async function handlePut(id, request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }

  const { salt, iv, ciphertext, burnAfterRead, ttl } = body || {};

  if (typeof salt !== "string" || typeof iv !== "string" || typeof ciphertext !== "string") {
    return json({ error: "缺少 salt / iv / ciphertext" }, 400);
  }
  if (ciphertext.length > 2_000_000) {
    return json({ error: "笔记内容过大" }, 413);
  }

  const ttlSeconds = TTL_OPTIONS.hasOwnProperty(String(ttl)) ? TTL_OPTIONS[String(ttl)] : 0;
  const now = Date.now();
  const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;

  await env.DB.prepare(
    `INSERT INTO notes (id, salt, iv, ciphertext, burn_after_read, created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET
       salt = excluded.salt,
       iv = excluded.iv,
       ciphertext = excluded.ciphertext,
       burn_after_read = excluded.burn_after_read,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`
  )
    .bind(id, salt, iv, ciphertext, burnAfterRead ? 1 : 0, now, expiresAt)
    .run();

  return json({ ok: true, updatedAt: now, expiresAt });
}
