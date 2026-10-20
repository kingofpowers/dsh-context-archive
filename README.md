# dsh-context-archive

让**模型自己**决定哪些工具结果可以离开上下文，并把它们归档到**本会话自己的目录**里。

和"按大小自动剪枝"的插件不同，这里的触发权在模型手里：它知道哪份输出已经读完了、哪份后面还要引用。

## 怎么告诉插件"这份可以归档了"

**不需要先列清单。** 每个 ≥800 字符的纯文本结果在写入上下文时，会自动带一行内联编号：

```
[#a1b2c3d4 · 24810 chars]
npm run build ...
```

模型看到哪个编号不要了，直接一次调用把它们全部归档：

```
context_archive { ids: ["a1b2c3d4", "9f3e0b21"], note: "已提取所需字段" }
```

`context_archive {}`（不传 ids）仍然可用，它会返回一份带工具名和首行预览的清单，用于**发现**：老结果没有内联编号、或者模型想确认还有哪些可归档时用。

编号 = 结果正文（去掉那行前缀后）的 sha256 前 8 位，纯函数推导，不依赖任何映射表。

归档后，那条结果在上下文里变成三行存根：

```
[archived #a1b2c3d4 · bash · 24810 chars / 612 lines]
file: ...\sessions\...\<session-id>\archives\a1b2c3d4.txt
first: npm run build ...
```

## 归档去哪

```
~/.dsh/sessions/<workspace-slug>/<session-id>/archives/
├── a1b2c3d4.txt      # 原文（带 session/seq/tool/时间/note 头）
└── index.json        # 归档索引：编号 → seq / 工具 / 字符数 / note / 时间
```

会话目录由 DSH 的 `sessionPersistence.locate()` 解析，不靠拼字符串；拿不到该服务时回退到
`projectKey(cwd)` + 会话 id 的等价路径。会话被删除时归档随目录一起消失，不会留垃圾。

## 行为保证

- **原文永不丢失**：先写归档文件，再改上下文；文件写失败就不替换。
- **只增日志**：替换是一次 `surfaceOp: { op: 'replace' }` 的 `tool/result` 追加，原始事件仍在只增日志里，replay 可复现。
- **只改 content**：按宿主校验规则，替换保留 `turn`/`step`/`message.source` 等全部字段。
- **幂等**：同一编号再归档返回 `already_archived`，不会套娃。
- **护栏**：最近 `keep_turns`（默认 3 轮）内的工具结果不可归档，`0` 表示不设护栏；含图片等非文本块的结果不归档；单次最多 20 条。
- **失败放行**：任何一条出错只影响它自己，返回逐条状态，不抛异常。

## 配置

三层，优先级从高到低：**单次调用参数 > 运行时文件 > profile 配置**。

### 运行时文件（改完立即生效，不用重启）

`~/.dsh/context-archive.json`：

```json
{
  "keepTurns": 3,
  "annotate": true,
  "annotateMinChars": 2000,
  "minChars": 2000,
  "maxAnnotated": 200
}
```

插件在每次用到配置时重新读取它（mtime 缓存），所以**下一条工具结果就会按新值处理**。设置面板改的就是这个文件；手改同样生效；删掉文件即回到 profile 配置。

### profile 配置（初始默认值，装载时读取）

`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: context-archive
  name: dsh-context-archive
  config:
    keepTurns: 3
    annotate: true
    annotateMinChars: 2000
    minChars: 800
```

注意这是**顶层数组**，把这段插到数组里（不要新建一层 `config:`）。改完需要重启。

| 键 | 默认 | 含义 |
|---|---|---|
| `keepTurns` | 3 | 最近多少轮保持不动；0 = 全部可归档 |
| `annotate` | true | 是否在长结果前加一行内联编号 |
| `minChars` | 2000 | 唯一的归档阈值：≥ 它的结果才带编号、才进清单 |
| `nudge` | true | 有 ≥5 条可归档时，每 40 个事件最多提醒一次 |
| `maxAnnotated` | 200 | 同时存在的编号上限；0 = 不限，达到上限后新结果不再编号 |

阈值只有一个：编号和清单共用。带编号的结果形如 `[#a1b2c3d4]`（13 字符），不再附带大小。

### 单次调用覆盖

