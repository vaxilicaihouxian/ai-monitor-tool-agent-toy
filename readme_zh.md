# OMC — Observability Monitor CLI

终端可观测性工具，支持日志检索、分布式链路追踪（Trace）分析、报警事件智能分析和 Agent 深度调查，数据源支持 ClickHouse 和 Elasticsearch。

## 安装

```bash
npm install -g observable-cli
```

安装后即可使用 `omc` 命令

## 快速开始

```bash
# 启动 REPL 交互模式
omc

# 带参数启动（自动执行后进入 REPL）
omc --trace-id abc123
omc -a myapp -L ERROR
omc trace abc123 -v timeline

# 报警事件下钻（非交互式，输出结果后退出）
omc alarm-drill <eventId>

# 报警智能分析（非交互式）
omc alarm-analyze-event-online <eventId>
omc alarm-analyze-file <filePath>

# Agent 深度分析（含对话循环）
omc alarm-analyze-event-online-agent <eventId>
omc alarm-analyze-file-agent <filePath>

# 指标查询
omc query-metrics 'up{app="myapp"}' --start 1745800000 --end 1745803600
```

REPL 模式下的提示符为 `omc>`，输入 `/` 前缀的命令进行操作：

```bash
omc> /log                                # 查询全部日志
omc> /log -s "timeout" -L ERROR          # 搜索 + 级别过滤
omc> /log --trace-id abc123              # 按 traceId 查询
omc> /trace abc123                       # Trace 链路分析
omc> /trace abc123 -v timeline           # 时间线视图
omc> /alarm-drill <eventId>              # 报警事件下钻（日志+链路组合展示）
omc> /alarm-analyze-event-online <eventId>  # 报警智能分析（在线）
omc> /alarm-analyze-file <filePath>      # 报警智能分析（从文件）
omc> /alarm-analyze-event-online-agent <eventId>  # Agent 深度分析（在线）
omc> /alarm-analyze-file-agent <filePath>  # Agent 深度分析（文件）
omc> /query-metrics 'up{app="myapp"}'    # Prometheus 指标查询
omc> /memory show                         # 查看所有记忆
omc> /memory add preference "优先查ERROR日志" --content "排查时先过滤ERROR级别" --tags "排查习惯"
omc> /memory add alarm_case "myapp OOM报警" --content "根因是内存泄漏" --tags "OOM" --appname "myapp"
omc> /export                             # 导出上次查询结果到 /tmp/omc/
omc> /export ~/my-exports                # 导出到指定目录
omc> /help                               # 查看帮助
omc> /quit                               # 退出
```

## 命令详解

### REPL 命令

启动 `omc` 后进入 REPL 交互模式，支持以下命令：

| 命令 | 说明 |
|------|------|
| `/alarm-drill <eventId>` | 报警事件下钻（日志+链路组合展示） |
| `/alarm-analyze-event-online <eventId>` | 报警智能分析（在线数据采集+LLM分析） |
| `/alarm-analyze-file <filePath>` | 报警智能分析（从导出文件分析） |
| `/alarm-analyze-event-online-agent <eventId>` | Agent 深度分析（在线采集+Agent对话） |
| `/alarm-analyze-file-agent <filePath>` | Agent 深度分析（文件分析+Agent对话） |
| `/query-metrics <PromQL>` | Prometheus 指标查询 |
| `/memory add\|show\|clean\|backup` | 长期记忆管理（需配置 `memory.enabled`） |
| `/export [dir]` | 导出当前命令参数和结果到 JSON 文件 |
| `/log [options]` | 查询日志（也可用 `/logs`） |
| `/trace <traceId> [options]` | Trace 链路分析 |
| `/help` | 显示帮助信息 |
| `/quit` 或 `/exit` | 退出程序 |

#### 日志查询 `/log`

| 选项 | 简写 | 说明 | 默认值 |
|------|------|------|--------|
| `--limit <n>` | `-l` | 限制查询条数 | 200 |
| `--level <level>` | `-L` | 按日志级别过滤（ERROR/WARN/INFO 等） | - |
| `--search <text>` | `-s` | 搜索关键词 | - |
| `--trace-id <id>` | - | 按 traceId 查询 | - |
| `--appname <name>` | `-a` | 按应用名过滤 | - |
| `--start-time <time>` | - | 开始时间 | - |
| `--end-time <time>` | - | 结束时间 | - |
| `--query <sql>` | `-q` | 自定义 SQL 查询（ClickHouse 模式） | - |

