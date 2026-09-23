# 实现状态

更新时间：2026-09-20。完整交付目标保持不变；当前状态为开发中。

## 已有实现与证据

| 能力 | 当前实现 | 已取得的证据 |
| --- | --- | --- |
| 技术基础 | Bun、TypeScript、Effect、TypeORM、SQLite、React、Radix、MCP SDK v2；后台 Scheduler/Worker；zh-CN/en-US i18n | `bun run check`、`bun run build` 成功；SQLite 初始化、读写与版本迁移入口可运行 |
| SQLite 驱动 | TypeORM 的 SQLite 驱动接口接入 `bun:sqlite` | 当前 Bun 1.3.4 不支持原生 better-sqlite3；已用实际 repository 操作验证适配器 |
| 安全入口 | 本地绑定、Host/Origin 校验、管理会话、独立客户端密钥、加密保存上游凭据 | 无认证管理请求返回 401；管理配置和资产导出不返回明文密钥 |
| 模型管理 | Provider、后台探测、映射、加权轮询、最少在途、目标并发、熔断与会话绑定 | 加权1:2分流、目标并发互斥、429安全回退、503结果未知不重放、会话身份和凭据绑定通过隔离验证 |
| API 转发 | 四种API的原生转发及文本/工具JSON与实时SSE互转，默认/providers前缀 | 4×4×2共32条协议路径通过本地矩阵验证；跨协议在上游结束前已返回文本/工具增量，Unicode与usage一致 |
| 流量与计费 | 请求尝试、状态、延迟、token、计价快照、确定精度费用、客户端预算/并发/过期限制、原子预算预留与结算 | 四协议模拟链路通过；并发竞争中只有足够额度的请求送达上游；结算、Token 上限、并发限额验证通过 |
| 个人偏好 | 明确授权后的本地候选提取、手选会话证据、确认/暂停、正文修订历史、版本恢复、反例复核和变迁时间线 | 自动候选不生效；工具返回内容不进入用户偏好；修订恢复、证据关联、删除传播与拒绝候选不再自动生成通过本地验证 |
| 本地资产 | Agent版本、Skill多来源、YAML元数据、重复/冲突、加密包快照、安装预览与恢复；会话独立授权与索引 | 原生格式索引回归通过；Skill支持文件/隐藏文件/空目录与权限恢复，预览后改动阻止覆盖；浏览器安装与恢复闭环通过 |
| MCP | 外部工具/资源/提示词聚合、客户端白名单、schema绑定授权、持久审批、加密调用详情、取消、目录历史和参数校验 | SDK Client完成受限目录、审批前零调用、拒绝/撤销/取消、输入校验、Resource/Prompt、目录漂移及历史验证；浏览器完整授权与审批闭环通过 |
| 运行 | Codex App Server、Pi RPC、Claude 原生会话；目标条件、轮次/时间预算、无进展停止、暂停、恢复、调整、原生审批、任务事件与进程组回收 | 三种本机真实 Agent 分别对接本地模拟上游，完成两轮调用及相同会话恢复；结构化进程夹具验证目标续跑、文件依据、拒绝后停止、暂停恢复、取消和硬轮次限制 |
| Wrapper | `pgw claude/codex/pi`、原生终端、临时凭据回收；Codex/Claude通过`--access`注入授权MCP配置；`PGW_ALIAS`/`PGW_TRANSPARENT` 控制模型名呈现 | 实际Codex列出注入配置，Claude实际会话连接网关MCP并向模型提供受限工具；临时凭据回收和不覆盖原始配置路径已核对 |
| 控制台 | 总览、模型、流量、会话、资产、偏好、运行、任务、调试台、设置、命令入口、预算配置、审批收件箱、MCP授权和双语言切换 | Chromium 打开全部页面；浏览器创建密钥、注册/探测 MCP；新建目标任务、批准原生请求、确认完成；无 pageerror；390px 无横向溢出 |

API 和浏览器验证使用独立临时数据目录、本地模拟上游及临时浏览器脚本，不使用个人上游密钥，不向外部模型提交请求。仓库未加入测试文件；`doctor` 是保留的可运行诊断入口。

## 完整验收仍缺失的能力

本表对应产品方案第14节，不构成延期或范围缩减。

