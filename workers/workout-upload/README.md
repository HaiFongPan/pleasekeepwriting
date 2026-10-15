# 手机上传运动 FIT

独立 Cloudflare Worker，直接通过 R2 binding 写入私有 `workout-archive`。手机不需要连接 Tailscale，也不持有 R2 S3 密钥。当前只归档文件，不触发站点发布或正式 Actions 增量处理。

## iPhone 快捷指令

接口：`https://workout-upload.leopan-me.workers.dev/v1/workouts`

上传令牌保存在本机 `~/.config/workout-upload.secrets.json` 的 `UPLOAD_TOKEN` 字段，文件权限应为 600。复制字段的值，不要复制 JSON 的引号或键名；它与 `workout-r2.env` 中的 S3 凭据不同。不要公开分享含令牌的快捷指令。

1. 新建快捷指令，命名为「保存运动 FIT」，在详情中开启「在共享表单中显示」，允许接收文件。首轮每次只分享一个 `.fit`。
2. 添加「URL」，填入上面的完整接口地址。
3. 添加「获取 URL 内容」，展开配置：方法 `POST`；添加请求头 `Authorization`，值为 `Bearer 上传令牌`（Bearer 后有一个空格）；添加请求头 `Content-Type`，值为 `application/octet-stream`；请求正文选择「文件」，变量选择「快捷指令输入」。不要选择表单或 JSON，也不要把文件名作为正文。
4. 添加「显示结果」，显示「获取 URL 内容」的输出。收到 `status: stored` 表示已写入 R2；`status: exists` 表示相同运动内容已归档。错误或网络超时不能当成保存成功，保留文件后重试即可。
5. 在 WorkOutDoors 中打开一条运动，导出 **FIT**，通过分享表单选择「保存运动 FIT」。若分享表单中找不到快捷指令，可先保存到 iOS「文件」，再从文件的分享表单运行。

首次成功响应示意（hash 为示意值）：

```json
{
  "status": "stored",
  "message": "已保存到私有运动档案",
  "sha256": "<此次上传原件的摘要>",
  "activityId": "<运动内容标识>",
  "archiveSha256": "<实际保留原件的摘要>",
  "dedupMode": "workoutdoors-content",
  "bytes": 12345,
  "archiveBytes": 12345
}
```

手机上传已实测成功。WorkOutDoors 重新导出同一活动会改变文件元信息，因此来件 `sha256` 可以变化；新版比较运动内容，已验证两份真实导出均返回 `exists`，且 `activityId` 和 `archiveSha256` 相同。快捷指令无需修改。

网络注意：本机经当前代理访问该 `workers.dev` 地址成功；Ubuntu 直连曾超时。手机如果同样无法连接，需要使用可访问该域名的网络或后续配置 Worker 自定义域名。这个限制不同于 R2 S3 endpoint 连通性，也与上传令牌无关。

## 接口约束

- 仅 `POST /v1/workouts`；不提供下载、列举、删除或自选对象路径。
- 仅接受原始 FIT 字节，最大 10 MiB，请求体接收总时限 30 秒。拒绝 multipart 和压缩编码。
- 使用 Garmin SDK 检查 FIT 文件头、长度与 CRC，并解析消息生成运动内容标识。当前不生成页面指标，业务指标口径仍留给后续导入流程。
- 新文件按 `activities/v1/<activityId>.fit` 存储，条件写入保证同一运动内容只归档最先成功写入的一份原件。
- 对象元信息固定 `publication=private`；后续消费者必须遵守这一状态，不能自动把全部原件发布到站点。
- 手机凭据为 256 位随机上传令牌，存于 Cloudflare secret binding。Worker 通过 R2 binding 工作，不使用 S3 密钥。
- 来源 IP 限流配置为每分钟 30 次；通过鉴权的上传限流为每分钟 10 次。Cloudflare Rate Limiting 按数据中心执行且存在传播延迟，属于尽力限流，不是严格全局次数/存储预算。实测经过一个短请求突发后才观察到 429。
- 没有独立的全局每日存储配额。上传令牌泄漏后应立即轮换；私有归档仍需要监控用量，R2 写入 binding 不构成不可删除备份。
- 不记录请求头、文件内容和底层异常；关闭 Worker observability 与版本预览 URL。

