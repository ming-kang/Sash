# Sash 修复与重构计划

本计划基于发布前只读审计。项目尚未发布，因此公开 npm/GitHub 地址当前返回 404 不是缺陷，只保留为首次发布前检查项。

## 执行规则

- 按下列顺序实施，不并行提交存在依赖关系的事项。
- 每完成一项，先运行该项测试以及 `npm run typecheck`、`npm run lint`；修改测试时还要运行相关测试并最终运行 `npm test`。
- 每项完成后更新本文件状态，并以一个独立提交提交该项代码、测试、文档、CHANGELOG 和 `PLAN.md`。
- 只暂存本项修改的明确路径；不得使用 `git add .` 或 `git add -A`。
- 不削弱进程身份验证、loopback 直连、凭据清洗、原子状态、下载来源/摘要和不可信 profile 校验等安全不变量。
- 所有运行测试使用隔离的 `SASH_HOME` 和非默认端口；不得启用 TUN。
- 不发布、不推送、不创建标签；这些操作仍需维护者另行明确授权。

## 固定设计决策

- 最低运行时采用 Node.js 24，不兼容 Node 20/22。
- 保留现有 `SASH_HOME` 数据；状态格式变化必须有显式迁移和崩溃恢复。
- 不引入通用 Web 框架、ORM 或大型状态库；优先使用小型、职责明确的内部模块。
- Core 继续在安装时下载，不进入 npm tarball。
- Core 在停止状态下更新时采用延迟健康确认：保留 `.bak`，在下一次成功托管启动后提交更新。
- amd64 默认选择 broadly-compatible 上游构建；不增加复杂且不可靠的跨平台 CPU feature 探测。

## 实施清单

### 1. 要求 Node.js 24 — 已完成

目标：统一运行时、类型、CI 和文档契约。

- `package.json` 的 engine 改为 `>=24.0.0`，`@types/node` 改为 24.x。
- `node-version-guard` 要求 Node 24，并保持它是 CLI 的首个 import。
- CI 三平台统一使用 Node 24。
- 更新 README、前端架构文档、CHANGELOG 和 `AGENTS.md` 中的旧基线。
- 保持 TypeScript 输出目标不变，除非后续实现确实需要新语法。

验收：lockfile 一致；typecheck、lint、完整测试和 build 通过。

完成记录：Node.js 24.13.0 环境下 typecheck、lint、306 项测试（305 通过、1 项既有 Windows skip）和 production build 全部通过。

### 2. 隔离畸形 daemon 请求 — 已完成

目标：任何畸形 HTTP request-target 或 Upgrade 请求都不能产生未处理 rejection 或终止 sashd。

- 将 `http.createServer` listener 改为非 async 包装器，显式接住完整请求 Promise。
- 将 URL 解析纳入错误边界；非法 URL 返回 400。
- Upgrade handler 增加同步错误边界。
- 响应头已发送时销毁连接，不重复写响应。
- 500 使用固定公开文案，详细错误只写 daemon stderr。

验收：畸形 request-target/Upgrade 后 daemon 仍能处理下一请求；真实子进程不退出。

完成记录：HTTP listener 现在显式接住请求 Promise，HTTP 与 Upgrade URL 解析均在错误边界内；新增两项回归测试确认返回 400 后 daemon 继续服务。lint 与 308 项测试（307 通过、1 项既有 Windows skip）通过。

### 3. 鉴权全部 Core 网关请求 — 已完成

目标：不再用 HTTP 方法猜测 Core 请求是否敏感。

- 明确区分 public、authenticated control、authenticated Core gateway 路由。
- `/core/api/*` 及兼容 Core 路由的所有方法都要求 daemon bearer 或 boot token。
- 未认证请求必须在建立上游连接前返回 401。
- mutation 若带 `Origin`，要求 loopback Origin；无 Origin 的 CLI 仍可调用。
- 继续剥离 daemon 凭据并仅在服务端注入 Core secret。

验收：未认证 delay GET 返回 401 且 mock Core 没有收到请求；认证请求仍正常转发。

完成记录：Core HTTP 路由使用单一显式分类器，GET/HEAD/OPTIONS 与 mutation 均在转发前鉴权；带远端 Origin 的浏览器 mutation 返回 403。mock Core 证明未认证 delay/fallback GET 没有建立上游请求；lint 与 311 项测试（310 通过、1 项既有 Windows skip）通过。

### 4. 关闭废弃 WebSocket 上游 — 已完成

目标：客户端在上游 101 前断开时立即取消上游请求和 socket。

- 创建上游请求时立即绑定下游 close/error。
- 使用幂等 cleanup，避免双重 destroy。
- 写 101 前检查下游 socket 状态。
- 上游 rejection、timeout、close 统一清理双方资源。

验收：事件屏障控制的早断开测试确认上游 request/socket 被关闭，不依赖任意 sleep。

完成记录：WebSocket proxy 在等待 101 前即取得上下游 request/transport 所有权，并读取暂停的 downstream socket 以观察 FIN；早断开会关闭 request、transport 和后到的上游 socket。事件屏障测试确认 mock Core 收到 EOF；lint 与 312 项测试（311 通过、1 项既有 Windows skip）通过。