| 能力域 | 尚需实现或补全 |
| --- | --- |
| 网关 | 目标池能力动态探测、项目聚合预算、价格目录版本、缓存计价、多模态实际计数、流事件的完整协议细节、跨版本状态迁移 |
| 接入 | 版本化配置适配、首次授权安装、一键设置的差异备份恢复、Skills/MCP 注入、启动配方、多并发配置隔离、原生身份冲突诊断、真实 Agent 接入验证 |
| Session | 更广的原生版本兼容、子会话父子关联、项目/仓库身份、显式请求关联、原生恢复与跨Agent交接、元数据级自动保留与清理策略 |
| 资产 | Git来源与远端更新检查、运行时使用反馈、插件载入兼容性、超大包和特殊文件元数据、安装中断恢复/旧快照清理与配方自动分发 |
| MCP | 远端OAuth、Resource Templates、断线与长任务恢复、完整新协议多轮输入机制、目录主动通知、调用保留/删除策略、更多传输及版本兼容 |
| Persona | 场景/临时偏好层、长期变化归因、偏好锁定/有效期、模型异步归纳、冲突/替代关系、更多纠错提取、学习效果评估及外发授权 |
| 个性化 | 建议与改写模式、策略编辑与持久 diff、项目记忆检索、冲突解释、动态控制、状态型输入与缓存影响管理 |
| Runtime | Claude 原生双向审批桥接、Pi 写入沙箱、原生版本能力降级、可插拔完成依据、完整权限类型、预算原生错误分类、事件值守、持久恢复与进程残留核对 |
| 连续性 | 项目决策、任务与成果对象、工作配方、文件基线、配置时间机器、交接和轨迹对照 |
| Harbor | 运行器、ATIF 转换、环境与凭据注入、日志/成果导入、取消、恢复与交接 |
| 洞察与自动化 | 适配榜、摩擦分析、工作简报、自动化规则、策略效果对照、影子预览 |
| 多设备与数据治理 | 配对、加密同步、冲突处理、保留期限、一致性备份恢复、空间管理及删除传播 |
| UI/CLI 完整性 | 新增业务继续沿用双语key和统一格式化；完善项目选择、调试流、任务进度、审批、诊断和所有受支持状态 |

## Coordinator 中继进展（2026-09-23）

已实现的最小闭环：

- 托管 `pgw run` 支持 `coordinatorMode=off|suggest|continue`，CLI 和 Web 均可选择。
- 只有确认收到工具活动/工具结果后才做续跑判断；用户停止、审批等待、失败、中断、无工具活动和完成条件满足会停止。
- `continue` 通过同一托管 Agent Session 发起下一轮，`suggest` 转为等待用户确认；Coordinator 决策写入 Run Event。
- 已有 Codex/Pi/Claude 适配器控制接口仍按各自能力执行；未托管外部 Agent 尚未提供通用跨进程控制，也不会按 PID 强杀。

尚未实现的产品设计项：

- 外部 Agent 的认证跨进程控制、优雅停止/恢复、Handoff 包和未知副作用处理。
- 透明下一请求 Coordinator Context 注入、只读虚拟查询工具、历史查询句柄和内部查询/归纳的独立预算。
- Project/Global Coordinator、干预 Proposal/Intervention 实体、注入 Diff、撤销期限和完整审计展示。

当前实现是“托管续跑协调器”，不是完整的双通道中继。产品设计已在 `docs/product-plan.md` 第 7.4.4 节固定上述边界，后续应先做透明只读查询，再做跨进程恢复，最后才考虑透明内部模型多轮。

## 当前运行边界

