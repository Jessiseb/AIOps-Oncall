# 03 · LangChain 入门——本项目灵魂层

> 定位：LangChain/LangGraph 是这个项目的**灵魂**，也是面试问题最密集的一层。
> 本篇带你读懂项目里全部 4 种 LangChain 用法，每个知识点附仓库出处。
> 前置：01（Python 基础）、02（FastAPI）。

## 1. 先搞清：LangChain 和 LangGraph 是什么关系

一句话分工：

- **LangChain**：一组"跟 LLM 打交道的标准零件"——统一模型接口、消息对象、提示词模板、工具协议、组合管道
- **LangGraph**：建立在零件之上的**工作流引擎**——把"节点"拼成带环、带条件的图，让多步 Agent 流程可控

类比 Java：LangChain ≈ 一堆标准库组件（JPA、Jackson），LangGraph ≈ 工作流引擎（Camunda/Flowable）。本项目两条链路各用一边：

| 链路 | 用什么 | 出处 |
|---|---|---|
| RAG 问答 | LangChain `create_agent`（预制 Agent） | `rag_agent_service.py:130` |
| AIOps 诊断 | LangGraph 手搭状态图 | `aiops_service.py:29-79` |

**为什么 LangChain 值得用**（面试必问"为什么不用裸调 API"）：它把「换模型不改代码」做成一行参数的事。证据就在项目里——`app/core/llm_factory.py` 用 `ChatOpenAI` 类接阿里云 DashScope（OpenAI 兼容模式），`rag_agent_service.py` 用 `ChatQwen`（阿里官方封装）——同一个项目两种接入方式都能跑，因为都遵守 LangChain 的统一接口。

## 2. 积木一：消息（Message）

LLM 对话的最小单位不是字符串，是**消息列表**，每条带角色。`executor.py:64-79`：

```python
messages = [
    SystemMessage(content="你是一个能力强大的助手，负责执行具体的任务步骤..."),  # 人设/规则
    HumanMessage(content=f"请执行以下任务: {task}"),                             # 用户输入
]
```

三种角色对应千问/ChatGPT 的 role：`system`（设定）、`human`（用户）、`ai`（模型回复）。多轮对话 = 不断往这个列表追加消息再整体发过去（无状态，靠上下文堆出来）。

## 3. 积木二：提示词模板（ChatPromptTemplate）

`planner.py:28-60`：把 system 提示词做成带变量的模板：

```python
planner_prompt = ChatPromptTemplate.from_messages([
    ("system", dedent("""
        作为一个专家级别的规划者...
        可用工具列表：{tools_description}      ← 变量1：工具清单
        {experience_context}                   ← 变量2：知识库检索到的经验
    """).strip()),
    ("placeholder", "{messages}"),             ← 变量3：对话消息插入点
])
```

≈ Java 的 `MessageFormat` / Thymeleaf 模板，变量在调用时填入（见 §4）。面试点：`{experience_context}` 就是我们上次讲的 RAG——**Planner 定计划前先查知识库，把老师傅经验塞进提示词**（planner.py:77-90）。

## 4. 积木三：LCEL 管道——用 `|` 组装流水线

项目里最"Python 味"的语法，`planner.py:131`：

```python
planner_chain = planner_prompt | llm.with_structured_output(Plan)

plan_result = await planner_chain.ainvoke({
    "messages": [("user", input_text)],
    "tools_description": tools_description,
    "experience_context": experience_context
})
```

两行干了两件事：

1. **`|` 是重载的运算符**：把"模板 → 模型 → 输出解析"串成一条链（chain）。语义 ≈ Java 的 `Function.andThen()`：`a | b | c` = "a 的输出喂给 b，b 的输出喂给 c"
2. **`ainvoke(...)` 触发执行**：填变量 → 渲染模板 → 调 LLM → 解析结果，一气呵成

每个零件都实现统一接口 `Runnable`（有 `invoke / ainvoke / stream / astream`），所以随便拼。`astream` 就是你学过的 async 生成器——流式输出的管道版。

## 5. 积木四：工具（Tool）——Agent 的手脚（面试最高频）

分四步看项目里的完整工具闭环：

**① 定义工具：`@tool` 装饰器**（`time_tool.py:10-11`，最小例子）

```python
@tool
def get_current_time(timezone: str = "Asia/Shanghai") -> str:
    """获取当前时间

    当用户询问"现在几点"……时，使用此工具。
    """
```

`@tool` 把普通函数变成 Tool 对象，自动提取三样东西当"菜单"：**函数名、docstring、参数签名**。这就是为什么 docstring 必须写清楚"什么时候用我"——模型靠它决策。

**② 上菜单：`bind_tools`**（`executor.py:58`）

```python
llm_with_tools = llm.bind_tools(all_tools)   # 工具描述随请求发给模型
```

**③ 模型点菜：tool_calls**（`executor.py:82-87`）——模型不执行工具！它只是回复"我想调 `query_logs`，参数是 X"：

```python
llm_response = await llm_with_tools.ainvoke(messages)
if llm_response.tool_calls:      # 模型返回的是"点菜清单"，不是结果
```