#### Trace 分析 `/trace`

| 选项 | 简写 | 说明 | 默认值 |
|------|------|------|--------|
| `--view <type>` | `-v` | 视图类型：`tree` / `timeline` / `simple` | tree |
| `--limit <n>` | `-l` | 关联日志条数限制 | 200 |

三种视图：

- **tree** — 树形调用关系，展示服务间父子层级
- **timeline** — 瀑布式时间线，展示各 span 耗时分布
- **simple** — 简单列表，按时间排列所有 span

#### 指标查询 `/query-metrics`

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `<PromQL>` | Prometheus 查询表达式 | - |
| `--start <time>` | 开始时间（Unix 时间戳） | - |
| `--end <time>` | 结束时间（Unix 时间戳） | - |
| `--step <duration>` | 查询步长 | `30s` |
| `--lookback <duration>` | 回看窗口 | - |

```bash
# REPL 内查询
omc> /query-metrics 'up{app="myapp"}' --start 1745800000 --end 1745803600

# 命令行直接查询
omc query-metrics 'up{app="myapp"}'
```

> 需配置 `pluginsConfig.metrics-prometheus`（`remoteReadUrl` + `clusters` + `namespace`）。

#### 报警事件下钻 `/alarm-drill`

从报警事件出发，自动完成日志+链路的组合展示：

1. 从报警平台查询报警事件详情
2. 调用 LLM（OpenAI 兼容 API）自动提取查询条件：
   - 时间范围（startTime / endTime）
   - 应用名称（appname，必需，提取不到则中止并提示手动输入）
   - Pod 名称（可选）
   - API 路径（可选）
3. 自动查询日志，提取前 5 个不同 traceId
4. 并发查询 5 条链路，组合展示调用树 + 关联日志

```bash
# REPL 内使用
/alarm-drill <eventId>

# 命令行直接使用（非交互式，输出结果后退出）
omc alarm-drill <eventId>
```

#### 报警智能分析 `/alarm-analyze-event-online` / `/alarm-analyze-file`

从报警事件或导出文件出发，进行 LLM 深度智能分析：

- **在线分析** `/alarm-analyze-event-online <eventId>`：在线采集数据 → LLM 分析
- **文件分析** `/alarm-analyze-file <filePath>`：从导出的 JSON 文件分析

分析流程：
1. 采集数据（在线采集 / 文件从 JSON 读取）
2. 按 `analysis.mappings` 路由到对应分析器
3. LLM 分析（配置了 analyzer 时）或统计分析（未配置时降级）
4. 支持字段筛选（`fieldFilter`）和数据摘要（`summary`）

```bash
# 在线分析
omc> /alarm-analyze-event-online <eventId>

# 文件分析
omc> /alarm-analyze-file /tmp/omc/omc-xxx.json

# 命令行直接使用
omc alarm-analyze-event-online <eventId>
omc alarm-analyze-file <filePath>
```

#### Agent 深度分析 `/alarm-analyze-event-online-agent` / `/alarm-analyze-file-agent`

在智能分析结果基础上，启动 Agent 对话循环进行增量调查：

- **在线 Agent** `/alarm-analyze-event-online-agent <eventId>`：Phase1 在线采集+LLM分析 → Phase2 Agent 深度分析
- **文件 Agent** `/alarm-analyze-file-agent <filePath>`：Phase1 文件分析 → Phase2 Agent 深度分析

Agent 提供 3 个工具可自主调用：
- `query_logs` — 查询应用日志
- `query_trace` — 查询链路追踪
- `query_metrics` — 查询 Prometheus 指标

```bash
# 在线 Agent 深度分析
omc> /alarm-analyze-event-online-agent <eventId>

# 文件 Agent 深度分析
omc> /alarm-analyze-file-agent /tmp/omc/omc-xxx.json

# 跳过 Phase1，直接从文件加载初始 prompt
omc> /alarm-analyze-file-agent <filePath> --llm-input-file prompt.txt

# 命令行直接使用
omc alarm-analyze-event-online-agent <eventId>
omc alarm-analyze-file-agent <filePath>
```