- 当前运行支持单回合和目标模式；目标模式按文件存在/包含文本核对，缺少机器可判定条件时进入等待用户确认，不将模型自称完成直接视为目标完成。
- Codex 支持只读/工作区写入沙箱和命令、文件、用户输入审批桥接；未支持的权限请求阻塞而不是自动放行。Pi 当前通过只读工具集限制写入，不宣称这是完整进程沙箱；Claude 使用隔离配置，遇到权限拒绝阻塞并保留恢复入口。
- 预算在提交前按配置的上下文容量与受限输出上限预留，未知用量或中断保持保守占用。已定价的实际账单按6位价格精度与整数微美元结算；上游异常计费、多模态容量和缓存计价仍需完善，不能把网关预留等同于服务商账单的绝对上限。
- 进程实例在迁移和恢复前取得数据库运行归属，第二实例不会重置现有任务。正常关闭暂停任务、撤销凭据、停止受管进程组；重启后需要明确恢复，不重复执行结果未知的操作。
- MCP聚合入口支持独立客户端凭据，模型调用密钥默认没有MCP权限；客户端按连接、具体工具/资源/提示词和目录hash授权。个人记忆权限单独开启，项目范围在入口校验。
- 默认每次外部调用进入持久审批；等待审批时尚未调用远端工具，批准后再次检查授权及实际目录。运行中取消标为uncertain，不能保证远端副作用已经回滚，也不会自动重试。
- MCP请求参数与结果使用本地主密钥加密保存，列表仅返回元数据，认证管理详情接口按需解密。Admin MCP持有管理权限；提供给Agent的入口使用受限客户端密钥。
- Codex/Claude wrapper的`--access CLIENT_ID`在启动时复制已保存的MCP授权快照，创建独立临时客户端；父客户端不是实时继承链，撤销运行访问应撤销对应临时客户端或停止任务。Pi仍需显式MCP扩展适配。
- 客户端可带`modelAliases`（`{name,routeId}`，`name`为`*`时兜底）：请求模型名先按路由别名精确匹配，未命中再查别名，仍未命中才404。别名只在`client.routeIds`允许的路由内解析，目标越界在创建客户端时即400，因此不构成新的越权面。`pgw wrap`用它实现任意别名与透明模式：注入的名字或 agent 自报的名字都能回到同一条路由。同协议直通时响应体仍是上游原始字节（`model`为上游名，既有行为）；跨协议转换时`model`回显客户端请求的名字。已知代价：`boundOutput`按`Math.min(agent请求的max_tokens, route.outputLimit)`截断，别名/透明模式下 agent 可能按更大的预算发请求而被静默压到该路由的`outputLimit`；预算预留按`route.contextLimit`，真实窗口更大时表现为事后超预算。
- 托管Codex/Claude运行可选择MCP范围；原生沙箱不等于外部MCP的副作用边界，外部调用仍由独立工具授权与审批治理。
- 会话采集源默认关闭，授权后由后台调度每30秒核对。元数据、正文索引与学习分别授权；来源可暂停、撤销正文、删除及重置遗忘记录。
- 增量解析使用字节游标；追加前校验已读前缀的完整hash，代价是变化文件需重新读取旧前缀，但只解析新增事件。文件改写清理旧索引和失效证据，重命名保持会话身份。
- 单行超过4MiB会记为解析异常，单事件文本超过256KiB明确标记截断；目录扫描达到10000文件/20000目录上限明确显示覆盖限制。分页查询与流式导出不再限制会话前1MiB。
- 当前自动候选提取为本地明确措辞规则，所有结果仍需用户确认；confidence是未校准的内部规则分值，不显示为可靠概率。外部模型归纳尚未接入。
- 上游凭据使用 AES-256-GCM，主密钥位于本地受限权限文件；系统 Keychain 集成尚未完成。
- 已有本地验证不能证明所有真实服务商、Agent 版本、权限和持续运行场景均已兼容。

## 继续工作入口

检查 `src/server/store.ts` 的当前数据库版本，再扩充对应业务实体与迁移；数据库版本已升级至26。原生运行、预算、会话增量和习惯证据链路已具备本地证据；继续完善协议治理、接入配置、工作连续性、运行值守、多设备与完整交付矩阵中仍缺失的能力。现有用户数据默认目录为 `~/.personal-gateway`，手工验证数据与上游均位于 `/tmp/pgw-verification` 和本机临时端口。

## 本轮回归证据

- 实际 Codex App Server：initialize、thread/start、turn/start、thread/resume、两轮同thread、网关费用归属与用户确认完成。
- 实际 Pi RPC：使用显式环境变量插值配置密钥、稳定session ID、两轮同session、agent_settled完成边界与费用归属。
- 实际 Claude CLI：隔离CLAUDE_CONFIG_DIR、Messages SSE、明确参数边界、两轮同session与目标确认。
- 结构化本地进程夹具：两轮成果条件满足、无进展停止、批准继续、拒绝阻塞、steering、暂停恢复、取消与调用密钥撤销、最大轮次停止。
- 独立SQLite预算事务：并发请求争用同一预算，HTTP 402发生于上游调用之前；独立并发上限返回429；实际费用释放预留、Token上限拒绝。
- 运行归属：同一数据库第二服务实例启动被拒绝，原运行状态保持不变。
- 数据库迁移：默认数据由版本2升级至3，升级前已创建独立SQLite快照。
- 浏览器：原生审批收件箱批准、用户确认完成、运行控制UI，移动端无横向溢出；未发生浏览器运行错误。

## 会话与个人记忆回归证据

