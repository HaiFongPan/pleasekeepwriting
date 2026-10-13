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

同步结果包含书籍简介、出版信息和微信读书评分，供 `/books/{bookId}/` 详情页使用。文章需要关联书籍时，在 frontmatter 中填写对应的微信读书 `bookId`：

```yaml
bookId: CB_3frFf5Ffj4Mq76875N1Im0O9
```

## 同步 Strava 运动数据

页面：`/sport/`

- 顶部：年份筛选（全部 + 各年）、GitHub 风格活力图（指标为移动时长）、跑步/徒步/骑行总距离
- 列表：按时间倒序平铺卡片，主体是运动轨迹；没有轨迹的活动（HIIT、举重、椭圆机）只显示类型名；
  卡片底部是距离、时长、卡路里
- 详情：鼠标悬停时轨迹统一按速度上色（红=快、绿=慢）。上坡必然慢，所以不再单独用爬升率；
  指标口径集中在 `src/utils/sport.ts` 的 `resolveMetricKind`，要按类型区分改这一处
- 年份筛选与活力图、列表、统计联动；选中具体年份时活力图按天画，选"全部"时每年一行、按周聚合。
  活力图格子随容器宽度铺满（与下方卡片列表同宽），容器过窄时整体横向滚动
- 轨迹数据在卡片进入视口时才按需拉取，不参与首屏

改过名称的活动显示为「类型·名称」（例如 `远足·西湖毅行`）。判断依据是 Strava 的默认命名规则
`[{星期} ][{时段} ]{项目}`（`Sunday Evening Cycle`、`Friday Morning Indoor Run`、`傍晚骑行` 等），
规则在 `src/utils/sport.ts` 的 `isDefaultActivityName`，无法识别的一律按改名处理。

### 为什么不用官方 API

本账号的 Strava API 应用处于 Inactive，所有业务接口返回
`403 {"resource":"Application","field":"Status","code":"Inactive"}`：Strava 2025 年调整开发者计划后，
持有该应用的账号需要有 Strava 订阅。OAuth 换 token 仍会成功，但读不到活动。

于是改用浏览器登录态访问站点自己的接口（`scripts/lib/strava-web.ts`）：

| 数据 | 接口 | 备注 |
| --- | --- | --- |
| 元数据 | `GET /athlete/training_activities?page=N` | 固定 20 条/页，倒序，`total` 给总数 |
| 轨迹 | `GET /api/v3/activities/{id}/streams?keys=latlng` | 约 120KB/条，`latlng` 点数组 |
| 卡路里 | `GET /activities/{id}/export_original` | 原始 FIT，取 session 或 lap 的 `total_calories` |

已实测排除的路子：带 cookie 请求 `/api/v3/athlete/activities` 与 `/api/v3/activities/{id}` 是 401；
`export_tcx` 的 `<Calories>` 全是 0；活动页 HTML 里没有 JWT，也没有 calories。

这些不是官方接口，随时可能变（变更只需改 `scripts/lib/strava-web.ts`），且属于服务条款灰色地带；
请求默认间隔 400ms（`STRAVA_WEB_DELAY_MS`），请不要提高频率。

### 凭据

本地写在 `.env`（已 gitignore），CI 用 repository secret：

```bash
export STRAVA_COOKIE_STRAVA4_SESSION='<浏览器 cookie>'
```

获取方式：登录 strava.com → DevTools → Application → Cookies → `https://www.strava.com` → 复制
`_strava4_session`。cookie 权限等同于账号登录态，不要提交、不要贴进 issue；过期后同步会以
明确错误退出，提示重新获取。

### 命令

```bash
pnpm sync-strava                   # 增量：只扫最新 3 页训练日志
pnpm sync-strava --full            # 全量：扫完所有页，并清理已删除的活动
pnpm sync-strava --rebuild-tracks  # 强制重建全部轨迹
pnpm sync-strava --limit 50        # 限制本次处理条数（可重入，分批跑）
pnpm strava-web-probe              # 只读探测各接口可用性与字段
pnpm strava-web-validate           # 只读验证：拉样本并把轨迹样本图写到系统临时目录
```

### 产物与隐私

- `src/data/strava/activities.json`：指标索引，只有 id、类型、名称、日期、距离、时长、卡路里、爬升
- `public/strava/tracks/{id}.json`：`{v,p,s,e,k,q}`，`p` 是已缩放平移到 100×62 viewBox 的 SVG path，
  `k`/`q` 是每段的等级（0..f）用于悬停上色
- 两者都**不含经纬度、城市、海拔**：轨迹的裁剪与投影都在构建期完成，落盘的是归一化几何，
  无法据此反查位置
- 起终点各裁掉 `sport.track.trimStartMeters`（默认 200m）形成隐私缺口；短活动按
  `minRetainRatio`（默认 0.5）自动收小半径，下限 `minTrimMeters`（默认 50m）
- `sport.excludePrivate`（默认 true）跳过标记为 Only Me 的活动
- `sport.showMap` / `sport.showLocationNames` 为地图底图与城市文案预留，默认关闭；
  开启 `showMap` 会在轨迹文件里额外写入约 1km 精度的地图中心
- 注意：改过名称的活动会把名称显示出来，名称里可能含地点（例如"西湖毅行"）；默认名不会显示

### 定时同步

`.github/workflows/sync-strava.yml` 每天 21:40 UTC 同步并提交数据（写回仓库需要
Settings → Actions → General → Workflow permissions 允许 Read and write）。
从 GitHub 的出口 IP 携带会话 cookie 访问存在被 Strava 视为异常登录的风险，若介意可改为
本地定时执行、Action 只负责构建。

### 已知缺口

2022-2024 的部分历史活动原始文件里没有卡路里（上传的是 GPX，或设备没写 `total_calories`），
卡片显示 `—`。补齐方式：到 Strava 请求一次账号数据导出，用 `activities.csv` 的 `Calories`
列回填（注意该 CSV 有重名表头，`Distance` 出现两次，解析要按位置）。