Agent 分析完成后进入对话循环，输入问题继续调查，输入 `exit` 或 `quit` 退出。

> 需配置 `agentModel`（见配置章节）。

#### 默认 Agent（自然语言交互）

配置 `defaultAgent.enabled = true` 后，在 REPL 中直接输入自然语言（无 `/` 前缀），将路由到默认 Agent 处理，成为可观测性智能助手入口。

```bash
omc> 帮我查一下 myapp 最近的错误日志
omc> eventId abc123，帮我分析下这个报警
omc> traceId xyz789 的链路有什么问题
```

默认 Agent 提供 7 个工具（`memory.enabled = true` 时含 `memory_save`，否则 6 个）：`query_logs`、`query_trace`、`query_metrics`、`query_alarm_event`、`alarm_drill`、`alarm_analyze`、`memory_save`。

- Agent 在 REPL 启动时创建，常驻整个会话，保持对话上下文连续性
- 与专用 Agent 的关系：专用 Agent（`/alarm-analyze-*-agent`）活跃时优先处理输入，结束后自动恢复默认 Agent
- 启用 `memory.enabled` 时，Agent 自动加载已有记忆注入 system prompt
- 输入 `/` 前缀命令仍走原有路由，输入 `exit` / `quit` 退出 REPL

> 需配置 `defaultAgent`（见配置章节）。

#### 结果导出 `/export`

执行查询命令后，使用 `/export` 将命令参数和查询结果导出为 JSON 文件：

```bash
# 导出到默认目录 /tmp/omc/
omc> /log -a myapp -L ERROR
  ... (查看结果)
omc> /export
  已导出到: /tmp/omc/omc-1745800000000-a1b2c3d4.json

# 导出到指定目录
omc> /export ~/my-exports
  已导出到: ~/my-exports/omc-1745800000000-a1b2c3d4.json
```

导出文件格式：

```json
{
  "command": "/log -a myapp -L ERROR",
  "timestamp": "2026-04-28T12:00:00.000Z",
  "params": { "command": "/log -a myapp -L ERROR", "appname": "myapp", "level": "ERROR" },
  "results": { "queryInfo": "数据源: ES", "logSource": "es", "logs": [...] }
}
```

支持所有查询命令的导出（`/log`、`/trace`、`/alarm-drill`、`/alert`），在查看结果后按 `q` 返回 REPL 再执行 `/export` 即可。

#### 长期记忆 `/memory`

记录用户偏好和报警排查案例，供 Agent 跨会话参考。需配置 `memory.enabled = true`。

**两种记忆类型**：

| 类型 | 标识 | 用途 | 示例 |
|------|------|------|------|
| 用户偏好 | `preference` | 排查习惯、偏好设置 | "排查时优先看 ERROR 日志" |
| 报警案例 | `alarm_case` | 报警事件及排查结果 | "myapp OOM 报警，根因是内存泄漏" |

```bash
# 添加偏好
omc> /memory add preference "优先查ERROR日志" --content "排查时先过滤ERROR级别" --tags "排查习惯,日志"

# 添加报警案例
omc> /memory add alarm_case "myapp OOM" --content "根因是内存泄漏，重启恢复" --tags "OOM" --appname "myapp"

# 查看所有记忆
omc> /memory show

# 清空记忆（自动备份）
omc> /memory clean

# 手动备份
omc> /memory backup before-clean
```

**存储位置**：`~/.omc/memory/memory.md`（Markdown 格式）

**Agent 集成**：启用后默认 Agent 自动加载已有记忆，并可通过 `memory_save` 工具主动保存记忆。

### 命令行参数

也支持直接通过命令行参数启动，自动执行后进入 REPL：

