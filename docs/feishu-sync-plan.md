# 报价工作台 · 飞书多维表格同步方案（已确认）

## 背景与范围

- 团队 4 名成员 + 1 名领导；领导不用飞书（用钉钉），**不做领导视图、不做钉钉集成**。
- 业务数据（工厂报价 / 货代报价 / 核算记录 / 产品目录）通过**飞书开放平台服务端 Bitable API** 共享：一个自建应用 + 一个多维表格 App，4 张数据表。
- 5 人规模，远低于 Bitable QPS 限制，无需限流设计。

## 已确认的两项决策

1. **冲突策略：本地优先并提示冲突。** 同步发现同一记录同字段两端都改过时，保留本地值，把远端值记入冲突列表并在 UI 提示，让用户逐条确认覆盖与否。不做静默 LWW。
2. **刷新策略：自动刷新。** 插件启动时全量拉取一次；之后每 2 分钟增量拉取一次；拉取/推送失败只把受影响记录标记为「待同步」，绝不阻塞本地操作。

## Bitable 映射（一个 App，4 张表）

| 工作台记录 | Bitable 表名 | 主键列 |
| --- | --- | --- |
| `factories` 工厂报价 | `工厂报价` | CAS 号 + 报价日期 |
| `freights` 货代报价 | `货代报价` | 货代 + 起运地 + 目的地 + 运输方式 |
| `history` 核算记录 | `核算记录` | 产品 + 报价国家 + 客户 |
| `products` 产品目录 | `产品目录` | CAS 号（唯一） |

一行 Bitable 记录 = 一条工作台记录；Bitable `record_id` ↔ 本地 `id`，首次拉取时回填。`revision` 保持为本地计数器，不做跨节点乐观锁。

### 字段类型映射

- 数字字段（price、tax、sea、local、qty、sell 等）→ Bitable「数字」
- 日期字段（quoteDate、validity）→ Bitable「日期」
- 枚举字段（currency、unit、incoterm、warehouse、portfee、transportMode、creditPayment、bulky 等）→ Bitable「单选」，选项与 domain.js 枚举一致
- 长文本（details、hazard、quality、packing 等）→ Bitable「多行文本」

具体列名以实现时 `feishu.js` 中的映射表为准，建表时按映射表一次性创建。

## 配置与凭据

- 非敏感配置（appToken / 4 个 table_id / 启用开关）存插件配置，**只通过 configEditor 写入**（`ctx.fiber.entry` + `ctx.get('configEditor')`），绝不手改 `cordis.patch.yml`。
- app_id / app_secret 存为凭据记录 `credentialKey('quote-workbench', 'feishu')`，通过 `ctx.credentials.modifyRecord()` 写入；配置只存引用，不存机密。
- `index.js` 的 `inject` 增加 `'credentials'`。

## 同步引擎（feishu.js）

- tenant_access_token 内存缓存，过期前约 5 分钟刷新。
- 批量创建 / 更新 / 删除（batch_create / batch_update / batch_delete）。
- 写入路径：service.js 每次落库（`db.revision++; await this.storage.set(db)`）后触发尾部推送钩子；推送失败不阻塞本地操作，记录标记「待同步」，下次启动 / 手动刷新 / 定时器重推。
- 拉取路径：按字段级最后修改时间合并；冲突（同记录同字段两端都改）→ 本地优先 + 冲突提示。
- 定时器随插件生命周期清理（`ctx.effect`）。

## 未验证事实（实现时实测）

飞书开放平台文档页为客户端渲染 SPA，`web_fetch` 抓不到正文（HTTP 200 空内容，已两次验证）。以下细节以官方文档 URL 为准、以实测落地：

- 字段类型枚举值、批量接口载荷格式：https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview
- 新增记录：https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create
- tenant_access_token：https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal

## 待办

- [x] 冲突策略确认（本地优先并提示）
- [x] 刷新策略确认（自动刷新：启动全量 + 2 分钟增量）
- [x] 实现 feishu.js（API 客户端 + 字段映射 + 合并引擎）
- [x] configEditor 配置字段 + credentials 凭据记录
- [x] service.js 写入尾部推送钩子 + syncSetup / syncNow / syncStatus 动作
- [x] UI 同步状态面板 + 冲突提示
- [x] 测试 + README