- 三种原生格式合成记录均可索引；用户消息、工具结果、压缩和未知事件来源分开。
- Unicode/CRLF字节游标、重复扫描无重复事件、半行写入完成后才入库、文件内部改写重建事件定位、同inode重命名保持会话ID。
- 超过1MiB的1202条事件完整读取与导出，中文词语按原文件子串搜索（旧版 FTS 已停用）；符号链接不进入递归采集。
- 用户措辞只产生candidate，工具结果中的相同措辞不会生成偏好；用户确认、反例、历史恢复和手选证据具有独立记录。
- 遗忘会话后再次扫描不重新导入；丢弃自动候选后新消息中的同一候选不自动复活；关闭正文采集或移除来源删除索引与相关派生偏好。
- 浏览器完整操作：添加目录、分项授权、全文搜索、事件轨迹、确认偏好、查看证据、恢复历史和习惯时间线。移动端无横向溢出，未发生pageerror。
- 本轮使用`/tmp/pgw-sessions-verify`的合成数据，不读取用户真实会话正文，不调用外部模型。默认目录升级前另存SQLite快照。

## MCP中继回归证据

- 官方SDK v2客户端对接网关与本地外部MCP服务器：仅暴露授权命名空间，模型专用密钥访问MCP返回403。
- Tool/Resource/Prompt均可通过聚合入口访问；资源URI由网关命名空间映射，目录分页/重名/大小检查和输入schema校验已接入。
- 需要审批时远端调用次数保持0；批准后恰好调用一次，拒绝后不执行。撤销密钥范围取消待审批调用，运行中取消持久记录结果未知。
- 远端工具schema变更时执行被阻止；重新探测保留目录快照，旧hash授权不再出现在目录中。
- 直接控制台执行同样验证输入schema；加密参数和结果不出现在调用列表。
- Chromium完成MCP连接创建、工具授权、SDK发起调用、运行页审批、结果查看与调用历史；390px无横向溢出且无pageerror。
- 实际Codex CLI `mcp list --json`确认动态配置与环境变量凭据引用。Claude实际会话通过临时MCP配置连接成功，传给本地模拟模型的工具包含获授权命名空间。
- 实际托管Codex与Claude运行均加载授权工具并完成，结束后撤销运行密钥。未调用外部模型，远端MCP与模型均使用本地隔离夹具。

## 后台调度、调试台与 i18n 回归证据

- 扫描接口返回202和任务ID，前端/CLI轮询任务状态；大文件会话索引在后台worker完成，网关status请求保持低延迟。
- 后台任务显示phase、processed、total、currentItem、attempts、heartbeat、取消和失败状态；可幂等扫描任务在重启后重新排队，模型/MCP调试任务结果未知时保留uncertain。
- 调试台支持四种入口协议、逻辑模型、JSON请求、流事件/响应/历史尝试和取消；无限重试用于明确可安全重试的失败，退避期间释放执行worker供其他任务使用，输出过流内容的失败不会静默重放。调试任务级预算UI尚需补全，普通客户端和运行任务预算已存在。
- 默认端点使用`/providers/openai/v1`、`/providers/anthropic`、`/providers/google`；旧入口保留兼容转发。
- 目标池支持优先级、加权轮询、最少在途、目标并发和会话固定；路由决策写入每次请求。
- 双语层仅提供`zh-CN`/`en-US`，key采用命名空间格式，浏览器选择持久化并跨标签页同步；现有界面静态中文文案已全部迁移，模型/项目/用户数据不翻译。

## i18n完整迁移验证

- 词典拆分为`src/web/locales/zh-CN.ts`和`en-US.ts`；英文词典以中文key集合约束，缺少key会在类型检查时报错。
- 现有所有页面、表单、状态、审批、错误、提示和无障碍标签的静态中文文案迁移到命名key，动态参数单独传入，技术协议与用户数据不翻译。
- 移除未使用key，保留实际使用的短标签/必要警告；仓库提供`bun run i18n:check`检查key格式、语言一致性、占位符和未使用项。
- `Intl`统一数字、金额、时间和相对时间；语言读取顺序为本地选择、浏览器支持语言、简体中文兜底，写入受限时仍可正常切换。
- Chromium检查全部主页面英文状态无静态中文泄漏；确认中文/英文切换、刷新保留、同源标签页同步、对话框内容即时翻译且表单输入保留。
- 登录页和全局工具栏可切换语言，设置页可直接选择；390px布局无横向溢出，未发生pageerror。

## 路由、流式转换与调试回归

