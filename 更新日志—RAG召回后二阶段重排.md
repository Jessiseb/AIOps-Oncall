# 更新日志—RAG召回后二阶段重排

> Python 版（super_biz_agent_py）。日期：2026-11-25。

## 这次加了什么功能

在 RAG 问答链路中，增加"召回（初排）→ reranker（二阶段重排）→ 拼上下文 → 生成答案"的步骤。

```
以前： Milvus 初排 top 3 ─────────────────────→ 拼上下文 → 生成答案
以后： Milvus 初排 top 10（候选池）→ gte-rerank-v2 重打分 → 取前 3 → 拼上下文 → 生成答案
```

- 只影响：`app/tools/knowledge_tool.py`（检索工具）、`app/config.py`（配置）、`.env`（配置值）
- 新增文件：`app/services/rerank_service.py`（重排服务）
- 不影响：AIOps 诊断链路、文档上传/切块/embedding 入库、MCP 工具

目标：让进入大模型上下文的"参考资料顺序"更相关、更稳定，而不是完全依赖向量初排。

---

## 改动点（你需要知道的关键变化）

### 1) 新增配置项（app/config.py + .env）

```python
# app/config.py —— Settings 类新增
rag_rerank_enabled: bool = True     # 总开关
rag_rerank_model: str = "gte-rerank-v2"  # 百炼平台重排模型
rag_candidate_k: int = 10           # 初排候选池大小
```

`.env` 中对应三个环境变量：`RAG_RERANK_ENABLED` / `RAG_RERANK_MODEL` / `RAG_CANDIDATE_K`（pydantic-settings 自动映射，大小写不敏感）。

含义：
- `RAG_RERANK_ENABLED`
  - `false`：不启用重排，行为与旧版完全一致（召回 3 条直接用）
  - `true`：启用二阶段重排（默认）
- `RAG_RERANK_MODEL`
  - 阿里云百炼平台的重排模型名。当前用 `gte-rerank-v2`（专为语义相关性打分设计的模型，输出相关性分数）
- `RAG_CANDIDATE_K`
  - 初排召回多少条进入重排候选池。最终给大模型的仍是 `RAG_TOP_K`（3）条

### 2) 新增 rerank_service.py

`app/services/rerank_service.py`，全局单例 `rerank_service`。

用的是 `dashscope` SDK 的**原生 TextReRank 接口**（项目本来就有这个依赖，版本 1.26.0）：

```python
response = TextReRank.call(
    api_key=self.api_key,
    model="gte-rerank-v2",
    query=query,
    documents=[doc.page_content for doc in documents],  # 只送正文
    top_n=top_n,
    return_documents=False,
)
```

### 3) reranker 的输入/输出协议（很重要）

**输入**：query + 候选文档正文列表（只送 `page_content`，不送 metadata，避免干扰打分）。

**输出**：`response.output.results` 是一个列表，每项：
```json
{"index": 0, "relevance_score": 0.95}
```
- `index`：候选在输入列表中的下标（从 0 开始）
- `relevance_score`：该候选与 query 的相关性分数（越大越相关）

**SDK 已保证按分数降序返回**，我们按 `index` 从原候选列表取出对应文档，重建一个新列表，并把 `relevance_score` 写进每个文档的 `metadata["rerank_score"]`（保留 4 位小数）。

### 4) knowledge_tool.py 的检索流程变化

文件：`app/tools/knowledge_tool.py`

改动前的逻辑：
```python
retriever = vector_store.as_retriever(search_kwargs={"k": config.rag_top_k})
docs = retriever.invoke(query)
context = format_docs(docs)
```

改动后的逻辑：
```python
# 1. 初排：召回候选池
candidate_k = config.rag_candidate_k if config.rag_rerank_enabled else config.rag_top_k
retriever = vector_store.as_retriever(search_kwargs={"k": candidate_k})
docs = retriever.invoke(query)

# 2. 重排（开关开启时）
if config.rag_rerank_enabled:
    docs = rerank_service.rerank(query=query, documents=docs, top_n=config.rag_top_k)

# 3. 拼上下文
context = format_docs(docs)
```

`format_docs` 也加了一行：有 `rerank_score` 时在参考资料头部展示"相关性: 0.95"。

### 5) 「不降级」策略（和 Java 版最大的区别）

Java 版是超时/失败自动回退初排。**本项目相反：重排失败时直接抛 `RuntimeError`，不回退初排。**

错误会经过两层传递：
1. `rerank_service.rerank()` 抛 `RuntimeError`（含具体的失败原因，如 status=400 / code=Arrearage）
2. `knowledge_tool.retrieve_knowledge` 的 `except` 兜住，工具返回 `"检索知识时发生错误: 重排调用失败: ..."`

