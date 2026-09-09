# Improvement Roadmap

基于 0.1.2（`d1e9127`）的全量代码审查，2026-09-08。按实施批次排列；批次内按优先级。
行号基于审查时的 main，实施时以当前代码为准。此文件不随 npm 包发布。

工作量：S = 小时级，M = 天级，L = 多天。

## 批次 1 — 安全与确定 bug（目标 0.1.3，尽快）

### 安全加固

- [x] **S1 · 补全生成配置的受管键覆盖**（`src/mihomo-config.ts:362-399`，S）
  `MANAGED_KEYS` 增加 `external-controller-unix`、`external-controller-pipe`、`tunnels`；
  `overlayManagedKeys` 对 `listeners` 整体拒绝或剥离（当前仅拒 `type: "tun"`，其余
  监听器类型带自有 `listen:` 地址透传）。补测试：订阅含上述键时的发布行为。
- [x] **S2 · 收紧公开路由的读取面**（`src/daemon/router.ts:180-195`、`src/daemon/handlers/profiles.ts`、`handlers/daemon.ts`，S）
  `GET /sash/profiles`、`GET /sash/settings` 改为控制鉴权；`daemon/status` 中
  `activeProfile.url` / `appliedProfile.url` 脱敏或鉴权后才返回（订阅 URL 常含凭据）。
  落地前确认 CLI 与 WebUI bootstrap 流程不依赖未鉴权读取（`daemon-ui.test.ts`）。

### bug 修复（全部 S）

- [x] `sash logs` 非 `--startup` 路径改用 `sashLayout()`，不再依赖可加载的 settings（`src/commands/logs.ts:22`）
- [x] `status` 键名 padding：`selected profile` 恰 16 字符与 `padEnd(16)` 撞车（`src/log.ts:18`）
- [x] WebUI 日志 warning 级别用 `--warning` 色与警示图标，与 error 区分（`web/src/views/LogsView.vue:221-223, 96`）
- [x] 暂停态"关闭全部 (N)"计数与实际关闭集合一致（`web/src/views/ConnectionsView.vue:271-288`）
- [x] 延迟测试端点使用更长的客户端超时，避免大组测试被 10s 统一超时误中止（`web/src/api/index.ts:60, 197-204`）
- [x] 错误体读取不吞真实 HTTP 错误：超 32KiB 时 `text()` 抛错替换了状态码错误
  （`src/github.ts:86,126`、`src/mihomo-config.ts:333`、`src/api.ts:62`）
- [x] `resolveLatestTag` 的裸 `catch` 不再吞 AbortError（`src/github.ts:69-71`）
- [x] 连接排序工具栏 `aria-label` 用错 i18n 键（`web/src/views/ConnectionsView.vue:22`）

## 批次 2 — 架构小件

- [x] **核心二进制哈希验证**（M）：`InstallRecord` 与更新 journal 存解压后二进制的
  SHA-256（下载时已知，`src/github.ts:213,241`）；`verifyBinary`/`restoreFiles`/恢复路径
  在执行前先验哈希，执行探测仅作健康检查（`src/core-update.ts:47-126`、`src/core-install-record.ts:8-11`）
- [x] **mutation queue 可观测**（S）：记录当前变更 purpose 与起始时间（`src/daemon/context.ts:29`
  现丢弃 `_purpose`），暴露到 daemon status，慢变更写日志，加队列深度计数
- [x] **状态快照缓存**（S）：`snapshot()` 每请求深拷贝全状态（`src/app-state.ts:104-106`，
  认证路径 `router.ts:427` 每请求触发）；改缓存冻结快照，commit 失效
- [x] **settings PATCH 乐观并发**（S）：接受 `expectedRevision`，复用 `assertCurrent`
  （`src/daemon/handlers/settings.ts:11-24`）；同时把 `revisions.profiles` 更名为状态 revision
- [x] **取消范围拆分**（S）：`stopCore` 不再取消 profile 下载（`src/daemon/app.ts:220-223`）
- [x] **`setCoreMode` 语义**（S–M）：采用运行时语义，controller 调用移出写队列；
  请求前后验证 Core 所有权，不写保存状态；Apply 恢复 profile 中的模式（`src/daemon/handlers/core.ts`）
- [x] **status 探测缓存**（S）：core 状态加短 TTL 缓存；`fresh=1` 需鉴权
  （`src/daemon/handlers/daemon.ts:45,57`）
- [x] 订阅更新失败退避（M）：meta 增加 `lastAttemptAt` 或按 `lastError` 指数退避，
  失败订阅不再每 15 分钟无限重试（`src/profiles.ts:78-84`、`src/daemon/scheduler.ts:22`）
- [x] `updateAll` 与 `updateDue` 共享 in-flight 守卫，按 profile id 去重（`src/profile-service.ts:355-369`）

## 批次 3 — CLI 功能

- [x] **`sash profile` 命令组**（M–L）：list / use / add <url> / update [--all] / rename / remove。
  daemon API 已完备（`src/sash-client.ts:297-383`），`SashDaemonClient` 加封装 + 薄命令模块。
  这是 CLI-first 定位下最大的功能缺口