```bash
# 日志查询模式
omc [options]
  -l, --limit <n>       限制条数 (默认 200)
  -L, --level <level>   按日志级别过滤
  -s, --search <text>   搜索关键词
  --trace-id <id>       按 traceId 查询
  -a, --appname <name>  按应用名过滤
  --start-time <time>   开始时间
  --end-time <time>     结束时间
  -q, --query <sql>     自定义 SQL 查询
  -c, --config <path>   指定配置文件

# Trace 分析模式
omc trace <traceId> [options]
  -v, --view <type>     视图类型: tree | timeline | simple
  -l, --limit <n>       关联日志条数限制

# 报警事件下钻（非交互式）
omc alarm-drill <eventId>

# 报警智能分析（非交互式）
omc alarm-analyze-event-online <eventId>    在线数据采集+LLM分析
omc alarm-analyze-file <filePath>           从文件分析

# Agent 深度分析（非交互式，含对话循环）
omc alarm-analyze-event-online-agent <eventId> [--llm-input-file <path>]
omc alarm-analyze-file-agent <filePath> [--llm-input-file <path>]

# Prometheus 指标查询
omc query-metrics <PromQL> [--start <time>] [--end <time>] [--step <duration>] [--lookback <duration>]
```

## 交互操作

### REPL 模式

启动后进入 `omc>` 交互提示符，支持：

| 按键 | 说明 |
|------|------|
| `↑` / `↓` | 切换历史命令 |
| `Enter` | 执行命令 |
| `Backspace` | 删除字符 |
| `Ctrl+C` | 退出程序 |

### 日志/Trace 视图

| 按键 | 说明 |
|------|------|
| `/` | 进入搜索模式 |
| `j` / `↓` | 下移 |
| `k` / `↑` | 上移 |
| `g` | 跳转首条 |
| `G` | 跳转末尾 |
| `Ctrl+e` | 逐行向下滚动 |
| `Ctrl+y` | 逐行向上滚动 |
| `q` / `Esc` | 返回 REPL |
| `v` | 切换 Trace 视图（tree → timeline → simple 循环） |

### 报警分析视图

| 按键 | 说明 |
|------|------|
| `j` / `↓` | 向下滚动 |
| `k` / `↑` | 向上滚动 |
| `Ctrl+e` | 逐行向下滚动 |
| `Ctrl+y` | 逐行向上滚动 |
| `g` | 跳转顶部 |
| `G` | 跳转底部 |
| `q` / `Esc` | 返回 REPL |

### 搜索模式

按 `/` 进入搜索模式后：

- 输入关键词实时过滤
- `Enter` 确认搜索，退出搜索模式
- `Esc` 取消搜索，恢复全部结果
- `Backspace` 删除最后一个字符

## 配置

配置文件位于 `~/.omc.json`，也可通过 `-c` 指定路径。环境变量可覆盖配置文件，优先级：**环境变量 > 配置文件 > 默认值**。

### 配置文件示例

```json
{
  "clickhouseUrl": "http://localhost:8123",
  "database": "default",
  "table": "logs",
  "username": "default",
  "password": "",
  "traceIdField": "traceid",
  "logSource": "es",
  "pluginsConfig": {
    "trace-elasticsearch": {
      "host": "http://<your-es-host>:9200",
      "indexPattern": "jaeger-span-*",
      "username": "<your-es-username>",
      "password": "<your-es-password>"
    },
    "log-elasticsearch": {
      "host": "http://<your-es-host>:9200",
      "indexPattern": "log-*",
      "traceIdField": "traceId",
      "timestampField": "@timestamp",
      "username": "<your-es-username>",
      "password": "<your-es-password>"
    },
    "metrics-prometheus": {
      "remoteReadUrl": "http://localhost:9090",
      "clusters": ["my-cluster"],
      "namespace": "my-namespace",
      "rateInterval": "2m",
      "step": "30s",
      "timeRangeMinutes": 30
    }
  },
  "extractorModel": {
    "baseUrl": "https://<your-llm-api>/v1",
    "token": "<your-api-key>",
    "model": "model-name"
  },
  "agentModel": {
    "baseUrl": "https://<your-llm-api>/v1",
    "token": "<your-api-key>",
    "model": "model-name",
    "api": "openai-completions",
    "maxTokens": 4096,
    "contextWindow": 128000
  },
  "defaultAgent": {
    "enabled": true,
    "maxToolCalls": 10,
    "baseUrl": "https://<your-llm-api>/v1",
    "token": "<your-api-key>",
    "model": "model-name",
    "api": "openai-completions",
    "maxTokens": 4096,
    "contextWindow": 128000
  },
  "memory": {
    "enabled": true,
    "maxEntriesPerType": 20,
    "maxCharsPerType": 10000
  },
  "analysis": {
    "models": {
      "default": {
        "baseUrl": "https://your-llm-api/v1",
        "token": "your-api-key",
        "model": "model-name"
      }
    },
    "analyzers": {
      "sre": {
        "model": "default",
        "prompt": "sre-deep"
      }
    },
    "mappings": [
      {
        "apps": ["myapp"],
        "analyzer": "sre",
        "context": "myapp-context"
      }
    ],
    "fieldFilter": {
      "logFields": ["timestamp", "level", "message", "traceId"],
      "spanFields": ["operationName", "serviceName", "durationMs"],
      "maxDataChars": 80000
    },
    "summary": {
      "enabled": true,
      "model": "default",
      "chunkSize": 20000,
      "targetSize": 4000
    }
  }
}
```

