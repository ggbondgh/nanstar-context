# Cloudflare Pages 部署

## 1. 创建 D1

在本机登录 Cloudflare CLI：

```powershell
npx wrangler login
npx wrangler d1 create nanstar-context
```

命令会返回数据库 ID。把 `wrangler.jsonc` 中的占位值：

```json
"database_id": "00000000-0000-0000-0000-000000000000"
```

替换为真实 ID 后提交并推送到 `main`。

应用远程迁移：

```powershell
npm run migrate:remote
```

## 2. 创建 Pages 项目

在 Cloudflare Dashboard 中进入 `Workers & Pages`，创建 Pages 项目并连接：

- GitHub 仓库：`ggbondgh/nanstar-context`
- 生产分支：`main`
- Framework preset：`None`
- Build command：`npm run build`
- Build output directory：`dist`
- Root directory：留空

如果 Pages 项目没有自动读取 `wrangler.jsonc` 的绑定，在项目设置的 `Bindings` 中手动添加：

```text
Type: D1 database
Variable name: CONTEXT_DB
Database: nanstar-context
```

生产和 Preview 环境都应绑定到明确选择的数据库。首版单用户环境可以共用一个 D1；需要隔离测试数据时再创建单独 Preview D1。

## 3. 配置系统密钥

在 Pages 项目的 `Settings > Variables and Secrets` 中新增两个 Secret：

```text
CONTEXT_AUTH_TOKEN
AI_CONFIG_ENCRYPTION_KEY
```

- `CONTEXT_AUTH_TOKEN`：用于登录平台，建议使用密码管理器生成的长随机字符串。
- `AI_CONFIG_ENCRYPTION_KEY`：用于加密网页中保存的第三方 API Key，建议至少 32 个随机字节。

两个值都不要写入 GitHub、普通环境变量示例或部署日志。生产和 Preview 环境分别配置。

## 4. 可选 Workers AI

只有需要使用 Cloudflare Workers AI 时才添加 `AI` binding。未绑定时，DeepSeek、火山方舟、其他 OpenAI 兼容服务和本地规则仍可正常使用。

## 5. 首次登录和模型配置

部署完成后：

1. 使用 `CONTEXT_AUTH_TOKEN` 登录。
2. 在“设置 > AI 服务商”添加 DeepSeek、火山方舟或兼容服务。
3. 添加模型 ID。
4. 在“模型路由”中为 `organize_capture` 选择默认模型。
5. 在“系统健康”中检查 D1、系统密钥和可选 AI binding。

第三方 API Key 会由 Pages Functions 使用 AES-GCM 加密，D1 只保存密文、随机 IV 和尾号。

## 6. 后续发布

推送到 `main` 后 Cloudflare Pages 自动部署：

```powershell
git push origin main
```

如果新增了迁移文件，先确认代码已推送，再执行：

```powershell
npm run migrate:remote
```

迁移前可用以下命令导出 D1 备份：

```powershell
npx wrangler d1 export nanstar-context --remote --output exports\nanstar-context.sql
```

`exports/` 已被 Git 忽略。
