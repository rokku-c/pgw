# Agent Trajectory 产品与实现契约

本文替代旧版“混合事件列表 + 全库状态快照”的 Agent 可观测性定义。实现完成以本文验收矩阵为准，不以页面可打开或接口返回 200 为准。

## 产品目标

以 Agent Session 为中心还原执行过程：Session → Turn → Step → Context Snapshot → Model Call → Tool Call → Result → Context Mutation。用户能从任意节点追溯原始事实、上下文来源、路由变化、工具因果关系及运行控制行为，并比较两个明确时点的状态。

参考本地 `deepseek-harness/packages/client/ui-trajectory` 的会话轨迹、请求头快照、工具树、TTFT/decoding 分段与按窗口加载；吸收交互与数据语义，不引入 Cordis 或复制组件。

## 身份与来源

| 对象 | 身份和依据 | 展示要求 |
| --- | --- | --- |
| AgentInstance | Agent 类型、版本、托管进程/连接标识 | 扫描发现不等于正在运行；PID 不作为持久身份 |
| AgentSession | 有作用域的原生 Session ID、采集源、运行 ID | scanned / managed / independent 保持独立来源并允许证据关联 |
| Turn | 原生 turn ID 或网关明确提交的 turn | 从用户消息推导的轮次标记 derived，不冒充原生轮次 |
| Step | 轮内原生 step、模型调用或控制操作 | 重试属于同一次逻辑调用的 Attempt，不新增用户轮次 |
| ModelCall | requestGroupId；每次实际发送对应 traffic.id | 请求、effective、upstream、response、output 均可定位 |
| ToolCall | 原生 call ID、模型调用 ID、工具来源 | 工具请求与实际执行分开；无执行证据不能显示执行成功 |
| ContextMutation | 前后 snapshot ID、来源与策略版本 | 区分追加消息、system 更新、工具目录变化、压缩、偏好注入 |
| RuntimeEvent | run ID、原生事件序号、控制来源 | 启停、steer、审批、恢复、退出和预算事件进入所属会话 |

关联边保存 relation、evidence、source、scope、certainty（explicit / derived / candidate）、confidence。明确 ID 仍必须检查 client/run、Agent、项目与采集源作用域；相同字符串不足以跨用户/项目合并。根据时间窗口提出候选关系，不自动将候选变成事实。route affinity 是路由粘性，不等同 Agent Session，不能为了观测改变路由锁和并发语义。

## 界面

- 左：Agent / 项目 / Session 树，可区分扫描、托管、独立调用、分支和子 Agent。历史自动分页，不受最近 200 条全局流量限制。
- 中：按 Turn 与 Step 分组的 Trajectory；sticky 轮次标题、时间轨、上下文变更节点、模型调用、工具调用树、压缩与结束节点。时间未知显示未知，不用扫描时间代替事件发生时间。
- 右：统一 Inspector，含内容、原文、来源、Headers、参数、工具 schema、路由/重试、usage/费用、快照及 Diff。切换节点只读当前节点数据。
- 消息按 user/assistant/system/developer/tool 显示；reasoning、正文、工具参数、结果、图片引用及未知块分别呈现。未知字段保留 Raw，不因结构化展示丢失事实。
- 托管 Session 显示已有权限范围内的 pause/resume/steer/stop、审批、预算与超时。浏览轨迹不触发执行或重放。
- 大文本、长工具 schema、长 SSE、历史事件、Diff 使用独立窗口；滚动自动加载；显示完整/部分/过期/未记录状态及来源覆盖范围。

## Context Snapshot 与 Diff

快照绑定 session/turn/step/modelCall 和明确序号，包含当时的 system/instructions、messages、tools 与 tool choice、请求参数、已应用偏好版本、route/provider/model/protocol、运行限制与状态、已知 Skill/MCP 内容身份。未知历史状态不从“当前配置”补造。

1. 请求五阶段是独立事实，不从最后阶段反推前面阶段。相同内容可引用同一内容身份，避免重复入库。
2. JSON 原文与协议字段按实际观测值保存。投影不脱敏、不执行工具、不改写请求。Headers/凭据受加密与管理鉴权保护；脱敏映射是另外的派生查看/导出功能。
3. SSE 按协议累计 delta 并与最终 snapshot 对齐，不能同时拼接 delta 和完整 final 导致文本重复。未知事件可回到 Raw；截断的 JSON 不解释成空上下文。
4. 比较 system/instructions、消息追加/删除/变更、工具 schema 增减/变更、tool choice/参数、路由、运行状态、上下文来源。每项同时给 before 和 after；不能只展示 after。
5. 工具按稳定名称/ID 对齐、消息优先按原生 ID 对齐；无 ID 时使用共同前缀/后缀识别追加，避免数组前插导致成千上万虚假变化。
6. 比较分页并报告 total/next/coverage；缺失、过期、记录上限和未覆盖历史不是删除，也不是“无变化”。
7. 人工快照只保存所选会话/步骤必要事实和内容引用，不定时复制整个数据库。扫描 Session 继续 filesystem-first；可重建正文不因观测永久重复入库。显式保留的快照可独立加密保存，具备删除及期限策略。

## 性能与一致性

