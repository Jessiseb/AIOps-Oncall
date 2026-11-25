# 04 · LangGraph 入门——AIOps 诊断的引擎

> 定位：LangGraph 是 AIOps 链路的引擎，也是"Plan-Execute-Replan"面试考点的最终章。
> 本篇带你把状态图的每个部件拆到螺丝级，读完能独立画出整张图并讲出护栏设计。
> 前置：03（LangChain 五块积木，尤其 §7）。

## 1. 核心思想：把"流程"从代码里的 if-else 搬进显式的图

Java 视角一句话：**LangGraph ≈ 用 Python 写的 Camunda/Flowable**——把多步 LLM 工作流从面条代码提升为显式建模的状态机，可挂持久化、可流式、可画图调试。

为什么这个项目需要它：AIOps 诊断 = "定计划 → 执行一步 → 评估 → 继续或调整 → 出报告"的**循环流程**，普通函数调用搞不定"跑到一半根据 LLM 判断改道"，LangGraph 把它做成一等公民。

## 2. 四个核心概念（对照 Spring StateMachine）

| LangGraph | 是什么 | 本项目出处 |
|---|---|---|
| **State（状态）** | 全局共享的"黑板"，TypedDict 定义 | `state.py:10-24` |
| **Node（节点）** | 干活的函数：读状态 → 返回状态更新 | planner / executor / replanner |
| **Edge（边）** | 节点间的转移规则 | `aiops_service.py:45-46` |
| **Checkpointer（存档点）** | 每步之后保存状态快照 | MemorySaver（内存版） |

### 2.1 State：一个 TypedDict，一个特殊注解

`state.py:10-24` 全文：

```python
class PlanExecuteState(TypedDict):
    input: str                                            # 用户任务
    plan: List[str]                                       # 待执行步骤
    past_steps: Annotated[List[tuple], operator.add]      # 已执行历史 ← 全项目最妙的一行
    response: str                                         # 最终报告
```

**`Annotated[List[tuple], operator.add]` 是本篇最重要的一行**（01 篇说过"先跳过，这篇讲"）：LangGraph 节点返回的不是全量状态，是**增量更新**。默认策略"新值覆盖旧值"，但 `past_steps` 标了 `operator.add`，意思是：节点返回 `{"past_steps": [("查监控", "CPU 90%")]}` 时，框架执行 `旧值 + 新值` 列表拼接——**追加，不覆盖**。

对照 Java：≈ 你往 Kafka Streams / Reactor 里写的 `reduce` 语义，或者 Spring StateMachine 里的累加型上下文字段。效果就是 executor.py:107 那行 `return {"past_steps": [(task, result)]}`——只返回本步的记录，框架自动追加到历史。

其余字段（input/plan/response）都是覆盖语义：executor 返回 `{"plan": plan[1:]}` 表示"消费掉第一个步骤后的新列表"。

### 2.2 Node：普通异步函数 + 一个约定

```python
async def executor(state: PlanExecuteState) -> Dict[str, Any]:
    plan = state.get("plan", [])
    task = plan[0]                        # 取队头步骤
    ...执行...
    return {"plan": plan[1:], "past_steps": [(task, result)]}   # 增量更新
```

约定就三条：入参是全量状态；返回值是"要改哪些字段"；异步更好（框架全异步调度）。

### 2.3 Edge：固定边 + 条件边

`aiops_service.py:44-73` 搭的图，画出来是这样：

```
入口 → planner ──→ executor ──→ replanner ──┬─(有 response)──→ END
              (固定边)     (固定边)          │
              ↑                            │
              └────(继续执行/重规划)─────────┘
```

```python
workflow.add_edge("planner", "executor")            # 固定边：无脑走
workflow.add_edge("executor", "replanner")

def should_continue(state) -> str:                  # 条件边：图里的 if-else
    if state.get("response"):                       # 有最终报告 → 结束
        return END
    if state.get("plan"):                           # 还有步骤 → 回 executor
        return NODE_EXECUTOR
    return END

workflow.add_conditional_edges("replanner", should_continue, {...})
```

**注意 planner 和 executor 之间没有环**——环是 executor ↔ replanner 之间的：执行一步、评估一步。而 RAG 链路的 create_agent 内部是"模型⇄工具"小循环（03 篇 §5），两种环形状不同、目的不同。

### 2.4 Checkpointer：每步自动存档

`workflow.compile(checkpointer=MemorySaver())`。每个节点跑完自动把状态快照存进 checkpointer，key 是 `thread_id`（= 会话 ID，aiops_service.py:108-112）。作用：① 支持按会话恢复中断的流程；② `get_state()` 能事后取最终状态（aiops_service.py:134-139）。短板：MemorySaver 是内存实现，重启即失——生产要换 SqliteSaver/PostgresSaver，这是"项目不足"清单上的常客。

## 3. Replanner 深潜：三种决策 + 三道护栏（面试宝藏段落）

Replanner 是整个图里最"智能"的节点——它自己也是一段 LLM 调用，用结构化输出在三个动作里选（`Act` 模型，replanner.py:25-37）：