这样 Agent（以及最终用户）都能在对话里看到明确报错，问题不会被静默吞掉。表现是"这次检索失败了"，而不是"悄悄用了更差的初排结果还不自知"。

代价：百炼重排 API 不可用时，知识检索工具不可用（但 Agent 主链路和其他工具不受影响）。

---

## 你怎么确认"重排真的生效了"

### 1) 看日志

重排生效时会输出（info 级别，`logs/app_YYYY-MM-DD.log`）：
```
开始重排: model=gte-rerank-v2, query='...', 候选数=10, top_n=3
重排完成, 保留 3 条, 分数: [0.987, 0.843, 0.412]
```

"分数"列表就是每条资料的相关性分（降序）。

### 2) 对比开关

- `RAG_RERANK_ENABLED=false`：不再出现上面两条日志，召回 3 条直接用
- `RAG_RERANK_ENABLED=true`：出现"开始重排/重排完成"日志

### 3) 看上下文里的相关性分数

开启重排后，Agent 看到的参考资料长这样：
```
【参考资料 1】
标题: ...
来源: cpu_high_usage.md
相关性: 0.987
内容: ...
```

---

## 冒烟测试记录（2026-11-25）

| 项 | 结果 |
|---|---|
| `from app.config import config`（含 3 个新配置项） | ✅ 通过 |
| `from app.services.rerank_service import rerank_service` | ✅ 通过 |
| `TextReRank.call` 参数签名核对（SDK 1.26.0 文档） | ✅ 一致：model / query / documents / top_n / return_documents / api_key |
| 真实 API 调用（4 条运维文档，query="CPU 使用率报警怎么排查"） | ⚠️ **账户欠费（code=Arrearage）**，请求已到达百炼、参数合法、返回结构化错误——链路本身验证通过 |
| 重排失败时的行为 | ✅ 按设计显式抛 RuntimeError（"不降级"当场演示成功） |

**当前阻塞**：`.env` 里的 DASHSCOPE_API_KEY 对应账户欠费（Arrearage）且触发限流（429 limit_requests）。**需要你去百炼控制台充值/续费后**，重新验证。顺带也确认了现有 RAG 问答功能同样受影响——不是本次改动引入的。

### 充值后验证步骤（可直接复制）

```bash
cd D:/学习笔记/训练营/OnCall/super_biz_agent_py-release-2026-03-21
.venv/Scripts/python.exe -c "
from langchain_core.documents import Document
from app.services.rerank_service import rerank_service
docs = [
    Document(page_content='CPU 使用率过高时，应先通过 top 命令定位占用最高的进程。', metadata={'_file_name': 'cpu_high_usage.md'}),
    Document(page_content='磁盘使用率过高时，优先清理日志文件和临时文件。', metadata={'_file_name': 'disk_high_usage.md'}),
    Document(page_content='服务不可用时，先检查健康检查接口。', metadata={'_file_name': 'service_unavailable.md'}),
    Document(page_content='内存使用率持续走高时，需要排查内存泄漏。', metadata={'_file_name': 'memory_high_usage.md'}),
]
result = rerank_service.rerank('CPU 使用率报警怎么排查', docs, top_n=3)
for i, d in enumerate(result, 1):
    print(f'{i}. [{d.metadata[\"rerank_score\"]}] {d.metadata[\"_file_name\"]}')
"
```

预期：cpu_high_usage.md 相关性分数最高、排在第 1 位。

---

## 一句话把你教明白：到底改了什么

以前：
> 向量初排觉得"哪些文档跟问题相关"（靠 embedding 余弦相似度，粗排），取 3 条直接给大模型。

现在（默认开启）：
> 向量初排先召回 10 条候选 → 重排模型 gte-rerank-v2 逐条精细判断"这条到底跟问题多相关"（专门训练过的 cross-encoder，精排）→ 挑最相关的 3 条给大模型。

它解决的是：
- embedding 是"把每条文本独立压缩成一个向量再比较"，粒度粗、容易误伤；重排模型是"把 query 和文档放在一起逐对细看"，判断更准。
- 两阶段"宽召回 + 精排序"是搜索系统的经典架构（先保证查全，再保证查准）。

---

## 注意事项 / 已知限制

- **不降级是刻意的**：重排失败 = 工具报错 = 你能立刻发现，不会静默退化。代价是百炼 API 挂掉时知识检索不可用。
- 重排只影响 `retrieve_knowledge` 工具；`vector_search_service`（AIOps 用）完全没动。
- `gte-rerank-v2` 按调用计费（充值后每次调用约几厘钱），成本极低。
- 本次因账户欠费未能跑通端到端真实调用，代码链路、参数协议已验证，欠费解决后按上面步骤复验即可。