### 5. 阻止 Dashboard framing — 已完成

目标：阻止任意网页 iframe 嵌入本地 Dashboard 并点击劫持。

- UI 文档响应设置 `Content-Security-Policy: frame-ancestors 'none'`。
- 同时设置 `X-Frame-Options: DENY`。
- 增加 `X-Content-Type-Options: nosniff` 和 `Referrer-Policy: no-referrer`。

验收：内置 UI、自定义 UI 和 SPA fallback 响应均包含 anti-frame headers。

完成记录：静态 UI 的 HTML、SPA fallback、asset、HEAD 与错误响应统一附加 CSP `frame-ancestors 'none'`、X-Frame-Options、nosniff 和 no-referrer。测试覆盖自定义 UI 的文档/fallback/asset；lint 与 313 项测试（312 通过、1 项既有 Windows skip）通过。

### 6. 校验 daemon JSON 请求契约 — 已完成

目标：客户端输入错误使用明确 400/413，不泄露内部 TypeError。

- 在 `daemon-http.ts` 增加类型化 `HttpError` 和 `parseJsonObjectBody`。
- malformed JSON 返回 400；`null`、数组、标量 root 返回 400；超限返回 413。
- 业务路由不再直接强转未知 body。
- oversized/aborted body 不得留下悬挂 Promise。

验收：malformed、null、array、oversized、aborted body 的状态码和资源清理均有测试。

完成记录：新增类型化 HttpError 与 object-only JSON parser；malformed/non-object 为 400、超限为 413，超限输入改为有界丢弃而非提前 reset，aborted/error/close 均结算 parser。设置/profile 路由移除未知值强转；lint 与 317 项测试（316 通过、1 项既有 Windows skip）通过。

### 7. 拒绝过期 Profile preparation — 已完成

目标：锁外准备的配置只能基于提交时仍然相同的 profile 内容。

- 统一读取原始 profile、解析 YAML 并计算 SHA-256 `ProfileSourceSnapshot`。
- profile YAML 限制为 8 MiB，index 增加合理上限并要求普通文件。
- settings、activate、reload、update、delete 和缺失 profile 物化在提交锁内复核 activeId、URL 和内容摘要。
- Settings 冲突自动重新 prepare 一次，第二次冲突返回 409；不无限重试。
- 统一 profile ID 分配，同时检查 index 与磁盘文件。

验收：设置/profile、双更新和缺失 profile 的确定性竞态均不能产生 metadata/config 分叉或旧响应覆盖。

完成记录：stored profile 以单次有界读取同时解析并计算 SHA-256，settings、activate、reload、update、remove、existing add 与缺失内容物化在提交边界复核摘要和完整目标 metadata；stale update/error 被拒绝，settings 仅自动重试一次。profile/index 要求普通文件并限制为 8/2 MiB，interval 有界，统一 ID 分配检查 metadata 与孤儿文件。确定性测试覆盖 settings/profile 分叉、activation 编辑、双进程乱序更新、缺失文件出现、资源边界和冲突重试；lint 与 325 项测试（324 通过、1 项既有 Windows skip）通过。

### 8. 为 Core 更新建立持久化 journal — 待办

目标：`.bak` 只在新 Core 通过托管健康检查并恢复原运行状态后删除。

- 新增 `state/core-update-transaction.json`，记录 previous、target、wasRunning 和 `prepared/swapped/health-verified` phase。
- journal 在任何二进制 rename 前 durable 写入。
- 运行中的 Core：验证 target，恢复原 daemon/Core 状态后才 finalize。
- 停止中的 Core：保留 `.bak/journal`；下一次 `sash start` 成功后 finalize，失败则恢复旧 Core/metadata。
- 启动、update 和离线命令在一致性断言前恢复未完成 journal。

验收：每个 phase 的故障注入、延迟验证成功/失败和自动回滚都有测试。

### 9. 强化 Windows Core 文件恢复 — 待办

目标：Windows 瞬时文件锁或 `.unlock-probe` 中断不会破坏唯一可用 Core。

- 将 rename helper 拆成非破坏性重试与 durable rename；失败时绝不删除源文件。
- 对 `EPERM/EBUSY/EACCES` 有界退避。
- 在 Core 一致性断言前恢复 `.unlock-probe`。
- target 与 probe 同时存在时依据 journal；无法判断时 fail closed 并保留两者。

验收：模拟连续 EBUSY、两个 rename 间崩溃、target/probe 冲突，均不丢失最后可用二进制。

### 10. 选择兼容的 amd64 资产 — 待办

目标：README 所称 x64 平台不默认要求 x86-64-v3。

- Windows/macOS/Linux amd64 候选改为 compatible、v1、plain v3。
- 测试实际选择结果，而不是只复述候选字符串。
- 不增加 CPU feature 探测；未来若有基准证据，再设计显式 variant。

验收：含所有上游资产时选择 compatible；非 amd64 行为不变。

### 11. 清洗全部 helper 子进程环境 — 待办

目标：所有由 Sash 启动的 helper 都看不到 token/npm 凭据。

