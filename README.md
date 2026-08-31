# Secure Notepad

仿 [protectedtext.com](https://www.protectedtext.com/) 的客户端加密在线记事本，基于 Cloudflare Workers（静态资源 + D1）。

## 特性

- **无需注册登录**，靠笔记名（URL 路径）访问，例如 `https://your-worker.dev/my-note`
- **客户端加密**：密码永远不会发送到服务器，加密/解密全部在浏览器完成（PBKDF2 + AES-GCM 256）
- **自动保存**：停止输入约 1 秒后自动加密并保存
- **定时自动删除**：新建/编辑时可选择 1 小时 / 1 天 / 7 天 / 30 天后自动删除，由 Cron Trigger 每 15 分钟扫描一次 D1 中已过期的记录并物理删除（读取时也会做一次双保险检查）
- **阅后即焚**：勾选后，笔记内容被读取一次即从服务器删除
- **手动立即删除**：编辑页有"立即删除笔记"按钮
- **管理后台**（`/admin`）：用独立的管理密钥登录后，可以看到所有笔记的名字、创建/更新/过期时间、是否阅后即焚，并支持一键删除——内容始终不可见

## 项目结构

```
secure-notepad/
├── wrangler.toml          # Workers 配置：静态资源目录 + D1 绑定 + 定时任务
├── migrations/
│   └── 0001_init.sql      # D1 建表 SQL
├── public/                 # 纯静态文件，由 Cloudflare 直接托管，不经过 Worker 代码
│   ├── index.html          # 笔记编辑页（首页 / 新建 / 解锁 / 编辑 都在这一个页面里，靠 JS 切换）
│   ├── admin.html          # 管理后台页面
│   └── styles.css          # 两个页面共用的样式表
└── src/
    └── index.js            # Worker 代码，只处理 /api/* 接口和定时清理任务
```

这样拆分之后，以后想加新页面（比如笔记列表、分享设置页），直接在 `public/` 下加一个新的 `.html`，引用同一份 `styles.css` 保持风格统一；想加新接口，直接在 `src/index.js` 里加路由，两边互不干扰。

### 路由是怎么工作的

Cloudflare Workers 的静态资源功能（`[assets]` 配置）会自动做这件事：

- 浏览器**直接访问**一个地址（比如打开 `https://your-worker.dev/my-note`、或者点链接、刷新页面）——这类"导航请求"如果匹配到 `public/` 里的真实文件（比如 `/admin` 对应 `admin.html`），直接返回那个文件；如果没匹配到（比如 `/my-note` 这种笔记名，`public/` 里当然没有这个文件），会兜底返回 `index.html`（这就是 `not_found_handling = "single-page-application"` 的作用），前端 JS 再根据 `location.pathname` 自己判断该显示"新建"还是"解锁"界面。
- 前端 JS 用 `fetch()` 发起的 `/api/note/xxx`、`/api/admin/notes` 这类请求，不是"导航请求"，也匹配不到任何静态文件，会被转发给 `src/index.js` 里的 Worker 代码处理。

所以你不需要在 Worker 代码里手写"哪个路径返回哪个 HTML"，`wrangler.toml` 里的 `[assets]` 配置已经把这部分处理好了。

## 安全说明

- 服务器只保存密文、随机 salt 和 iv，从不接触明文或密码。
- **密码一旦忘记，内容无法恢复**——这是端到端加密的必然代价，和 protectedtext 一样。
- 知道笔记名字的人可以看到"这个名字被占用了"以及可以删除它，但看不到内容。
- 管理后台只暴露元数据，不暴露内容，用 `ADMIN_TOKEN` 密钥保护，不设置这个密钥的话 `/api/admin/notes` 直接返回未授权（`/admin` 页面本身仍能打开，但登录不了）。

## 部署步骤

1. 安装 wrangler（如果还没有）：
   ```bash
   npm install -g wrangler
   ```

2. 登录 Cloudflare：
   ```bash
   wrangler login
   ```

3. 创建 D1 数据库：
   ```bash
   wrangler d1 create secure-notepad-db
   ```
   命令输出里会有一段类似：
   ```
   [[d1_databases]]
   binding = "DB"
   database_name = "secure-notepad-db"
   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   ```
   把这里的 `database_id` 填进 `wrangler.toml` 里的 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。

4. 执行数据库迁移，建表：
   ```bash
   wrangler d1 migrations apply secure-notepad-db --local   # 本地测试
   wrangler d1 migrations apply secure-notepad-db --remote  # 生产环境
   ```

5. 设置管理后台密钥（自己随便定一个复杂字符串）：
   ```bash
   wrangler secret put ADMIN_TOKEN
   ```

6. 部署：
   ```bash
   wrangler deploy
   ```

7. 部署完成后：
   - 访问根地址，输入任意笔记名即可开始使用笔记功能
   - 访问 `/admin`，输入第 5 步设置的密钥即可看到管理后台

## 关于定时删除的实现方式

D1 没有 KV 那种写入时自带的 `expirationTtl`，所以用了 Cloudflare 的 **Cron Trigger**：
`wrangler.toml` 里配置了 `crons = ["*/15 * * * *"]`，即每 15 分钟触发一次 `scheduled()` 函数，
执行 `DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < 当前时间`。
想要更实时可以把频率调高（比如 `*/1 * * * *`），免费额度很宽裕。另外读取笔记时也做了一次
"过期即删除"的兜底判断，即使刚好卡在两次 cron 之间也不会把过期内容返回给用户。

## 日常管理

- **实时日志**：`wrangler tail`
- **直接查数据库**：
  ```bash
  wrangler d1 execute secure-notepad-db --remote --command "SELECT id, updated_at, expires_at FROM notes ORDER BY updated_at DESC LIMIT 20"
  ```
- **备份数据库**（导出的是密文，可以放心存到别处）：
  ```bash
  wrangler d1 export secure-notepad-db --remote --output backup.sql
  ```
- **管理后台**（`/admin`）：日常查看笔记列表、清理不需要的笔记，比命令行方便。
- **监控**：Cloudflare Dashboard → Workers & Pages → 你的项目 → Observability，能看到请求量、错误率、D1 查询次数。

## 可以进一步扩展的方向

- 给笔记加"编辑历史/版本回滚"（每次保存前把旧密文存进一张 `note_history` 表）
- 管理后台加搜索、分页、按过期时间排序筛选
- 用 Cloudflare Turnstile 防止有人枚举/爆破笔记名
- 用自定义域名代替 `*.workers.dev`
- 给管理后台加操作日志表，记录谁在什么时候删了哪条笔记
- 新增页面时，直接在 `public/` 下加文件、引用 `styles.css` 即可，不需要碰 `src/index.js`
