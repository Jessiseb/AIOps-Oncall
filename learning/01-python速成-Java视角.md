# 01 · Python 速成（Java 视角）——读懂本项目够用版

> 定位：不是 Python 教程，是**读 SuperBizAgent 源码的钥匙**。
> 只讲本项目代码里真实出现的写法，每个知识点附源码出处，读完立刻去对照。
> 用法：通读一遍（15 分钟）→ 按 §4 自测 `app/config.py` → 之后读任何代码卡住时回来查。

## 1. 先建全局：Java ↔ Python 对照表

| Java 里你熟悉的 | Python 对应 | 一句话差异 |
|---|---|---|
| `;` 和 `{}` | 没有分号，**缩进 4 空格就是语法** | 缩进错了 = 编译错误 |
| `String name = "x";` | `name = "x"`（类型可写可不写） | 写了叫"类型注解"，见 §2.2 |
| `null` | `None` | |
| `false` / `true` | `False` / `True` | 首字母大写 |
| `public class Foo` | `class Foo:` | 没有访问修饰符，`_name` ≈ 约定的 protected |
| `this` | `self`（且必须写成方法第一个参数） | |
| 构造方法 `public Foo()` | `def __init__(self)` | |
| `@Override` 等注解 | `@装饰器` | **装饰器是会真实执行的代码**，见 §2.6 |
| package + import | 文件夹 + `import`（一个 .py 文件就是一个模块） | 没有"一个 public 类一个文件"的限制 |
| `Map<String, Object>` | `Dict[str, Any]` | |
| `List<String>` | `list[str]` | |
| try-with-resources | `with` 语句 | §2.7 |
| CompletableFuture / Netty EventLoop | `async/await` + 事件循环 | §2.8 |
| Maven + pom.xml | `uv` / `pip` + `pyproject.toml` | §5 |
| 每项目独立依赖（靠工具链） | `.venv` 虚拟环境 | §5 |

## 2. 项目里反复出现的 10 个模式

### 2.1 f-string：字符串拼接

出处：`app/services/aiops_service.py:59`

```python
logger.info(f"继续执行，剩余 {len(plan)} 个步骤")
```

Java 对照：`logger.info("继续执行，剩余 {} 个步骤", plan.size())`。
规则：字符串前加 `f`，`{}` 里可以放任意表达式。

### 2.2 函数：def + 类型注解 + 默认参数

出处：`app/services/aiops_service.py:81-85`

```python
async def execute(
    self,
    user_input: str,
    session_id: str = "default"     # 默认参数 ≈ Java 重载的简化版
) -> AsyncGenerator[Dict[str, Any], None]:
```

- `def` 定义函数；冒号 + 缩进代替大括号
- `user_input: str` 是类型注解——**只是提示，运行时不强制**（不像 Java 编译期检查）
- `session_id: str = "default"`：调用时可不传，也可 `execute(session_id="abc")` 按名传参（Java 没有这个）
- 返回类型 `AsyncGenerator[...]` 表示"异步生成器"，见 §2.9

### 2.3 dict / list：这个项目的"通用货币"

出处：`app/services/aiops_service.py:142-147`

```python
yield {
    "type": "complete",
    "stage": "complete",
    "message": "任务执行完成",
    "response": final_response
}
```

这就是一个 `Dict[str, Any]` 字面量（≈ Java 的可变 `Map`，但满地都是）。常用操作速查：

```python
d["key"]                  # 取值，key 不存在抛 KeyError
d.get("key", "")          # 安全取值，不存在返回默认值（aiops_service.py:139 在用）
"key" in d                # 判断是否存在
lst[-1]                   # 最后一个元素
lst[-6:]                  # 最后 6 个元素（rag_agent_service.py:61 在用）
lst1 + lst2               # 拼接
for k, v in d.items(): ...  # 遍历
```

### 2.4 类：__init__ / self / @property

出处：`app/services/aiops_service.py:20-27`

```python
class AIOpsService:
    """通用 Plan-Execute-Replan 服务"""      # docstring ≈ Javadoc，写在类体第一行

    def __init__(self):                      # 构造方法
        self.checkpointer = MemorySaver()    # ≈ this.checkpointer = ...
        self.graph = self._build_graph()     # _ 前缀 ≈ 约定的私有方法
```

`@property`（`app/config.py:51`）把方法变成"读起来像字段"的只读属性：

```python
@property
def mcp_servers(self) -> Dict[str, Dict[str, Any]]:
    ...

config.mcp_servers    # 调用时不加括号，像读字段
```

### 2.5 Pydantic：BaseSettings / BaseModel

出处：`app/config.py:10-25`、`app/agent/aiops/replanner.py:20-37`

```python
class Settings(BaseSettings):          # ≈ @ConfigurationProperties 绑定 application.yml
    app_name: str = "SuperBizAgent"    # 字段 + 默认值；.env 有同名变量会自动覆盖
    milvus_host: str = "localhost"
```

```python
class Act(BaseModel):                  # ≈ DTO + 校验注解，还能自动生成 JSON Schema
    action: str = Field(description="下一步的行动...")
    new_steps: List[str] = Field(default_factory=list)   # 默认空列表
```

这个项目里 Pydantic 干三件事：读配置（Settings）、定义请求/响应模型（`app/models/`）、约束 LLM 的结构化输出（Act/Response）。
另外注意 `app/config.py:67` 的 `config = Settings()`——模块级变量天然单例，不需要 Spring 容器。

### 2.6 装饰器：长得像注解，但是真的代码

出处：`app/main.py:71`

