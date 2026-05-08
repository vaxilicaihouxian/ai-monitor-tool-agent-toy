# OMC (Observable CLI) — 项目指南

## 项目概述

OMC 是一个终端可观测性 CLI 工具，支持日志检索、分布式链路追踪（Trace）分析、报警事件智能分析和 Agent 深度调查。通过 REPL 交互模式或 CLI 子命令使用，命令名为 `omc`。

## 技术栈

- **语言**: TypeScript (ESM, target ES2022)
- **CLI 框架**: [Ink](https://github.com/vadimdemedes/ink) — React for CLI（JSX 渲染终端 UI）
- **Agent 框架**: [pi-agent](https://github.com/mariozechner/pi-agent)（`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`）— Agent 运行 + 工具调用 + 对话循环
- **Schema**: [@sinclair/typebox](https://github.com/sinclairzx81/typebox) — Agent 工具参数 JSON Schema 定义
- **样式**: chalk — 终端 ANSI 颜色
- **Markdown**: marked — 终端 Markdown 渲染
- **日志**: pino — 结构化日志（`OMC_DEBUG=1` 时启用）
- **数据源**: ClickHouse / Elasticsearch / Prometheus
- **LLM**: OpenAI 兼容 API（参数提取 + 智能分析 + Agent 对话）
- **构建**: tsc，开发用 tsx 直接运行
- **测试**: Node.js 内置 test runner（`node --test`）

## 目录结构

```
src/
├── index.tsx                 # 入口：解析 CLI 参数，路由到 REPL 或非交互子命令
├── config.ts                 # 配置加载（~/.omc.json + 环境变量覆盖）
├── commands.ts               # REPL 命令解析（/log, /trace, /alarm-drill 等）
├── commands-capability.ts    # 命令能力声明（用于默认 Agent 路由）
├── query.ts                  # 日志查询逻辑 + LogEntry 类型
├── traceAnalyzer.ts          # Trace 链路分析（树形/时间线/简单视图）
├── alarmAnalyzer.ts          # 报警智能分析（appname→analyzer 路由 + LLM/统计降级）
├── agentRunner.ts            # Agent 运行器（pi-agent 封装，分析+对话循环）
├── agentTools.ts             # Agent 工具定义（query_logs/trace/metrics/alarm_drill/alarm_analyze/memory_save）
├── llmClient.ts              # LLM 客户端（OpenAI 兼容 API 调用 + 参数提取）
├── esClient.ts               # Elasticsearch 客户端
├── promClient.ts             # Prometheus 客户端（指标查询 + 格式化）
├── memory.ts                 # 长期记忆管理（~/.omc/memory/memory.md，偏好/报警案例）
├── memory.test.ts            # memory 模块测试
├── exporter.ts               # 查询结果导出为 JSON
├── promptLoader.ts           # Prompt 文件加载（优先用户自定义 > 内置）
├── version.ts                # 版本号
├── types.ts                  # 跨模块共享类型
│
├── ui/                       # Ink React 页面组件
│   ├── App.tsx               # 主 App（路由不同命令视图）
│   ├── Shell.tsx             # REPL 交互 Shell（命令输入 + 视图切换）
│   └── TraceApp.tsx          # Trace 视图
│
├── components/               # Ink React UI 组件
│   ├── index.ts              # 统一导出
│   ├── Welcome.tsx           # 启动欢迎页
│   ├── CommandInput.tsx      # 命令输入框
│   ├── LogList.tsx / LogItem.tsx    # 日志列表/单条
│   ├── TraceView.tsx         # Trace 可视化（树形/时间线/简单）
│   ├── AlarmDrillView.tsx    # 报警下钻视图
│   ├── AlarmAnalyzeView.tsx  # 报警智能分析视图
│   ├── Markdown.tsx          # 终端 Markdown 渲染
│   ├── JsonBlock.tsx         # JSON 块渲染
│   ├── Ansi.tsx              # ANSI 颜色渲染
│   ├── StepsProgress.tsx     # 步骤进度条
│   ├── Spinner.tsx / Status.tsx     # 加载/状态指示
│   ├── Header.tsx / Footer.tsx      # 页头/页脚
│   └── Divider.tsx           # 分隔线
│
├── cli/                      # 非交互式 CLI 子命令入口
│   ├── alarmDrill.ts         # omc alarm-drill
│   ├── alarmAnalyzeEventOnline.ts      # omc alarm-analyze-event-online
│   ├── alarmAnalyzeFile.ts             # omc alarm-analyze-file
│   ├── alarmAnalyzeEventOnlineAgent.ts # omc alarm-analyze-event-online-agent
│   └── alarmAnalyzeFileAgent.ts        # omc alarm-analyze-file-agent
│
├── datasources/              # 数据源抽象层
│   ├── types.ts              # DataSource 接口 + DataSourceKind（log/trace/metrics/alarm-event）
│   ├── log.ts                # 日志数据源类型定义（LogQueryParams/LogQueryResult）
│   ├── trace.ts              # 链路数据源类型定义
│   ├── metrics.ts            # 指标数据源类型定义
│   ├── alarm-event.ts        # 报警事件数据源类型定义
│   ├── helpers.ts            # 数据源辅助函数（buildExtraTerms 等）
│   └── impl/                 # 数据源实现
│       ├── log-elasticsearch.ts       # ES 日志
│       ├── trace-elasticsearch.ts     # ES Trace
│       ├── metrics-prometheus.ts      # Prometheus 指标
│       ├── fake-log.ts / fake-trace.ts / fake-metrics.ts / fake-alarm-event.ts  # Fake 数据源（开发/测试）
│
├── plugins/                  # 插件系统
│   ├── types.ts              # Plugin 接口定义
│   ├── plugin-manager.ts     # PluginManager（注册/发现/偏好/可用性查询）
│   ├── index.ts              # createPluginManager 工厂函数
│   └── builtin/              # 内置插件（每个插件包装一个 DataSource 实现）
│       ├── log-elasticsearch-plugin.ts
│       ├── trace-elasticsearch-plugin.ts
│       ├── metrics-prometheus-plugin.ts
│       ├── fake-log-plugin.ts / fake-trace-plugin.ts / fake-metrics-plugin.ts / fake-alarm-event-plugin.ts
│
├── prompts/                  # LLM Prompt 文件（Markdown，支持模板变量 {{var}}）
│   ├── extract-params.md     # 从报警事件提取查询条件
│   ├── summary-system.md / summary-user.md / summary-refine.md           # 日志/链路增量摘要
│   ├── metrics-summary-system.md / metrics-summary-user.md / metrics-summary-refine.md  # 指标增量摘要
│   ├── sre-deep.md           # SRE 深度分析 prompt
│   ├── agent-sre-deep.md     # Agent 深度分析 system prompt
│   └── default-agent.md      # 默认 Agent system prompt
│
├── auth/                     # 认证
│   └── types.ts              # 认证类型定义
│
├── utils/                    # 工具函数
│   ├── logger.ts             # pino 日志封装
│   ├── markdown.ts           # Markdown 处理
│   └── formatters.ts         # 格式化工具
│
└── static/
    └── welcome_ascii.ts      # ASCII 欢迎图
```

## 主要功能

### 1. 日志查询 (`/log`)
- 支持按 appname/level/关键词/traceId/时间范围过滤
- 数据源：ClickHouse 或 Elasticsearch（通过 `logSource` 配置切换）

### 2. 分布式链路追踪 (`/trace`)
- 三种视图：tree（调用树）、timeline（瀑布时间线）、simple（列表）
- 自动关联查询日志
- 数据源：Elasticsearch（Jaeger span 索引）

### 3. 报警事件下钻 (`/alarm-drill`)
- 从报警事件出发 → LLM 提取查询条件 → 查日志 → 提取 traceId → 查链路
- 组合展示日志+链路

### 4. 报警智能分析 (`/alarm-analyze-event-online` / `/alarm-analyze-file`)
- 在线采集或文件读取数据 → 按 analysis.mappings 路由到分析器 → LLM 分析或统计降级
- 支持字段筛选（fieldFilter）和数据摘要（summary）

### 5. Agent 深度分析 (`/alarm-analyze-*-agent`)
- Phase1: 智能分析 → Phase2: Agent 对话循环增量调查
- 提供 3 个工具：`query_logs` / `query_trace` / `query_metrics`
- 每轮对话最大工具调用 10 次

### 6. 默认 Agent（自然语言入口）
- REPL 中直接输入自然语言（无 `/` 前缀）路由到默认 Agent
- 提供 7 个工具：query_logs / query_trace / query_metrics / query_alarm_event / alarm_drill / alarm_analyze / memory_save
- 常驻会话，保持对话上下文

### 7. 结果导出 (`/export`)
- 将命令参数和查询结果导出为 JSON 文件

### 8. 长期记忆 (`/memory`)
- 两种类型：preference（用户偏好）、alarm_case（报警案例）
- 存储：`~/.omc/memory/memory.md`
- Agent 自动加载已有记忆注入 system prompt

## 架构要点

### 数据源抽象
- `DataSource` 接口统一查询入口，4 种能力类型（log/trace/metrics/alarm-event）
- `Plugin` 封装一个或多个 DataSource 实现，通过 `PluginManager` 管理
- 内置 7 个插件（3 真实 + 4 fake），支持动态加载第三方插件

### Prompt 管理
- 所有 LLM prompt 以 `.md` 文件存放于 `src/prompts/`
- 加载优先级：用户自定义 `~/.omc/prompts/<name>.md` > 项目内置
- 模板变量：`{{variable}}` 格式，运行时替换

### 配置
- 文件 `~/.omc.json`，环境变量覆盖，优先级：环境变量 > 配置文件 > 默认值
- 关键配置节：clickhouse / pluginsConfig / extractorModel / agentModel / defaultAgent / memory / analysis

## 开发命令

```bash
npm install            # 安装依赖
npm run dev -- [opts]  # 开发模式（tsx 直接运行 TS）
npm run build          # 构建（tsc + 复制 prompts）
npm start -- [opts]    # 生产模式运行
npm test               # 运行测试
```

## 编码约定

- ESM 模块（`"type": "module"`），import 路径带 `.js` 后缀
- React 组件使用函数式组件 + Ink hooks
- Agent 工具参数用 TypeBox 定义 Schema
- 日志用 `debug()` 函数（pino 封装），通过 `OMC_DEBUG=1` 开启
- 错误处理：工具执行失败返回 `isError: true`，不抛异常中断


# Coding Notice
Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.