- [x] **`sash proxy on|off|status`**（S–M）：`SettingsPatch.systemProxy` 与 `patchSettings` 已就绪
- [x] **`sash mode rule|global|direct`**（S）：`setMode` 已实现未接线（`src/sash-client.ts:273-277`）；
  依赖批次 2 的 setCoreMode 语义决定
- [x] **`sash update --check`**（M）：只查不装；同时给 update 加进度输出（见批次 5 的状态暴露）
- [x] **`sash upgrade [version]` 完整自更新**（L）：一步更新 Sash npm 包、daemon 与内置 WebUI；
  支持 `--check`，验证当前安装来源、prefix、目标版本与 Node 兼容性。
  停机前准备完整依赖与恢复材料，通过安装目录外的 helper 执行 npm 安装和新版本验证。
  协调共享安装的多实例，自动恢复原 daemon/Core/代理状态与实际已应用配置，保留未 Apply 修改。
  安装或健康检查失败自动恢复；中断后可恢复事务。独立安装目录、数据目录与端口完成端到端验证。
  实现约束与验收范围见 [自更新设计](docs/self-upgrade-design.md)。
- [x] **`sash stop --core`**（S）：与 WebUI "Stop Core"（保留 daemon）对齐
- [x] **status 探测并行化**（S–M）：daemon 查询、OS 代理检查、自启动检查无数据依赖，
  `Promise.all` 化，改善裸 `sash` 首因延迟（`src/status.ts:226-321`）
- [x] `sash auto on|off` 顺带启动 daemon 时予以提示或用后停止（`src/commands/auto.ts:17`）
- [x] `sash auto status` 支持 `--json`（S）
- [x] `sash update` 支持 `--json`（S）
- [x] `sash start` 区分"已在运行"与"新启动"：`CoreStartResult` 加 `alreadyRunning`（M）
- [x] `logs -f` 对 EPIPE 静默退出 0（S）；tail→follow 交接的重复行竞态（S）
- [x] `DEBUG` 改 `SASH_DEBUG` 并写入帮助（S）；`--help` 补充裸命令行为与退出码约定（S）
- [x] `sash update --version` 与全局 `-v` 歧义：改位置参数或 `--tag`（S）
- [x] `sash doctor`（M）：汇总安装检查、UI 资产、核心版本/哈希、端口、代理状态与修复建议

## 批次 4 — WebUI 性能与 UX

- [x] **overview 渲染成本**（分三步）：
  - [x] 响应未变则跳过 `setProxies` adoption（对比响应文本/哈希，`web/src/stores/core-actions.ts:46-47,145`，S）；本地选点与运行实例变更仍重新接收状态
  - [x] 节点卡 `content-visibility: auto`（日志页已有同款，S）
  - [x] 节点卡 `v-memo`（键含 member/选中态/延迟文本/测试态，M）
- [x] 组折叠状态持久化到 `localStorage`，默认展开前 4 组，其余折叠；显式选择优先（`OverviewProxyPane.vue:140-155`，S–M）
- [x] 大快照改 `shallowRef`：连接暂停快照、latency Set 等（`ConnectionsView.vue:161`、`composables/proxy-latency.ts:7-8`，S）
- [x] 连接行 `v-memo` 按流量、显示元数据及语言/相对时间失效（S）
- [x] **对比度修复**（S）：`.btn-secondary`（3.7:1）与连接标签色（2.8-3.3:1）不达 WCAG AA，
  且硬编码 hex 绕过主题变量（`web/src/styles/main.css:394-403, 78-83`）
- [x] 错误 toast 常驻或延长 + 悬停暂停（`web/src/stores/toast.ts:8`，S）；普通提示在悬停或键盘焦点期间暂停计时
- [x] 分页加页码跳转/首末页（`PaginationFooter.vue`，10k 规则时 125 页，S）
- [x] 异步路由 chunk 加 loading/error 组件与重载提示（`App.vue:79-83`，S）
- [x] a11y：`aria-pressed`（隐藏超时/暂停按钮）、排序方向语义、快照错误文本非 hover-only（S）
- [x] 延迟测试后支持按延迟排序；失败与超时区分并给 toast（M）
- [x] profile 卡片更新按钮反映互斥锁禁用态（`ProfilesView.vue:300-302`，S）
- [x] WS 短暂断连不清空流量历史（容忍一个丢失间隔，`App.vue:126-131`，S）
- [x] 清理死代码：未使用的图标、`cycleTheme`、未用 i18n 键；按实际使用组件裁剪图标，避免全量图标进入首页包（S）
  当前 `@remixicon/vue` 4.9 只发布总入口，无法使用独立组件子路径；构建时定向补全图标工厂的 PURE 注解，
  保留官方组件与现有依赖，首次加载 JS 从约 2.74 MB 降至 194 KB。