- 原始采集与派生投影分离。代理只采集，查看时才解析/重建/Diff；CPU 与同步 SQLite 工作在 Worker，不是将主线程函数写成 async。
- 页面只接收当前窗口的摘要和预览；展开后按字段分页取完整内容。避免下载完整 JSON 才显示第一页，或前端每次 append 重解析整个流。
- 复用已有 scheduler、取消、进度和恢复约束；解析缓存有容量、版本和授权失效条件。正文关闭/删除后清理派生缓存，不从已失效 job result 恢复正文。
- 快照固定输入版本；源文件被替换/截短/改写时返回覆盖错误。只允许证明历史前缀未变的 append 继续读取。
- 一条索引、解析或比较失败不阻止实时模型调用。关闭页面取消浏览任务，停止后台轮询。
- TTFT 必须标清首字节还是首 token。只有有真实采样时间才绘制排队、上游等待、生成和工具执行段；已有 firstByteMs 不能直接冒充模型纯生成耗时。

## 验收矩阵

| 编号 | 完成证据 |
| --- | --- |
| T01 | 三类 Session 可分页发现、身份不混淆；扫描源离线可见状态 |
| T02 | 原生/托管 turn、step、子会话分支可定位，derived 标记可见 |
| T03 | 四协议 JSON/SSE 的文本、reasoning、工具参数/结果正确、不重复、不漏未知内容 |
| T04 | 五阶段事实可读，原始请求不被 boundOutput/个性化变异，错误输出不冒充成功输出 |
| T05 | ToolCall 以 call ID 关联，审批与执行结果有独立证据；并发工具不串联 |
| T06 | explicit/derived/candidate 关联有作用域、依据和来源；误匹配不合并 |
| T07 | 快照绑定具体调用/步骤，可逐字段读 system/messages/tools/config/runtime/route |
| T08 | 语义 Diff before/after 正确；新增工具/消息前插不造成全量位置差异 |
| T09 | 旧记录未采集、截断、过期、删除均显示 coverage，不静默伪造结果 |
| T10 | 扫描、模型调用、托管事件共用 Inspector，原始来源可以追溯 |
| T11 | 三栏轨迹、Turn/Step 分组、工具树和耗时轨可实际操作；中英 UI 无裸 key |
| T12 | 16 MiB 请求、长流、大 schema 与长历史只按窗口渲染，滚动不重复或串页 |
| T13 | projection、快照、Diff 都不在代理主线程执行；取消与读授权变更生效 |
| T14 | 现有管理动作、审批与预算接入轨迹，浏览/比较无运行副作用 |
| T15 | 原文/快照/缓存的加密、删除、期限和导出范围有验证证据 |

实现状态另记在 `implementation-status.md`；绿色类型检查或通用 smoke check 不代替上述行为验收。

## 已落地的接口边界

- `GET /api/trajectory/sessions`：kind/query/keyset cursor，独立目录分页。
- `GET /api/trajectory/sessions/:key/nodes`：窗口 offset/limit、固定 revision、关联候选证据；三类来源保留身份命名空间。
- `GET /api/trajectory/sessions/:key/node`：source kind/id 的作用域验证、原始记录按字符窗口读取；扫描节点另行验证原文件身份和授权。
- `GET /api/trajectory/calls/:requestId/inspect`：完整采集体在 projection Worker 解析，只向前端返回结构化窗口和预览；单字段展开分页。
- `GET /api/trajectory/calls/:requestId/diff`：指定两次调用的 effective 内容比较，覆盖缺口不作为删除。

这些接口是实现契约，不代表全部验收已经完成。当前调用级对比依赖原采集留存；独立持久 Context Snapshot 尚需完成，不能把调用内容视为已经可独立保存的快照。

## Context Snapshot 生命周期

Context Snapshot 是节点级的显式动作，不是定时全库复制。创建必须引用一个 session node，并将 `sessionKey/nodeKind/nodeId` 固定；traffic 节点保存实际观测 stage，扫描/托管节点保存已授权的节点记录。源仍在运行或记录不完整时显示原因并拒绝创建，不猜测补全。

SQLite 只保存 manifest，正文压缩、加密后写入受控文件目录；写入顺序为临时文件 → fsync → 原子 rename → manifest ready。取消、崩溃、文件变更、容量超限、版本不支持都不能产生 ready 状态。读取前校验权限、路径、link 数、mode、size、hash、期限，正文在 Worker 中按字段/窗口返回。

快照 Diff 先检查 session scope 和每边 stage coverage，再将 system/messages/tools/config/runtime/route 归一化。模型调用快照比较调用有效上下文，不将 request stage 的协议包装或当前配置补入历史。删除源记录之后，独立快照继续遵守自己的期限；删除快照必须删除文件、manifest 与内存缓存。

## MCP 与性能节点

MCP Tool Call 是独立节点，只有同一个 session scope 且 `parentCallId` 明确指向模型调用时才建立 `tool_result_of` 关系；名称、时间或参数相似不能替代 call ID。审批是另一个节点，批准不等于执行成功，执行状态和结果分别取实际记录。

性能字段分为 first byte、first token、decoding。first byte 是上游 Response body 首字节；first token 只在协议事件包含可见文本/reasoning/tool delta 时采样；decoding 是完成时刻减去首 token。缺失采样保持 null。不能用总 latency 伪造任一细分时间。

## Adaptive context 与重试

上下文管理是策略而不是事实覆盖：原始 request 永不改写，effective/upstream 阶段保留实际压缩后的请求。学习记录按 Provider/model/protocol 维护成功输入下界、context error 上界和观察次数；不能由单次成功调用声称上游最大窗口。默认压缩比例为 80%，压缩时可注入 awareness prompt 并在路由决策标注删除数量。

协议转换独立开关控制；转换关闭不允许用另一协议伪装成功。透明重试只重试明确状态且尚未产生客户端输出的请求，设置 max retries/backoff/status whitelist；每个 attempt 有独立事实，最终响应对客户端透明但 UI 可见 attempts/retry number。网络提交后结果未知不自动重放。
