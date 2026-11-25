# 更新日志—生成模型切换DeepSeek

> Python 版（super_biz_agent_py）。日期：2026-11-25。

## 这次加了什么功能

RAG 问答的**生成模型**（拼好上下文后写答案的那个 LLM）从 qwen-max 切换到 **DeepSeek 官方 API**（`deepseek-chat`，即 DeepSeek-V3 系列），并留了一键切回的开关。

```
以前： embedding(百炼) → Milvus 初排 → gte-rerank-v2 重排(百炼) → qwen-max 生成(百炼)
以后： embedding(百炼) → Milvus 初排 → gte-rerank-v2 重排(百炼) → deepseek-chat 生成(DeepSeek 官方)
```

一个 RAG 系统里有三种模型，各司其职，**只有生成模型换了**：

| 模型角色 | 之前 | 现在 | 为什么不动 |
|---|---|---|---|
| 生成模型（写答案） | qwen-max（百炼） | **deepseek-chat（DeepSeek 官方）** | 这是你这次要换的 |
| 重排模型（精排） | gte-rerank-v2（百炼） | 不变 | DeepSeek 没有 rerank 模型；gte-rerank-v2 是专用的相关性打分模型 |
| 嵌入模型（向量化） | text-embedding-v4（百炼） | 不变 | DeepSeek 不提供 embedding API；换了就得重建整个 Milvus 索引 |

**切官方 DeepSeek 的实际收益**：和百炼账户分开计费——当前百炼 key 处于欠费（Arrearage）状态，切过去后 RAG 问答的生成环节可以独立恢复可用。

---

## 改动点（你需要知道的关键变化）

### 1) 新增配置项（app/config.py + .env）

```python
# app/config.py —— Settings 类新增
deepseek_api_key: str = ""                              # DeepSeek 官方 key
deepseek_base_url: str = "https://api.deepseek.com/v1"  # OpenAI 兼容端点
deepseek_chat_model: str = "deepseek-chat"              # 生成模型
rag_llm_provider: str = "deepseek"                      # 生成模型提供商开关
```

`.env` 对应四行：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_CHAT_MODEL` / `RAG_LLM_PROVIDER`。

切换方式：
- `RAG_LLM_PROVIDER=deepseek`：走 DeepSeek 官方（当前默认）
- `RAG_LLM_PROVIDER=dashscope`：走回 qwen（原行为，模型名还是 `RAG_MODEL`）

**你必须做的一件事**：在 `.env` 里填上 `DEEPSEEK_API_KEY=sk-xxx`（申请地址 https://platform.deepseek.com/ → API Keys）。现在留空，服务启动会**直接报 ValueError 拒绝起**——这是故意的，宁可不启动也不要带病运行。

### 2) rag_agent_service.py 的模型构造改为双分支

文件：`app/services/rag_agent_service.py`

改动前：
```python
self.model = ChatQwen(           # qwen 专用封装类
    model=config.rag_model,
    api_key=config.dashscope_api_key,
    ...
)
```

改动后：
```python
if self.provider == "deepseek":
    self.model = ChatOpenAI(     # 标准类，DeepSeek 官方是 OpenAI 兼容协议
        model=config.deepseek_chat_model,
        api_key=config.deepseek_api_key,
        base_url=config.deepseek_base_url,
        ...
    )
else:
    self.model = ChatQwen(...)   # 原逻辑不动
```

技术要点：DeepSeek 官方 API 兼容 OpenAI 协议，项目里本来就有 `langchain-openai` 依赖，**零新增依赖**。`ChatQwen` 是 `langchain_qwq` 提供的 qwen 专用封装（带扩展思考等定制），换 DeepSeek 后用标准 `ChatOpenAI` 才是对的。

### 3) 流式输出解析的双路兼容（本次改动最容易踩的坑）

文件：`app/services/rag_agent_service.py` 的 `query_stream()`

旧代码只认 `ChatQwen` 特有的 `content_blocks` 字段：
```python
# 旧：只读 content_blocks，ChatOpenAI 的输出会被整个丢弃 → 前端看不到任何流式内容
content_blocks = getattr(token, 'content_blocks', None)
```

新代码按优先级三路兼容：
```python
if content_blocks:              # ChatQwen 特有结构（qwen 扩展思考）
    ...