- 四种入口与四种上游组合覆盖JSON/SSE共32条文本和函数工具调用链路；SSE验证BOM、CRLF、UTF-8跨块、完整事件生命周期和usage。
- 加权1:2轮询、最少在途加目标原子并发、同会话互斥、作用域内响应检索、会话固定及偏好快照通过验证；删除偏好使绑定快照失效。
- 429明确拒绝可回退且记录两个Attempt；503结果未知不重放本次请求，后续请求可跳过已熔断目标。
- Anthropic缓存读取、普通/长TTL写入分别记录，计价快照按整数微美元核算且不重复计数。
- 无限重试两次429后恢复；等待期间其他调试任务可执行；取消不再产生新尝试；HTTP200中的流式错误显示失败且不自动重放。
- 调试历史逐次加密保存响应与关联请求ID，成功任务经明确确认可以重放为新任务。
- 浏览器完成调试运行、历史尝试查看、路由决策、计价快照和会话绑定状态查看。
- 当前转换覆盖文本和普通函数工具，图片/音频、结构化输出、不透明推理/签名和跨协议previous_response_id仍明确拒绝或需进一步适配，不宣称全能力等价转换。Responses 的 `namespace` 工具分组按扁平函数无损展开（内部工具名本就扁平，展开不改变模型可见的名字）。
- 另有**两个默认关闭**的降级开关，开启后互转让路而非拒绝：`discardReasoning` 丢弃 thinking/reasoning 内容（含签名），`ignoreHostedTools` 忽略托管工具声明（`web_search` 等非 `function` 类型）。两者默认关闭时错误码与状态码与未引入开关前逐字相同，且互相独立。每次实际丢弃写入该次请求的路由决策（`discard_reasoning` / `discard_hosted`），在请求查看里可见——内容确实丢失，但丢失这件事不静默。
- 已知代价：丢弃推理签名后，`messages→gemini` 的多轮工具调用可能因缺少 `thoughtSignature` 回填而被上游拒绝，该开关不适合这一场景；被忽略的托管工具会使客户端失去对应能力；上游已计费的 `reasoning_tokens` 仍计入用量。

## Skill资产与安装恢复回归

- 增加原生/共享/插件建议目录和自定义项目来源；扫描/搜索/读取/快照/预览/安装/恢复均经后台worker执行。
- 使用Bun原生YAML解析frontmatter，记录描述、版本来源、声明工具、内容身份、相同说明与同名不同内容。扫描不执行Skill脚本。
- 快照包括支持文件、隐藏文件、空目录、普通文件执行位与POSIX模式；本地加密保存，默认来源不自动保存完整快照。
- 安装先生成不可变计划及diff，明确确认后才写入；目标必须为空或已有SKILL.md，防止把普通项目目录当Skill覆盖。
- 每次写入前重新比较目标hash，后续用户改动会阻止操作；安装保留原始快照，恢复可还原隐藏文件、空目录和基本权限，首次安装可撤销整个受管包。
- 源包链接和多硬链接要求额外审查，包当前限制500文件/1000目录、单文件4MiB/总8MiB；ACL、扩展属性和跨设备包格式兼容仍需补全，不视为完整系统备份。
- 文件系统操作使用同文件系统staging、受限目录、写入日志和回滚；服务中断时保留uncertain状态及staging位置，不盲目重放。
- 隔离夹具验证版本解析、重复识别、支持文件、隐藏.env保护、可执行位和目录权限恢复、预览后编辑拒绝、首次安装撤销和链接越界拒绝。
- 浏览器验证Skill详情、保存快照、安装预览、明确确认、安装记录与恢复；中英文正常、390px无横向溢出、无pageerror。
- 所有文件写入验证限定于`/tmp/pgw-assets-verify`；测试实例使用`PGW_NATIVE_DISCOVERY=0`，未读取个人Skill包或改写真实Agent目录。
- 开发启动保留前端HMR，后端使用显式重启，避免有状态后台资源随模块热替换留下旧实例。

### 文件系统优先的会话存储（2026-09-20）

- 诊断默认库约 5.83 GiB：FTS 数据约 2.75 GiB、FTS 正文副本约 1.21 GiB、事件表约 1.55 GiB，主要是重复保存已有原生会话内容。
- 新增事件正文不入库，数据库保留轻量偏移与分支关系；时间线、导出与偏好证据按字节区间读取原文件，校验路径边界、身份、前缀、事件身份和授权。
- 全文搜索改成独立 Worker 扫描原文件，复用任务进度、取消和失败机制；内容查询不再定时重复扫描，缺失文件计入覆盖提示。时间线查询以后台任务分页定位，结果只保存无正文的定位数据。
- `pgw storage status` 展示主库、WAL 和空闲页；`pgw storage compact` 取得运行归属锁后离线去重与压缩，源文件不可用时保留原正文，在线执行拒绝。旧默认库尚未离线压缩，停用的历史 FTS 仍占空间，需执行该命令才能回收。