| action | 含义 | 返回的状态更新 |
|---|---|---|
| `continue` | 剩余计划合理，接着走 | `{}`（什么都不改） |
| `replan` | 计划有问题，换步骤 | `{"plan": new_steps}`（替换剩余计划） |
| `respond` | 信息够了，出报告 | `{"response": 最终报告}` |

**LLM 是不可靠的**——它可能无限 replan 把流程拖死、也可能每步都想再加两个步骤。所以 replanner.py 在 LLM 决策外面套了三道硬编码护栏（**纯代码，不信任 LLM 自己的判断**）：

| 护栏 | 位置 | 规则 |
|---|---|---|
| ① 总步数上限 | replanner.py:130-138 | `past_steps >= 8` → 无视 LLM，强制 respond |
| ② replan 禁赛线 | replanner.py:219-221 | 已执行 ≥5 步 → LLM 想 replan 也不批，强制 respond |
| ③ 步骤数不膨胀 | replanner.py:211-216 | LLM 给的新步骤比剩余还多 → 截断到剩余数量 |

**面试金句**："LLM 负责智能决策，代码负责硬性约束——凡是'绝不允许发生'的事（死循环、无限膨胀），必须用确定性代码兜底，不能指望提示词。" 这句话适用于所有 Agent 生产化话题。

另外注意 replanner 的输入设计：它读的是 `past_steps` 全量 + `plan` 剩余 + 原始任务，且给 LLM 的用户消息里**额外塞了一条"已执行 N 步，请优先考虑 respond"的提示**（replanner.py:186）——提示词工程和代码护栏双管齐下。

## 4. 流式输出：yield 在 LangGraph 里的形态

`aiops_service.py:114-131`：

```python
async for event in self.graph.astream(input, config, stream_mode="updates"):
    for node_name, node_output in event.items():
        if node_name == NODE_PLANNER:   yield self._format_planner_event(node_output)
        elif node_name == NODE_EXECUTOR: yield self._format_executor_event(node_output)
        ...
```

三层套娃至此全部合体：**FastAPI 路由（02 篇 §5.5）← async 生成器 ← graph.astream**。LangGraph 每跑完一个节点就吐一个事件，外层 service 把它翻译成前端友好格式再 yield 出去，SSE 推给浏览器。`stream_mode="updates"` 表示"只给本步更新的字段"（轻量），另有 `"values"` 模式给全量状态。

## 5. 全景串讲：一次 AIOps 诊断的完整时序

把四份教材串成一条线，`POST /api/aiops` 之后发生的事：

```
1. aiops.py 路由收到请求（只有 session_id）
2. aiops_service.diagnose() 塞入固定诊断任务模板（含报告 Markdown 格式要求）
3. StateGraph 开始跑：
   ① planner   查知识库找经验 → 结合工具清单 → LLM 生成 4-6 步计划
   ② executor  取队头步骤 → LLM 点工具 → ToolNode 执行（查监控/查日志）→ 结果回填 → 单步结论
   ③ replanner 三道护栏 → LLM 三选一 → continue 回 ② / replan 换计划回 ② / respond 出报告
   ④ 循环直到 response 非空 → 条件边路由到 END
4. 每跑完一个节点，astream 吐一个事件 → service 格式化 → yield → SSE → 前端逐步渲染
5. 结束后 yield {"type":"complete", "response": 报告}，前端渲染完整 Markdown 报告
```

能不看资料把这个时序讲 90 秒，AIOps 链路就算真正吃透了。

## 6. 面试问答速记

| 问 | 答的骨架 |
|---|---|
| LangGraph 和 LangChain 什么关系？ | LangChain 是零件库（模型/消息/工具/管道），LangGraph 是建在其上的工作流引擎；本项目 RAG 用前者预制 Agent，AIOps 用后者手搭图 |
| State 怎么设计的？ | TypedDict 四字段；past_steps 用 `Annotated[..., operator.add]` 声明追加式归并，其余覆盖 |
| 条件边是什么？ | 节点后挂一个读 state 返回下一节点名的函数，本图 replanner 后按"有无 response"决定回 executor 还是 END |
| 怎么防止 LLM 把流程拖死？ | 三道护栏：总步数 8 强制 respond；≥5 步禁 replan；新步骤数不得超剩余。LLM 管决策，代码管红线 |
| 会话状态存哪？ | checkpointer=MemorySaver 按 thread_id 存快照；内存实现重启丢，生产换 Sqlite/Postgres Saver |
| 流式怎么做的？ | graph.astream 每节点一事件 → service 转格式 yield → EventSourceResponse SSE 推前端 |

## 7. 自测五题

1. `past_steps` 为什么标 `operator.add`？如果去掉这个注解会发生什么？
2. 图里唯一的环在哪两个节点之间？为什么 planner→executor 不能是环？
3. LLM 决策 replan 且给了 6 个新步骤、剩余计划只有 2 个——代码会怎么处理？哪道护栏？
4. `stream_mode="updates"` 和 `"values"` 的区别？
5. 前端收到 `{"type":"plan"}` 事件时，后端刚跑完哪个节点？

## 8. 阶段 0 收官，下一站

四份教材（Python / FastAPI / LangChain / LangGraph）+ 可视化解读页 + yield 模拟器，理论弹药已备齐。剩下两块——Milvus 向量库内部、MCP 协议——**跟着跑起来的项目学**。