批次 4 验证：615 项测试、typecheck/lint、构建通过。`npm run smoke:ui` 使用隔离静态服务与 API/WS fixtures，
在 Chromium/Firefox、明暗主题、桌面及 390/320px 视口验证交互与布局；相关文字对比度最低 5.30:1。

## 批次 5 — 事件通道与可见性

- [x] **`/sash/events`**（M）：SSE 推送完整状态与 revision 变更（单写者 + 单调 revision 已就绪），
  WebUI 从 1Hz 轮询迁移，附带解决批次 2 的探测压力
- [x] **core update 进度暴露**（M）：`{downloading, stage}` 进 daemon status，
  CLI update 从 20 分钟静默改为阶段输出（`src/daemon/app.ts:88,138`、`src/sash-client.ts:100`）
- [x] `sash status --watch`（S，依赖 events）；支持终端重绘、重连和逐行 JSON，停止态不启动管理进程

批次 5 验证：628 项测试通过；真实 daemon 的 Chromium/Firefox 交互、授权、配置排序与自启动检查通过。
SSE 使用共享观察、心跳和有限缓冲；输出管道关闭时先取消读取，再正常退出，避免 Windows Node 24 的强制退出断言。

## 零散低优先级（顺手做）

- [x] 后端：下载内联 SHA-256、下载归档权限 0o600、controller 客户端禁跟随重定向、镜像切换时进度不回跳
- [x] 验收期依赖审计修复：生产 ZIP 读取改为 `yauzl` 流式解析，解压输出独占创建；
  旧 ZIP 库只用于生成测试归档，不随生产依赖安装，保留尺寸/路径/哈希限制和取消处理
- [x] daemon：网关剥离逐跳头、WebUI 会话 TTL 与滑动续期、listen 后挂常驻 error 日志、路由匹配首中即停
- [x] Apply 时缓存解析后的 profile 文档（M）：daemon 共享冻结 LRU，最多 8 项 / 16 MiB 源文档；
  每次读取校验文件身份及时间戳，替换、删除和非法文件类型使缓存失效
- [x] temp / 孤儿 revision 定期清扫（S）：24 小时宽限期，只删除已知生成文件和旧的空目录；
  保留当前引用、近期文件、未知文件及链接，Core 准备期间跳过临时文件
- [x] YAML 解析统一 `maxAliasCount: 50`；订阅 userinfo 空值保持未知（S）
- [x] 静态服务 fd-once、UI 未安装时明确 404 修复指引；状态文件读错带完整路径（S）
- [x] 订阅格式检测（S）：原始/base64/base64url 分享链接给定向 YAML 提示，不回显凭据或转换订阅
- [x] controller 延迟封装与 `sash status --delay <节点或组>`（M）：普通 status 不发起外网检测，
  组测试当前出口，区分失败/超时/名称不存在；JSON 仅按需附加结果，watch 每 30 秒串行检测并支持取消
- [x] PowerShell 缺失时 WinINet 通知回退与文档（S）：依次尝试两个 PowerShell 主机；
  均不可用时保留注册表操作结果并提示重启相关应用，所有权与回滚约束保持不变
- [x] doctor 检测额外的 Windows 独立连接代理记录并说明管理边界；不解码或改写系统二进制记录
- [x] Defender 首跑验证超时放宽到 20 秒（S）；哈希验证仍先于执行
- [x] PowerShell 7 补全脚本与安装说明（M）：命令/选项/固定取值、引号和光标位置支持，
  补全不启动 Sash 或访问网络；脚本随 npm 包分发

## 结项验收（2026-09-09）

批次 1–5 与零散低优先级事项全部完成。自更新按完整体验交付，验收遵循
[自更新设计](docs/self-upgrade-design.md)，未缩减为 MVP。

- typecheck、lint、完整测试通过：**657 项，零失败**，含真实 Core 的升级成功与失败回滚，
  以及共享安装多实例、中断恢复、未 Apply 修改、运行模式/选点和浏览器授权延续。
- `npm audit --omit=dev --audit-level=moderate` 通过，生产依赖 **0 个已知漏洞**。
  `adm-zip` 仅用于开发测试生成 ZIP；生产包使用只读 ZIP 解析器。
- 构建与 `npm pack --dry-run` 通过；实际 tarball 在隔离 prefix 安装并校验 **405 个文件**、
  Windows 两种命令 shim、CLI 帮助/版本和独立恢复 helper。
- Chromium/Firefox 的明暗主题、桌面与 390/320px 布局、SSE 重连、分块加载失败恢复通过；
  真实 daemon 的浏览器授权、刷新、保存/Apply、Core 停启、字体和布局验证通过。
- PowerShell 7 实际补全验证通过；延迟测试与故障注入全部使用隔离目录、端口或模拟接口。

版本仍为 **0.1.2**，变更记录在 Unreleased；本次结项不包含推送、版本升级或发布。

## 明确不做

- TUN 与服务模式（已于 2026-09-08 移除表述与分支，不在路线图）
- 内置订阅格式转换（只做检测与提示，转换属独立 scope 决策）
- WinINET per-connection 代理设置的原生管理（先文档化限制 + doctor 检测）