### 配置项说明

#### ClickHouse

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `clickhouseUrl` | ClickHouse 地址 | `http://localhost:8123` |
| `database` | 数据库名 | `default` |
| `table` | 表名 | `logs` |
| `username` | 用户名 | - |
| `password` | 密码 | - |
| `traceIdField` | traceId 字段名 | - |

#### Elasticsearch

| 字段 | 说明 |
|------|------|
| `pluginsConfig.trace-elasticsearch.host` | Trace ES 地址 |
| `pluginsConfig.trace-elasticsearch.indexPattern` | Trace ES 索引模式 |
| `pluginsConfig.log-elasticsearch.host` | 日志 ES 地址 |
| `pluginsConfig.log-elasticsearch.indexPattern` | 日志 ES 索引模式 |
| `pluginsConfig.log-elasticsearch.traceIdField` | 日志 ES 中 traceId 字段名 |
| `pluginsConfig.log-elasticsearch.timestampField` | 日志 ES 中时间戳字段名 |
| `pluginsConfig.log-elasticsearch.fieldMapping` | ES 字段映射（appname/level/podname/uri 等） |

#### 模式配置

| 字段 | 说明 | 可选值 | 默认值 |
|------|------|--------|--------|
| `logSource` | 日志模式数据源 | `clickhouse` / `es` | `clickhouse` |
| `trace.source` | Trace 模式关联日志数据源 | `clickhouse` / `es` / `none` | `clickhouse` |

#### Prometheus 指标查询

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `pluginsConfig.metrics-prometheus.remoteReadUrl` | Prometheus API 地址 | - |
| `pluginsConfig.metrics-prometheus.clusters` | 集群列表 | - |
| `pluginsConfig.metrics-prometheus.namespace` | 命名空间 | - |
| `pluginsConfig.metrics-prometheus.rateInterval` | rate 窗口 | `2m` |
| `pluginsConfig.metrics-prometheus.step` | 查询 step | `30s` |
| `pluginsConfig.metrics-prometheus.timeRangeMinutes` | 时间窗口（分钟） | `30` |

#### LLM 参数提取模型

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `extractorModel.baseUrl` | LLM API 地址（OpenAI 兼容） | - |
| `extractorModel.token` | API Key | - |
| `extractorModel.model` | 模型名称 | - |

#### Agent 模型

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `agentModel.baseUrl` | LLM API 地址（OpenAI 兼容） | - |
| `agentModel.token` | API Key | - |
| `agentModel.model` | 模型名称 | - |
| `agentModel.api` | API 类型 | `openai-completions` |
| `agentModel.maxTokens` | 最大 token 数 | `4096` |
| `agentModel.contextWindow` | 上下文窗口大小 | `128000` |

#### 默认 Agent

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `defaultAgent.enabled` | 是否启用默认 Agent | `false` |
| `defaultAgent.maxToolCalls` | 每轮对话最大工具调用次数 | `10` |
| `defaultAgent.baseUrl` | LLM API 地址（OpenAI 兼容） | - |
| `defaultAgent.token` | API Key | - |
| `defaultAgent.model` | 模型名称 | - |
| `defaultAgent.api` | API 类型 | `openai-completions` |
| `defaultAgent.maxTokens` | 最大 token 数 | `4096` |
| `defaultAgent.contextWindow` | 上下文窗口大小 | `128000` |