elif isinstance(content, str):  # 标准 OpenAI 协议（DeepSeek 走这条）
    ...
elif isinstance(content, list): # content 为多块 list[dict] 的兜底
    ...
```

**为什么必须有这段**：LangChain 各模型对消息内容的内部表示不统一。ChatQwen 把流式文本放 `content_blocks`，标准 ChatOpenAI 放 `content`（str）。只改模型类不改解析，DeepSeek 的回答会"消失"——后端一切正常、前端一个字都吐不出来，这种 bug 现场很难查。

### 4) 不动的部分（明确边界）

- **AIOps 诊断链路**（`app/agent/aiops/` 的 planner/executor/replanner）仍用 ChatQwen + `RAG_MODEL`——那是独立链路，这次没动。
- `app/core/llm_factory.py` 没动：它本来就是"OpenAI 兼容模式工厂"（注释里明确写了支持切提供商），但当前没人调用它，不动。
- embedding、重排、Milvus、文档上传全部不变。

---

## 你怎么确认"切换真的生效了"

### 1) 填 key 后启动，看日志第一行

```
RAG Agent 服务初始化完成 (provider=deepseek, model=deepseek-chat, streaming=True)
```

`provider=deepseek` 就说明走的是新链路；`provider=dashscope` 则还是 qwen。

### 2) 填 key 前启动，应看到明确报错

```
ValueError: RAG_LLM_PROVIDER=deepseek 但未配置 DEEPSEEK_API_KEY，请在 .env 中填入...
```

（这是"缺配置拒绝启动"的设计，不是 bug。）

### 3) 流式对话验证

填好 key、启动服务，前端流式提问，能看到逐字输出即流式解析正常。如果答案不流式但一次性出来了，优先查 `query_stream` 的 content 解析分支。

---

## 冒烟测试记录（2026-11-25）

| 项 | 结果 |
|---|---|
| `py_compile` 三个改动文件 | ✅ 通过 |
| `ChatOpenAI` + DeepSeek base_url 构造 | ✅ 模型名 deepseek-chat 正确初始化 |
| 缺 key 时抛 ValueError | ✅（复刻构造逻辑验证） |
| 流式解析：content_blocks 路径（qwen） | ✅ 用模拟 token 验证 |
| 流式解析：标准 str content（DeepSeek 主路径） | ✅ 真实 AIMessageChunk 验证 |
| 流式解析：list[dict] content（多块兜底） | ✅ 补充兼容并验证 |
| DeepSeek 真实 API 调用 | ⛔ 未测——你没有 DeepSeek API Key，`.env` 里 `DEEPSEEK_API_KEY` 留空。填入后按上面"验证"一节跑 |

注：`RagAgentService` 完整导入链路会连带 `vector_store_manager`（模块导入即连 Milvus），Milvus/Docker 没启动时 import 报错属**原有行为**，与本次改动无关。

---

## 一句话把你教明白：到底改了什么

以前：
> 生成答案用 qwen-max，一个百炼 key 包办 embedding、重排、生成三件事；百炼欠费 = 整条链路瘫。

现在：
> 生成答案换成 DeepSeek 官方 API（独立 key 独立计费），embedding 和重排留在百炼。RAG 链路变成"两家供应商拼积木"，哪家出问题都只影响自己那一环，百炼欠费也不耽误 DeepSeek 写答案。

代价是你多管一个 key。配置上 `RAG_LLM_PROVIDER` 一个开关随时切回全 qwen。

---

## 注意事项 / 已知限制

- **DeepSeek key 没填**：`.env` 里 `DEEPSEEK_API_KEY` 当前为空，服务起不来（故意的）。去 https://platform.deepseek.com/ 申请。
- **百炼 key 仍欠费**：embedding 和重排还在百炼侧，欠费没解决的话知识检索工具依然报错（Arrearage），DeepSeek 只救"生成"这一环。要整条链路通，两个账户都得有钱。
- DeepSeek 计费独立，`deepseek-chat` 大约 0.2~0.3 元/百万输入 token（以官网价格页为准）。
- AIOps 链路没切：planner/executor/replanner 仍走 qwen。要不要一起切 DeepSeek，你后面定。