| HTTP | 含义 |
| --- | --- |
| 201 | 新文件已存 R2 |
| 200 | 相同运动内容已归档；保守回退模式表示相同文件已存在 |
| 401 | 上传令牌缺失或错误 |
| 404 / 405 | 路径或方法不允许 |
| 408 | 请求体超时 |
| 413 | 超过 10 MiB |
| 415 | 请求体被压缩或包装成表单 |
| 422 | FIT 内容或 CRC 不合法 |
| 429 | 限流，稍后重试 |
| 503 | 配置或存储暂时不可用；不表示已保存 |

## 运动内容去重与历史数据

`identity.mjs` 使用固定版本 Garmin SDK 21.218.0；规则版本为 v1。先验证文件完整性，再按原始消息顺序生成摘要。对象字段排序，消息和数组顺序保留；日期保持数值，不做 Date/时区转换。

只有明确带 `manufacturer=development`、`productName=WorkOutDoors`、活动类型及有效 session 开始时间的文件参与运动内容去重。只忽略以下导出元信息：

- WorkOutDoors `fileId` 中的 `timeCreated`、`serialNumber`。
- WorkOutDoors 创建者设备（`deviceIndex=creator`）的 `timestamp`、`serialNumber`。

外部传感器的时间和序列号不忽略。采样、圈段、事件、session、activity、普通未知字段和开发者标识都参与摘要；这些内容变化会创建新内容版本，不通过开始时间相似就合并。

为避免误合并，未知导出器、缺少活动汇总、含开发者数据字段定义的文件采用完整原件哈希去重，响应 `dedupMode=file`。解码超过 20,000 条消息或规范化文本超过 4 Mi 字符也保守回退，限制解码树膨胀；这类重新导出的长文件可能仍返回 stored。识别出的 WorkOutDoors 解码错误会拒绝，不使用残缺解码结果去重。

响应中 `sha256` / `bytes` 始终属于本次来件；`archiveSha256` / `archiveBytes` 属于实际保留的原件。重复导出只复用归档，不再另存本次变化的字节。并发失败者通过 HeadObject 读取赢家元信息，缺失时返回可重试错误，不能谎报 exists。

此前 `raw/sha256/` 中的两份真实导出已经归并到一个 `activities/v1/` 规范归档，保留了较早上传的原始字节，重新下载校验通过。两份旧 raw 原件保留为历史备份，不删除。后续消费者只枚举 `activities/v1/`，不要同时枚举 raw，否则会重复计数。

调整 SDK 或规范化规则必须升级身份规则版本，并制定迁移；不能悄悄改变 v1。回滚到旧 Worker 会恢复 raw 写入，需要再次回填这些新原件。

## 开发与部署

独立依赖和锁文件，不改变 Astro 应用依赖。在本目录执行：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm exec cf deploy --prebuilt \
  --secrets-file "$HOME/.config/workout-upload.secrets.json" \
  --message '更新运动文件上传入口'
```

构建和部署使用已登录的 cf CLI。构建生成物、环境文件与本地凭据不得提交。修改令牌后重新部署，并同步更新手机快捷指令。切勿将 `workout-r2.env` 当作 Worker secrets-file 上传，因为 Worker 不需要其中的 S3 凭据。

## 已执行验证（2026-10-15）

- 17 项本地行为测试通过，包括不同导出元信息的去重、真实运动内容差异不合并、解码预算回退、并发、鉴权、大小、坏文件、方法、限流与存储失败。
- 定向 ESLint 检查及 `cf build` 通过。
- 实际部署后：无令牌/错误令牌 401；合成 FIT 首次上传 201、重复上传 200；独立 S3 只读下载 SHA-256 一致，元信息为 private。
- 非 FIT 422、超限请求 413、GET/DELETE 405、原始对象路径 404。
- 实测限流观察到 429，但不能据此声称精确限制为第 11 次拒绝。
- 新版对两份真实原件重传均返回 200/exists，运动标识及归档摘要一致。
- 公网并发上传两份不同字节、相同运动内容的合成 FIT，得到一条 201 和一条 200；超解码预算的合成文件成功按 file 模式归档。
- 新版合成测试对象均已清理，规范归档目录仅保留一条真实运动。比较/迁移用的本地 FIT 临时副本在验收后清理。

参考：[R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[Worker 限流](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[Garmin FIT SDK](https://github.com/garmin/fit-javascript-sdk)。