#### 长期记忆

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `memory.enabled` | 是否启用长期记忆 | `false` |
| `memory.maxEntriesPerType` | 每种类型最大条目数（超出自动裁剪最旧的） | `20` |
| `memory.maxCharsPerType` | 每种类型最大字符数（超出自动裁剪最旧的） | `10000` |

#### 报警智能分析

| 字段 | 说明 |
|------|------|
| `analysis.models` | 分析模型定义（key → {baseUrl, token, model}） |
| `analysis.analyzers` | 分析器定义（key → {model, prompt, temperature}） |
| `analysis.mappings` | appname → analyzer + context 路由映射 |
| `analysis.fieldFilter.logFields` | 日志保留字段列表（可选，不配置使用默认筛选） |
| `analysis.fieldFilter.spanFields` | Span 保留字段列表（可选，不配置使用默认筛选） |
| `analysis.fieldFilter.maxDataChars` | 数据总字数上限 | `80000` |
| `analysis.summary.enabled` | 是否启用 LLM 摘要 | `false` |
| `analysis.summary.model` | 摘要模型引用 | 复用 analyzer 的 model |
| `analysis.summary.chunkSize` | 每次发送的最大字符数 | `20000` |
| `analysis.summary.targetSize` | 摘要结果目标字符数 | `4000` |

**fieldFilter 默认筛选字段**（不配置 `logFields` / `spanFields` 时）：

| 数据类型 | 默认字段 | 说明 |
|---------|---------|------|
| 日志 | `timestamp`, `level`, `appname`, `traceId`, `message` | message 截断 500 字符 |
| Span | `operationName`, `serviceName`, `durationMs`, `hasError` | 不截断 |

配置模式：
- `logFields` / `spanFields` 未配置 → 使用上述默认筛选
- `logFields: ["*"]` / `spanFields: ["*"]` → 保留全部字段，不截断
- `logFields: ["field1", "field2"]` → 按指定字段列表提取，不截断

### 环境变量

所有配置项均可通过环境变量设置：

```bash
# ClickHouse
MONITOR_CLICKHOUSE_URL="http://localhost:8123"
MONITOR_DATABASE="default"
MONITOR_TABLE="logs"
MONITOR_TRACE_ID_FIELD="traceid"

# Trace ES
TRACE_ES_HOST="http://es-host:9200"
TRACE_ES_INDEX_PATTERN="jaeger-span-*"
TRACE_ES_USERNAME="user"
TRACE_ES_PASSWORD="pass"

# Log ES
LOG_ES_HOST="http://es-host:9200"
LOG_ES_INDEX_PATTERN="log-*"
LOG_ES_TRACE_ID_FIELD="traceId"
LOG_ES_TIMESTAMP_FIELD="@timestamp"
LOG_ES_USERNAME="user"
LOG_ES_PASSWORD="pass"

# 模式配置
MONITOR_LOG_SOURCE="es"
MONITOR_TRACE_LOG_SOURCE="es"

# Prometheus 指标查询
PROMETHEUS_REMOTE_READ_URL="http://localhost:9090"
PROMETHEUS_CLUSTERS="my-cluster"
PROMETHEUS_NAMESPACE="my-namespace"
PROMETHEUS_RATE_INTERVAL="2m"
PROMETHEUS_STEP="30s"

# 参数提取模型
EXTRACTOR_MODEL_BASE_URL="https://your-llm-api/v1"
EXTRACTOR_MODEL_TOKEN="your-api-key"
EXTRACTOR_MODEL_NAME="model-name"

# Agent 模型
AGENT_MODEL_BASE_URL="https://your-llm-api/v1"
AGENT_MODEL_TOKEN="your-api-key"
AGENT_MODEL_NAME="model-name"
AGENT_MODEL_API="openai-completions"

# 默认 Agent
DEFAULT_AGENT_BASE_URL="https://your-llm-api/v1"
DEFAULT_AGENT_TOKEN="your-api-key"
DEFAULT_AGENT_MODEL="model-name"

# 长期记忆
MONITOR_MEMORY_ENABLED="true"
MONITOR_MEMORY_MAX_ENTRIES="20"
MONITOR_MEMORY_MAX_CHARS="10000"

# 调试开关
OMC_DEBUG=1    # 开启 LLM 请求调试日志 + Agent payload 日志 + /alert 命令
```