- 提供小型 `runSanitizedFileSync`/共享 spawn options，默认 `shell: false`、timeout、windowsHide 和 scrubbed env。
- 迁移 PowerShell、tasklist/taskkill、ps、reg.exe、networksetup、gsettings、which 等调用。
- Windows 系统命令优先使用可信绝对路径。

验收：helper 测试进程看不到 `GITHUB_TOKEN`、`NPM_TOKEN` 和 npm auth 配置；现有跨平台解析测试通过。

### 12. 限制下载总时长 — 待办

目标：持续产生小块数据的响应也不能无限占用更新命令。

- `DownloadOptions` 增加跨 redirect/header/body 的共享 absolute deadline，默认 10–15 分钟。
- 每一跳使用同一个 AbortSignal；保留现有 stall timeout 和大小上限。
- redirect/error body 有界丢弃或直接销毁。
- 同时修正 Core reload 为 `PUT /configs?force=true`，body 仅包含 `path`。
- IPv6 redirect 分类改用字节/CIDR 判断，覆盖 mapped/compatible、ULA、link-local、multicast 和 loopback。

验收：永不 stall 的慢流仍在 deadline 到达时终止；redirect/body/force query/IPv6 分类测试通过。

### 13. 同步前端运行时所有权 — 待办

目标：profile、daemon 和 Core 状态独立表达，不把下游瞬时失败伪装成 daemon 离线。

- 单独保存 `lastProfileRevision`，Core 停止时 revision 变化仍刷新 profiles。
- 增加 daemon online、Core snapshot available/error 状态。
- 相同 runtime generation 的临时 Core API 失败保留最后有效数据并显示 degraded；owner 改变且新快照失败时清除旧 owner 数据。
- traffic/log frame 做轻量运行时校验。
- Settings dirty 改为与 committed value 比较，并提供 reset。

验收：stopped revision、Core 502、daemon 重启、generation 更换和 settings revert 均有 store/component 行为测试。

### 14. 显式表示 CLI 未知状态 — 待办

目标：自动化能够区分 stopped、unhealthy 和 unavailable。

- 定义稳定的 status JSON 契约；未知值使用 `null`，并提供 `healthy/queryError`。
- 文本模式不可对不可响应 daemon 输出成功状态。
- 退出码：完整状态 0、可输出但不可完全观测 2、命令失败 1。
- `proxy status` 分开 desired、daemon-applied、OS-observed，并区分 stopped/unhealthy。
- TUN guidance 只在对应运行状态下输出。

验收：healthy、stopped、unhealthy、status timeout 和 JSON 模式均有测试。

### 15. 实现可靠日志 follow — 待办

目标：`-f` 真正等待未来日志，并正确处理 rotation 和参数错误。

- 文件尚未创建时等待创建。
- 根据文件 identity/size 识别 rotation/truncation 并从新文件继续。
- SIGINT/SIGTERM 清理 watcher、timer 和文件句柄。
- `-n` 仅接受 `/^[1-9]\d*$/`，拒绝小数、前缀数字和溢出值。

验收：延迟创建、append、truncate、rename rotation、取消和严格参数测试通过。

### 16. 对齐预发布状态与第三方 notices — 待办

目标：文档准确表达开发状态，首次发布前许可告知完整。

- `[0.1.0]` 尚未实际发布，因此并回 `[Unreleased]`。
- README 将 npm 安装标为尚未发布，并提供 `npm ci`/build/link 开发安装流程。
- 开发阶段设置 `private: true` 防止误发布；正式发布需单独明确移除。
- 上游归属链接到 Meta/release，不再错误声明 MIT；说明许可按 release 附带条款，当前为 GPL-3.0。
- 新增统一 third-party notices，包含 Vue MIT 和 Remix Icon，并确保进入 tarball。

验收：文档/metadata 一致；tarball 包含 notices；不执行 publish/tag/push。

### 17. 在 CI 验证打包产物 — 待办

目标：CI 验证用户实际安装的 tarball，而不是只验证源码树和 dry-run。

- 替换 `webui.test.ts` 可能零断言通过的条件逻辑。
- 增加构建后 `dist` smoke 与实际 `npm pack`/临时 prefix 安装。
- 运行安装后的 `sash --version` 和 `sash --help`。
- 断言 tarball 包含 UI/docs/notices，且不含上游二进制、测试、`node_modules`、用户数据或 secrets。
- 将 smoke 接入 CI 与 `prepublishOnly` 前置门禁。
- 移除 Windows 强制终止测试 skip，通过依赖注入覆盖 force signal 前再次身份复核。
- 评估并引入最小 Vue 行为测试栈；不以覆盖率数字替代行为测试。

验收：三平台 CI、生产依赖 audit、完整测试、build 和真实 tarball smoke 全部通过。

## 最终完成条件

- 所有 17 项均标记完成并有独立提交。
- `npm run lint`、`npm test`、`npm run build`、`npm audit --omit=dev --audit-level=moderate` 全部通过。
- 实际 tarball 安装和 CLI/UI smoke 通过。
- `git status` 仅显示维护者原有的未提交文件；若没有则应干净。
- 不启动真实用户实例、不启用 TUN、不发布、不推送。