**④ 真执行：ToolNode 分发**（`executor.py:61, 91`）

```python
tool_node = ToolNode(all_tools)                 # ≈ 一个自动分发器
tool_messages = await tool_node.ainvoke({"messages": messages})   # 按点菜单真调函数
```

然后 `executor.py:95` 把工具结果追加进消息，**再问一次模型**，让它看着结果说话。

**面试标准答案就藏在这四步里**："工具调用的本质是一个协议循环——框架把工具描述发给模型，模型返回结构化的'调用请求'，框架本地执行后把结果回填给模型，模型再生成最终回答。模型自己碰不到工具，它只是点菜，框架是跑腿的。"（对照 Java：模型 ≈ 只发指令的客户端，ToolNode ≈ DispatcherServlet 按路由分发。）

## 6. 积木五：结构化输出——让模型吐 Pydantic 对象

LLM 默认吐自由文本，但 Planner 需要"步骤列表"这种结构。`planner.py:131`：

```python
llm.with_structured_output(Plan)   # Plan 是 Pydantic 类：steps: List[str]
```

框架会在底层约束/解析模型输出，`ainvoke` 直接返回 `Plan` 对象——`plan_result.steps` 拿步骤列表（planner.py:141-142）。`replanner.py:25-37` 的 `Act` 同款：让模型在 `continue / replan / respond` 三个动作里做决策。**这是"用类型驯服 LLM 输出"的标准手法**，项目里 Planner/Replanner 都靠它。

## 7. 预制 vs 手搭：两条链路的 Agent 形态

**RAG 问答用预制 Agent**（`rag_agent_service.py:130-134`）：

```python
self.agent = create_agent(self.model, tools=all_tools, checkpointer=self.checkpointer)
```

一行造一个"内置工具循环的通用 Agent"：模型自主决定调不调工具、调几个、调完继续答。适合开放式问答。会话记忆靠 `checkpointer=MemorySaver()`（内存版，短板之一）。

**AIOps 诊断手搭 LangGraph 状态图**（`aiops_service.py:34-76`）：

```python
workflow = StateGraph(PlanExecuteState)     # 状态是 TypedDict：input/plan/past_steps/response
workflow.add_node("planner", planner)       # 节点 = 普通异步函数，读状态、返回状态更新
workflow.add_node("executor", executor)
workflow.add_node("replanner", replanner)
workflow.add_edge("planner", "executor")    # 固定边：定完计划就执行
workflow.add_conditional_edges("replanner", should_continue, {...})  # 条件边：继续 or 结束
compiled = workflow.compile(checkpointer=MemorySaver())
```

- **节点**：`async def planner(state) -> dict`，拿全量状态，返回要更新的字段（executor.py:105-107 返回 `{"plan": plan[1:], "past_steps": [...]}`——消费一步、记录一步）
- **条件边**（aiops_service.py:49-64）：`should_continue` 看 state 里有没有 `response` 决定走 END 还是回 executor——**图里的 if/else**
- **流式**：`graph.astream(...)` 异步生成器，每跑完一个节点吐一个事件——yield 知识点第三次回收

**为什么诊断不用预制 Agent？**（面试必问）诊断需要"先定完整计划、边执行边评估、必要时重规划"的**确定性骨架**，预制 Agent 的一步步随机试探不适合长流程运维任务——要可控、可观测、可设护栏（replanner 的 MAX_STEPS=8）。这就是 Plan-Execute-Replan 模式的价值。

## 8. 面试高频问答速记

| 问 | 答的骨架 |
|---|---|
| 为什么用 LangChain？ | 统一模型接口换模型不改代码（项目里 ChatOpenAI/ChatQwen 双接入为证）+ 现成的工具协议/结构化输出/工作流引擎 |
| 工具调用原理？ | §5 四步：描述上菜单 → 模型返回 tool_calls → 框架执行 → 结果回填再生成 |
| `|` 管道是什么？ | LCEL，Runnable 组合，≈ Function.andThen，末端 ainvoke 触发 |
| 怎么保证 LLM 输出能被程序解析？ | with_structured_output + Pydantic（Plan/Act） |
| create_agent 和手搭图怎么选？ | 开放问答用预制；长流程要可控可护栏就手搭 StateGraph（本项目两条链路正好各占一个） |
| 记忆怎么实现的？ | checkpointer=MemorySaver 按 thread_id 存消息，进程内有效；生产换持久化实现 |

## 9. 自测四题

1. `@tool` 装饰器从函数里提取了哪三样东西给模型当菜单？
2. 模型说"我要调 get_current_time"之后，是谁真正执行了这个函数？
3. `planner_prompt | llm.with_structured_output(Plan)` 这一竖线，用 Java 里最接近的概念说是什么？
4. AIOps 的 `should_continue` 条件边在图里扮演了什么角色？它看 state 的哪个字段做决定？

## 10. 本篇没展开的（阶段②再深挖）

Milvus 向量库细节（`vector_*` 五个服务）、MCP 客户端原理（`mcp_client.py`）、Replanner 护栏全套（MAX_STEPS=8 / ≥5 步禁 replan）。这些放到跑通项目后按"请求生命周期"精读。