### 普通模型请求可观测性（2026-09-21）

- 流量记录继续保存请求组、路由决策、每次上游尝试、响应状态、延迟、Token、费用和错误；新增正文轨迹，默认开启，设置页可关闭；设置变更只影响之后的新请求。
- 每次普通模型请求可查看 request、effective、upstream、response、output 五个阶段；响应流按块记录，转换协议同时保留上游流和网关输出流；错误响应也保留受限正文。
- 记录由独立 Worker 异步写入加密 SQLite，主代理不等待正文落库；按阶段上限、总容量和保留天数限制，队列拥塞标记 partial，不影响模型调用。
- 请求 Header、Cookie、API Key、URI 参数和正文按原样进入本地加密记录；脱敏与脱敏映射不在采集链路中，作为独立查看/导出能力。管理端可分页读取、删除单条或清空全部记录。
- 旧流量无法回补正文，显示 `not_captured`；元数据、路由和调试尝试仍可查看。正文采集和会话原文采集是两套独立授权。

- 输出阶段同时记录协议转换后的普通 JSON/SSE 输出；同协议透传不再只有 response 阶段。详情页支持原文/结构化切换，结构化展示 system/instructions、messages/input/contents、tools/tool configuration。
- 具有关联 route session 的请求会返回同 session 历史，可在详情页打开 effective 请求 Diff；正文按分片分页读取，单阶段上限默认提升到 16 MiB，加载更多不会一次性把大请求塞入前端。
- 流量详情的正文查看改为 IntersectionObserver 懒加载，滚动到尾部自动读取下一分片，取消手动加载按钮；结构化视图可解析 JSON 和 SSE，统一展示 system/instructions、messages/input/contents、tools、output/events，原文仍可切换查看。

### Agent 观测台与快照（2026-09-21）

- 新增统一 Agent 观测台：扫描到的 session、模型调用、托管 run、route session、MCP 工具调用、后台 job 和扫描进度进入同一时间线；支持类型筛选、关键词搜索、状态与详情展开。
- 展示按轨迹设计：事件图标、状态、相对时间、关联 session/run/request ID 和结构化 detail，避免只显示孤立的模型流量表。
- 新增状态快照：保存 session、traffic、run、run event、route session、MCP call、job、collection source 的轻量状态和哈希；快照正文加密保存，快照列表只显示摘要。
- 快照 Diff 对扁平化状态路径比较 add/remove/change，支持查看两个时间点的状态变化；创建和比较按需执行，不影响实时代理链路。
- 视觉参考吸收 DeepSeek Harness 的 trajectory/timeline、事件分组、请求状态和快照思路；未复制其组件或依赖。

## Agent Trajectory 重构执行记录（2026-09-21，进行中）

以 `agent-trajectory.md` 的 T01–T15 为验收依据。旧版观测台的平面列表、全库快照与数组位置 Diff 仍是待替换实现，不能视作完整 Agent Trajectory 已交付。

本次已落实：

- 新增独立的轨迹 block/coverage/window/change 契约，保留原始请求字节，避免模型参数补全污染 request 阶段；同协议 JSON output 保存实际返回文本。
- 请求 Inspector 通过现有 Trace Worker 按需解析完整采集体，HTTP 只返回 25 条结构化 block 预览；字段展开按 16 KiB 字符窗口读取，不再尝试 JSON.parse 第一段 64 KiB 残片。
- JSON 投影包含 system/instructions、message/input/contents、工具 schema/调用/结果、参数、传输信息；SSE 投影处理四协议的 delta、tool arguments 和 Responses 最终快照对齐。未识别事件保留 other，截断/无法解析显式警告。
- effective Diff 在 Worker 中进行，工具稳定 ID/name 对齐，消息共同前后缀对齐，展示 before/after；比较覆盖不完整时不伪装为“无变化”。分页返回 total/next，并标记预览截短。
- 结构化 Inspector、原文与 Diff 按滚动加载；字段状态按 request/stage 隔离；收起大字段不创建全量 DOM。取消页面请求通过 AbortController 撤销前端读取。
- 不再将任意缺失 output 自动替换成 response；只有采集记录明确声明同源时才允许引用，避免把协议转换前的响应伪装成实际输出。
- 修正历史迁移 14/15 的顺序，避免先写版本 15 导致已有版本 13 的 clients.kind 迁移被跳过。

