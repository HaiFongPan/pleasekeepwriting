# New Blog

Keep keep

- [theme](https://github.com/radishzzz/astro-theme-retypeset/tree/master)

## 同步微信读书

凭据只通过项目外的 shell 环境或密钥管理工具注入，不要写入仓库内的 `.env`、配置、命令参数或日志。

```bash
export WEREAD_API_KEY='<微信读书 API Key>'
pnpm sync-weread
```

兼容已有的 `WEREAD_TOKEN` 环境变量。命令会更新 `src/data/weread-books.json`，封面继续使用微信读书 CDN 地址，不会下载到仓库。