| 参数 | 默认 | 含义 |
|---|---|---|
| `keep_turns` | 配置值 | 覆盖本轮调用的轮次护栏 |
| `min_chars` | 配置值 | 覆盖本轮清单的最小长度 |
| `limit` | 40 | 清单最多返回条数 |
| `stats` | false | 返回分桶回收统计，不改动任何内容 |
| `note` | — | 归档原因，写入归档文件头与索引 |

配置非法（负数、非整数、`annotate` 非布尔）时插件会**明确报错并拒绝装载**，不会半加载。

## 统计面板

装好后侧栏（better-sidebar）多一个「上下文归档」tab，上半部分是分桶统计，下半部分就是上面四个阈值，改完点保存即时生效。

### 为什么不是每次扫日志

3 千条结果扫一遍约 1 秒；30 万条就没法用了。所以分母是**增量折叠**的：

- 订阅 `session/event`，每个 `tool/result` 落一条就按大小进桶，O(1)；
- 每个会话记一个 `lastSeq`，同一个 seq 只折一次（重启、resume、事件重放都不会重复计数）；
- 第一次见到某个会话时，从它的内存前缀**回填一次**，之后只处理新增；
- 计数写在 `~/.dsh/context-archive-stats.json`（1.5 秒防抖落盘，退出前 flush）。

装好或升级后第一次打开面板会做一次全量 `reconcile`（就是原来的扫盘），把已存在的会话折进计数器并写入各自的 `lastSeq`，之后不再扫。
需要手动重建时：`GET /dsh-context-archive/stats?reconcile=1`。

### 口径

- **结果数**：所有会话里的 `tool/result`（存根不计）。
- **已编号**：带内联编号的结果——**只有这些才可能被回收**，所以回收率的分母用它，而不是全部结果。历史结果没有编号，混进分母只会把回收率稀释成 0.1%。
- **分子**：各会话 `archives/index.json` 里的条目（条目本来就不多，每次读一遍很便宜）。
- **打平率** `p* = 前缀成本(13) / (平均正文 − 平均存根)`：这一档的回收率要高于它，编号才划算。
- **结论**：每桶至少 3 条归档样本才判「划算 / 不划算」，否则「样本不足」。

面板里的「推荐阈值」是**第一个被观测到划算的桶**，样本不足时不给建议。

同样的数据也能让模型取：`context_archive { stats: true }`。

## 安装

```sh
dsh plugin --profile web add dsh-context-archive
```

从源码开发时用本地链接（改代码即时生效，但**要重启 DSH** 才会重新导入）：

```sh
dsh plugin --profile desktop add link:<path-to-this-folder>
```

开发验证：

```sh
npm test    # node --test，38 个用例，零依赖
```

## 安全说明

- **不联外网**：没有任何出站请求；只在 DSH 自己的回环服务器上注册两个同源端点 `GET /dsh-context-archive/stats`、`GET|POST /dsh-context-archive/config`（后者只写上面那个 JSON 文件，输入按白名单校验、上限 4 KB）。
- **会写盘**：归档文件是工具输出的**原文**，可能包含密钥、令牌或隐私内容；它们落在 `~/.dsh/sessions/<...>/<session-id>/archives/`（与你自己的 DSH 数据同权限），随会话删除而删除。不要在共享机器上归档敏感输出。
- **会改上下文**：归档通过一次 `tool/result` 的表面替换实现（只改 `content`，保留 `turn`/`step`/`callId`），原始事件永久保留在只增日志里，可回放、可回捞。
- **失败放行**：写盘失败、校验不通过、找不到会话时一律保持原样，不会把成功调用变成错误。

## 已知限制

- 需要在**下一次**模型请求时才看到替换后的短存根（本轮的请求已经发出）。
- 内联编号只加在插件启用**之后**产生的结果上；更早的历史结果仍可用 `context_archive {}` 列出后归档。
- 插件改动后要**重启 DSH** 才生效（Node 的 ESM 模块缓存不会随重装刷新）。
- 存根里的 `first:` 预览是压平后的前 120 字符，不含完整摘要；需要细节时按路径 `read`/`grep`。
- 与 `dsh-compaction-tool-result-pruner` 不冲突（存根远小于其 8192 字符阈值），但两者同时开启时以先到者为准。