本次证据：类型与双语 key 检查通过；纯投影检查涵盖工具前插、消息前插、SSE final/delta 不重复、工具 JSON 参数拼接与破损 JSON；独立临时数据目录的本地上游验证通过请求不变异、75 条长消息分页、工具字段过滤、删除后不可读取；浏览器验证 offset=25/50 自动加载、字段过滤、阶段切换、原文切换与 390px 布局，无 pageerror/HTTP 错误。仓库复用 doctor 留有投影诊断断言，未新增测试套件。

尚需实现/验证：三类 Session 的持久身份与分页目录、Turn/Step 真实分组、扫描/托管/模型因果关系、工具与审批树、按步骤上下文快照及文件系统存储、关联依据 Inspector、时间分段与托管控制面、投影缓存失效/后端取消、大历史虚拟窗口，以及 T01–T15 的整体验收。未宣称完整目标完成。

### 会话级 Trajectory 接入（进行中）

- 观测台已切换到三栏会话工作台：左栏使用独立目录 API 按时间与 key 分页，区分 scanned/managed/independent；中栏按所选会话拉取节点并显示轮次、步骤；右栏复用按需 Inspector。旧全局最近 500 条平面列表不再驱动会话工作台。
- 迁移 16 新增 `trajectory_call_context` 轻量关联表，记录每次调用时的 client/run 作用域、native session/turn、网关 step、托管 turn number 和来源依据；正文仍在已有采集记录或原文件中。旧数据保留 legacy_traffic 标签，不伪造缺失的原生身份。
- 原生 Session Header 只用于观测关联；路由锁与固定目标仅使用显式 x-pgw-session 或 Responses 链，避免因观测把 Claude/Codex 同会话请求额外串行化。
- 扫描节点用原始 offset/timestamp 和原生 task_started turn ID；没有原生 turn 的用户消息分轮标记 derived，无法归属的模型调用标记 unknown。步骤保留原生 ID/requestGroupId，重试仍属于同一逻辑调用。
- 工具结果通过同会话/同 generation 中唯一匹配的 call ID 关联到工具调用节点；多个匹配不猜测。跨来源相同 agent/nativeId/project 作为 candidate link 展示，保留作用域，不自动合并。
- 托管轮次、原生运行事件、审批和模型请求进入同一会话轨迹，原有 RunDetails 控制面从观测台打开；扫描会话原有来源界面也可直接打开。
- 新增独立 projection Worker，浏览/解析与采集写入 Worker 分离。浏览 API 绑定 AbortSignal，取消排队任务和分片读取；catalog/节点/完整原始记录只在投影 Worker 查询读取，不在主线程构建。
- 扫描记录详情通过原文件精确字节区间读取，校验 source 授权、文件身份、generation 和事件 hash，展示真实原文不调用既有摘要脱敏结果。

本轮证据：独立临时目录接口验证三类目录/keyset 分页、同 Header 不同 client 不串 Session、同会话调用分页、跨会话节点读取拒绝、Claude derived 轮次、Codex 原生 turn 传播、call ID 工具结果关联、managed 轮次、原文未改写和撤销授权 403；浏览器验证三栏切换、单会话内容、Inspector 输出、托管控制面及 390px 宽度无溢出，无 pageerror/404。本地上游四协议 32 条 JSON/SSE 转换路径复核通过。doctor 增加目录身份/分页契约断言。

仍未完成整体验收：步骤级不可变 Context Snapshot 的独立存储/删除/期限及任意快照比较、完整跨源身份确认/合并工作流、MCP/native 子工具因果树、更多原生版本/分支重建、模型首 token 时间与细分耗时、全部长历史虚拟化和失效重载策略。T01–T15 保持逐项审查，不以此次回归代替完整目标完成。

### 步骤级 Context Snapshot（2026-09-21）

