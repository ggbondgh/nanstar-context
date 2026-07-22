# NanStar Context

NanStar Context 是一个单用户个人长期上下文平台。它把口语化输入保存为原始资料，经平台规则、完全手动或外部 AI 生成待审核提案，再由用户确认写入可追溯的长期知识库。

## 已实现

- 单用户 Cookie 登录与登录失败限速
- 分类、文档、知识块、软删除和历史版本
- 收集箱与三种处理模式
- AI 提案、逐项编辑/接受/拒绝和批量审核
- DeepSeek、火山方舟、Workers AI 和 OpenAI 兼容服务商配置
- OpenAI 兼容服务商模型自动发现、同步和默认路由设置
- AES-GCM 加密保存第三方 API Key
- 模型、路由、重试、备用模型和调用记录
- 分类、文档、知识块、标签和状态筛选的上下文生成
- Markdown、JSON 和 ZIP 导出
- JSON 备份预览与恢复
- 桌面和移动端工作台

## 技术结构

```text
Cloudflare Pages
├── dist/                 构建后的静态前端
├── functions/            Pages Functions API
├── D1 / CONTEXT_DB       资料、版本、审核和设置
└── Cloudflare Secrets    登录密钥和 API Key 加密主密钥
```

第一版只需要 D1，不需要 R2。R2 留给未来的附件、音频或大体积备份。

## 本地运行

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run migrate:local
npm run dev
```

打开 `http://localhost:8788`。本地密钥写入 `.dev.vars`，该文件已被 Git 忽略。

## 检查

```powershell
npm run check
npm run build
npx wrangler types --check
```

完整 Cloudflare 配置见 [docs/deploy.md](docs/deploy.md)。

## 数据安全

- 不在仓库中保存个人资料、登录 Token、AI API Key 或 D1 导出。
- AI 只能创建待审核提案，不能直接修改正式资料。
- API Key 的明文和密文均不会出现在普通 API 响应或备份中。
- Markdown 在浏览器显示前经过 DOMPurify 清理。
- 所有业务 SQL 使用 D1 prepared statements 和参数绑定。