```python
@app.get("/")
async def root():
    ...
```

Java 的 `@GetMapping` 只是元数据，靠 Spring 反射处理；Python 的 `@app.get("/")` 是**立即执行的函数调用**——把 `root` 函数当参数传进去，FastAPI 内部把它注册成路由。理解成：框架在 import 阶段就开始干活，没有 IoC 容器、没有组件扫描。

### 2.7 with：try-with-resources

```python
with open("f.txt") as f:      # ≈ try (var f = ...) { ... }
    data = f.read()
```

本项目最典型的是 `app/main.py:19-20` 的 `@asynccontextmanager` + `async def lifespan`：用生成器语法定义"应用启动干什么、关闭干什么"，函数里的 `yield` 正好把生命周期切成前后两半，交给 FastAPI 在启停时调用——≈ Spring 的 `@PostConstruct` / `@PreDestroy`。

### 2.8 async / await：单线程事件循环

出处：`app/services/aiops_service.py:114`

```python
async for event in self.graph.astream(...):   # 异步迭代：每拿到一个事件处理一个
```

- `async def` 定义协程；`await xxx` = "这里要等 IO，先让出线程，好了再回来"
- 心智模型：≈ Netty 的 EventLoop——单线程轮询大量 IO 任务，谁好了跑谁；而不是"一个请求占一个线程"
- 为什么这个项目到处是 async：LLM 调用、向量检索、MCP 工具调用全是网络 IO，async 让一个进程同时挂起几十个请求
- 规则：`await` 只能写在 `async def` 里；调用 async 函数必须 await（或交给框架调度）

### 2.9 yield：生成器（本项目的流式核心，重点）

出处：`app/services/aiops_service.py:81-147`

```python
async def execute(self, ...):                  # 函数体里出现 yield → 它是"生成器"
    ...
    yield {"type": "plan", "plan": plan}       # 产出事件1，暂停
    async for event in self.graph.astream(...):
        yield ...                              # 产出事件2、3、4...
    yield {"type": "complete", "response": final_response}
```

Java 没有直接对应物，三个关键认知：

1. 调用 `execute(...)` **不执行任何代码**，只返回一个生成器对象
2. 消费方每要一个值（`async for`），函数体才从上一个 yield 处恢复，跑到下一个 yield 再暂停
3. 一进一出、边跑边给——这就是 `/api/chat_stream`、`/api/aiops` SSE 流式输出的全部原理：后端每诊断一步就 yield 一个事件，前端立即渲染

面试一句话："Python 生成器把'可挂起的懒迭代'做成了语言特性，我们用它实现流式事件推送。"

### 2.10 模块与 if __name__ == "__main__"

出处：`app/main.py:84-93`

```python
if __name__ == "__main__":
    uvicorn.run("app.main:app", ...)
```

- 一个 .py 文件就是一个模块；`from app.api import chat` ≈ import 类 + 会自动执行那个模块的顶层代码
- `__name__ == "__main__"` = "这个文件是被直接运行的，不是被 import 的"——≈ 把 main 方法收进一个 if，防止别人 import 时误启动

## 3. "看着怪、其实简单"速查

| 写法 | 意思 | Java 直译 |
|---|---|---|
| `[t.name for t in tools]` | 列表推导式 | `tools.stream().map(t -> t.name).toList()` |
| `"继续" if plan else "结束"` | 三元表达式（顺序是反的） | `plan ? "继续" : "结束"` |
| `a or b` / `a and b` | 短路后**返回操作数本身**，不是布尔 | `d.get("x") or ""` ≈ 空值给默认 |
| `*args, **kwargs` | 可变参数 / 可变关键字参数 | `Object... args` 的加强版 |
| 函数/类第一行的 `"""..."""` | docstring（文档） | Javadoc |
| `Annotated[X, ...]` / `TypedDict` | 给类型加元信息 / 用 dict 模拟强类型结构 | 第一眼懵属正常，先跳过，阶段②再讲 |
| `dedent("""...""")` | 把多行字符串的公共缩进拍平（写提示词用） | Java 的 text block `"""` |

## 4. 自测：读懂 config.py 这 13 行就算过关

`app/config.py:51-63` 原文：

```python
@property
def mcp_servers(self) -> Dict[str, Dict[str, Any]]:
    """获取完整的 MCP 服务器配置"""
    return {
        "cls": {
            "transport": self.mcp_cls_transport,
            "url": self.mcp_cls_url,
        },
        "monitor": {
            "transport": self.mcp_monitor_transport,
            "url": self.mcp_monitor_url,
        }
    }
```

逐行翻译成 Java 习惯：

1. `@property`——只读计算属性，调用时写 `config.mcp_servers`，不加括号
2. `-> Dict[str, Dict[str, Any]]`——返回 `Map<String, Map<String, Object>>`
3. `"""..."""`——Javadoc
4. 整个 `{...}` 是 map 字面量，内层每个 `{...}` 也是
5. `self.mcp_cls_transport`——读同类另一个实例字段（值来自 .env 配置绑定）

这 13 行 = "一个根据两个字段拼出 MCP 配置 Map 的 getter"。能自己说出这句话，§1–§2 就过关了。

## 5. 环境（先知道，阶段①再动手）

```powershell
.venv\Scripts\activate        # 激活虚拟环境（≈ 每个项目自带独立的 JDK + 依赖目录）
python -c "print('hello')"    # 跑一小段代码
uv pip install -e .           # 安装依赖（≈ mvn install）
```

项目根目录已有 `.venv`，Python 3.12/3.13 都装好了，不用再装解释器。