- 新增迁移17与 `trajectory_snapshots` 轻量索引：SQLite 只保存快照身份、会话 key、节点来源、hash、大小、coverage、状态、期限和 stage manifest；实际快照压缩后 AES-GCM 加密保存于 `~/.personal-gateway/trajectory-snapshots/<id>.enc`，目录/file 0600/0700，原始凭据不落 SQLite。
- 快照只能从已结束且可验证的 traffic、扫描 session event、托管 runtime event 或 approval 节点创建；请求仍 recording、source revision 改变、文件校验失败、跨 session 比较、超限、取消都会失败并删除临时文件。Snapshot 创建使用 `trajectory.snapshot` 后台 lane，失败/取消不留下可读 ready 快照。
- 快照载荷绑定 `sessionKey + nodeKind + nodeId`，包含 Session/Node metadata、实际 request stages 或精确文件记录；每个 stage 有 coverage、hash、bytes、reason。过期、删除、源 capture 删除后，快照仍可按独立期限读取，显式删除则同时删除加密文件。
- 读取使用安全句柄、nlink/mode/size/hash/期限校验和最多8项/64MiB进程内 LRU；读取快照不重新依赖源正文，因此不会让源采集删除重新出现。后台每30分钟清理过期/失败/残留写入快照，重新启动恢复任务状态。
- Snapshot Inspector 支持结构化/原文/manifest；Diff 使用同一 session scope、stage coverage、semantic block 对齐，展示 before/after，新增工具和前插消息不制造全量位置差异；超长差异先预览，展开后按字符窗口读取。UI 可以从任意 Trajectory node 保存、选 A/B、比较、导出和删除。
- 运行与观察端仍不做脱敏；快照与请求采集保持事实内容，本地加密与管理员鉴权是存储边界。页面自动分片读取，不在初始渲染加载整个快照。

本轮证据：临时服务验证重复 prompt 压缩、密文不含正文/凭据、SQLite 不含 contentCipher、A/B 快照语义 Diff、完整 long-change 分页、删除/过期/源 capture 删除后的独立读取、文件篡改校验、导出鉴权；浏览器验证保存快照、A/B 比较、展开 Diff 和移动端布局。类型、构建、i18n 已通过。

### 快照工作台验收补充（2026-09-21）

- 会话节点菜单已提供 Context Snapshot：只读当前 node 的实际来源，保存动作进入后台 job，写入加密压缩文件并提交 manifest ready；保存期间、取消、修改、源缺口均不产生可读 ready 快照。
- 快照列表显示来源节点、hash、大小、coverage、独立到期时间；可选 A/B 快照，按 shared session scope 和指定 stage 比较。差异先加载摘要，完整 before/after 只有展开时分片读取。
- 删除动作同时清理文件、manifest 和 projection cache；源请求 capture 删除不影响已经 ready 的独立快照；过期由后台 cleanup lane 回收。
- Browser evidence now covers explicit label, snapshot list, A/B diff, full diff expansion, deletion and 390px layout; temporary-source evidence covers compression, ciphertext boundary, tamper check, independent retention and export auth.

### MCP/运行节点与性能轨迹补充（2026-09-21）

- MCP call 增加 sessionKey、native session/turn、run、parent model-call、evidence；独立模型调用、托管运行和 MCP tool call 可出现在同一 session 节点序列，无法确定 parent 时保留无关联，而不是猜测。
- Model Call 记录首字节、首 Token、生成/decoding 区间；没有真实首 Token 事件时保持 null，不把首字节伪装成首 Token。轨迹节点 Inspector 显示实际采样状态。
- MCP 通过 `x-pgw-attempt-id` 关联模型调用，原生 Agent 通过 session/turn Header 关联；管理端、console 调用不填充虚假 Agent 身份。

### 自适应上下文、透明重试、协议开关与统计过滤（2026-09-21）

- 增加 `adaptiveContext` 策略：按 provider/model/protocol 学习成功输入下界和 context error 上界；可设置 `maxTokens`、压缩开关、压缩比例（默认 80%）和 awareness prompt。超限时只从可移除的历史消息开始压缩，保留 system/最近消息/工具链；有效请求阶段显示压缩前后的事实。
- 增加协议转换开关，默认开启；关闭时跨 OpenAI Responses/Chat、Anthropic Messages、Gemini 的路由请求返回明确 `protocol_conversion_disabled`，不会悄悄改变协议。
- 增加透明重试策略：仅对尚未向客户端输出内容的明确上游状态重试；默认关闭、最多3次、退避、状态白名单可配。每次实际尝试仍独立记录 Traffic，决策中保留 retry 次数；未知结果和已经输出内容不自动重放。
- Dashboard 增加 model/tool calls、输入/输出/reasoning/cache Token、平均首 Token、平均生成、P95 latency、retry 次数；Trajectory Session 目录支持模型调用数和事件数滑块筛选。
- `Traffic` 增加 firstTokenMs/decodingMs；首 Token 只从真实可见 delta/工具 delta 采样，缺失保持 null。
- MCP call 增加 session/native turn/run/parent model-call/evidence 字段，并进入独立/托管 Trajectory；迁移20修复了早期迁移19抢先写版本导致的字段缺失。