## Prompt 管理

工具内所有 LLM prompt 以 `.md` 文件形式存放在项目 `src/prompts/` 目录下，便于独立迭代维护，无需修改代码。

### 加载优先级

1. **用户自定义** `~/.omc/prompts/<name>.md` — 最高优先级，可覆盖任意内置 prompt
2. **项目内置** `src/prompts/<name>.md` — 随包发布的默认版本

### Prompt 文件一览

| 文件 | 用途 |
|------|------|
| `extract-params.md` | 从报警事件 JSON 提取查询条件（appname、podname、apiPath 等） |
| `summary-system.md` | 日志/链路增量摘要的 system prompt |
| `summary-user.md` | 日志/链路增量摘要的 user 模板 |
| `summary-refine.md` | 日志/链路摘要超限时的二轮精简 prompt |
| `metrics-summary-system.md` | Prometheus 指标增量摘要的 system prompt |
| `metrics-summary-user.md` | Prometheus 指标增量摘要的 user 模板 |
| `metrics-summary-refine.md` | 指标摘要超限时的二轮精简 prompt |
| `sre-deep.md` | SRE 深度分析 prompt（默认分析模板） |
| `agent-sre-deep.md` | Agent 深度分析 system prompt（工具调用原则+对话规范） |
| `default-agent.md` | 默认 Agent system prompt（可观测性助手+场景流程+工具说明） |

### 模板变量

Prompt 文件中使用 `{{variable}}` 格式的模板变量，由代码在运行时替换：

| 变量 | 说明 | 使用文件 |
|------|------|----------|
| `{{data}}` | 分析数据（JSON 或摘要文本） | `sre-deep.md` |
| `{{context}}` | 额外上下文知识 | `sre-deep.md` |
| `{{previousSummary}}` | 前一轮摘要结果 | `summary-user.md`, `metrics-summary-user.md` |
| `{{chunk}}` | 本轮新增数据 | `summary-user.md`, `metrics-summary-user.md` |
| `{{currentSummary}}` | 待精简的摘要内容 | `summary-refine.md`, `metrics-summary-refine.md` |
| `{{targetSize}}` | 精简目标字符数 | `summary-refine.md`, `metrics-summary-refine.md` |

### 自定义 Prompt

在 `~/.omc/prompts/` 下创建同名 `.md` 文件即可覆盖内置版本：

```bash
mkdir -p ~/.omc/prompts
cp prompts/extract-params.md ~/.omc/prompts/extract-params.md
# 编辑自定义版本
vim ~/.omc/prompts/extract-params.md
```

分析 prompt 还可通过配置中的 `analysis.analyzers.<name>.prompt` 字段指定不同的 prompt 文件名（不含 `.md` 后缀）。

## 开发

```bash
# 安装依赖
npm install

# 开发模式运行
npm run dev -- [options]

# 构建
npm run build

# 生产模式运行
npm start -- [options]

# 测试
npm test

# 发布
npm publish
```

## 技术栈

- TypeScript
- [Ink](https://github.com/vadimdemedes/ink) — React for CLI
- [pi-agent](https://github.com/mariozechner/pi-agent) — Agent 运行框架（工具调用+对话循环）
- [@sinclair/typebox](https://github.com/sinclairzx81/typebox) — Agent 工具参数 Schema
- [chalk](https://github.com/chalk/chalk) — 终端 ANSI 颜色
- [marked](https://github.com/markedjs/marked) — Markdown 解析（终端渲染）
- [pino](https://github.com/pinojs/pino) — 结构化日志（OMC_DEBUG=1 时启用）
- ClickHouse / Elasticsearch
- OpenAI 兼容 LLM API（参数提取 + 智能分析 + Agent 对话）
