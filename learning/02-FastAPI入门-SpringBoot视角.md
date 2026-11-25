# 02 · FastAPI 入门（Spring Boot 视角）——读懂本项目够用版

> 定位：不系统学 FastAPI，只讲**读懂 + 面试能讲**本项目 API 层所需的全部内容。
> 每个知识点附仓库出处。前置：已读 `01-python速成-Java视角.md`。
> 用法：通读一遍（20 分钟）→ 对照 §8 自测 → 阶段①跑起来后在 /docs 里亲手玩一遍。

## 1. 全局：FastAPI vs Spring Boot 一张表

| Spring Boot | FastAPI | 本项目出处 |
|---|---|---|
| `@SpringBootApplication` + 内嵌 Tomcat | `FastAPI()` 实例 + uvicorn 服务器 | `app/main.py:45` |
| `@RestController` | `APIRouter()`（路由器，再挂到 app 上） | `app/api/chat.py:14` |
| `@PostMapping("/chat")` | `@router.post("/chat")` | `app/api/chat.py:17` |
| `@GetMapping` / `@PutMapping` / `@DeleteMapping` | `@router.get/put/delete` | `app/api/health.py:13` |
| `@RequestBody UserDTO dto` | `request: ChatRequest`（参数注解类型即请求体） | `app/api/chat.py:18` |
| `@PathVariable String id` | `session_id: str`（路径参数自动同名绑定） | `app/api/chat.py:197-198` |
| `@Value` / `@ConfigurationProperties` | Pydantic `BaseSettings`（01 篇 §2.5 讲过） | `app/config.py` |
| `@ExceptionHandler` / `@ControllerAdvice` | `HTTPException` + 全局 exception handler | `app/api/chat.py:194` |
| `application.yml` | `.env` 文件 | 项目根 `.env` |
| Spring MVC 分层（Controller→Service→Repository） | api → services → core/tools（一样的思想，没有强制） | `app/` 目录结构 |
| Swagger UI（springdoc） | **内置免费** `/docs` | `http://localhost:9900/docs` |
| `@PostConstruct` / `@PreDestroy` | `lifespan` 异步上下文管理器 | `app/main.py:19-41` |
| CORS 配置类 | `CORSMiddleware` | `app/main.py:53-59` |
| 静态资源映射 | `app.mount("/static", StaticFiles(...))` | `app/main.py:69` |

**一句话总纲：FastAPI 把 Spring 靠注解 + IoC 容器干的事，全部换成了"装饰器 + 函数 + 类型注解"。没有容器、没有 Bean 扫描，import 时一切就位。**

## 2. 路由注册：一个接口的完整解剖

`app/api/chat.py:17-18`，最简单的一个接口：

```python
router = APIRouter()                          # ≈ 一个 Controller

@router.post("/chat")                         # ≈ @PostMapping("/chat")
async def chat(request: ChatRequest):         # ≈ @RequestBody ChatRequest request
    answer = await rag_agent_service.query(   # ≈ 注入的 Service 调方法
        request.question,
        session_id=request.id
    )
    return {"code": 200, ...}                 # dict 直接序列化成 JSON 响应
```

三个要点：

1. **没有依赖注入这回事**——`rag_agent_service` 是模块底部 `rag_agent_service = RagAgentService()` 造出的全局单例（跟 `config = Settings()` 同款套路）。Python 的 import 机制天然保证它只初始化一次。
2. **参数类型决定参数来源**，这是 FastAPI 最"魔法"的一点：
   - 参数注解是 **Pydantic 模型**（`request: ChatRequest`）→ 自动从请求体反序列化 + 校验
   - 参数直接写 `session_id: str` 且路径里有 `{session_id}`（chat.py:197）→ 自动绑定路径变量
   - 参数写 `q: str = Query(...)` → 查询参数；`file: UploadFile = File(...)`（file.py）→ 文件
3. **返回值**:返回 dict / Pydantic 模型都自动转 JSON；要控制状态码就返回 `JSONResponse`（health.py:57）或抛 `HTTPException`。

**路由汇总**：每个文件一个 `APIRouter`，最后在 `main.py:62-65` 统一挂载：

```python
app.include_router(chat.router, prefix="/api", tags=["对话"])
# 最终路径 = prefix + 装饰器路径 = /api/chat
```

## 3. 请求模型：Pydantic 就是 DTO + 校验器

`app/models/request.py:9-22`：

```python
class ChatRequest(BaseModel):
    id: str = Field(..., description="会话 ID", alias="Id")
    question: str = Field(..., description="用户问题", alias="Question")

    class Config:
        populate_by_name = True
        json_schema_extra = {"example": {"Id": "session-123", "Question": "..."}}
```

逐条拆：

- `Field(...)`：`...` 是 Python 的 Ellipsis，约定俗成表示"必填"。写默认值就是可选字段
- `alias="Id"`：JSON 字段叫 `Id`，Python 字段叫 `id`——因为前端传的是大写开头的老字段名
- `populate_by_name = True`：既接受 `Id` 也接受 `id`
- `json_schema_extra`：给 Swagger 文档塞示例

**校验是自动的**：请求体缺 `Question` 或类型不对，FastAPI 直接回 422 + 错误明细，你的函数一行都不用写。≈ Bean Validation 但零注解——类型注解本身就是校验规则。

## 4. 错误处理：两种姿势

姿势一：**抛异常**（`chat.py:194`）：

```python
raise HTTPException(status_code=500, detail=str(e))   # ≈ ResponseStatusException
```

姿势二：**正常返回带错误码的 JSON**（`chat.py:45-53`，业务错误约定 code 字段，HTTP 永远 200）：

```python
return {"code": 500, "message": "error", "data": {...}}
```

这个项目两种混用（本身是个可以点评的点——面试聊"你会怎么改进"时可以说：统一错误处理应该收敛到全局 exception handler，而不是每个接口 try-catch 返回 code 500）。

## 5. 生命周期与中间件

**lifespan**（`main.py:19-41`）——你已经认识 yield 了，现在能看懂它的机关：

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    milvus_manager.connect()   # yield 之前 = 启动逻辑（≈ @PostConstruct）
    yield                      # ← 服务运行期间停在这里
    milvus_manager.close()     # yield 之后 = 关闭逻辑（≈ @PreDestroy）
```

整个 FastAPI 的 lifespan 就是用**你刚学的生成器**实现的：yield 前后把生命周期切成两半。这是 yield 知识点的完美回收。

**CORS 中间件**（`main.py:53-59`）：

```python
app.add_middleware(CORSMiddleware, allow_origins=["*"], ...)
```

≈ Spring 的 `CorsFilter` / `WebMvcConfigurer.addCorsMappings`。注意这个项目 `allow_origins=["*"]` 全开——是项目六大短板之一，面试官问"有什么不足"时的标准素材。

## 5.5 SSE：本项目的流式输出方案（面试高频）

普通接口：请求 → 算完 → 一次性返回。但 LLM 生成要几十秒，用户不能干等。

**SSE（Server-Sent Events）**：HTTP 长连接上，服务器一块一块推 `data: {...}\n\n` 格式的事件，浏览器原生支持（`EventSource` / fetch 流读取）。比 WebSocket 轻——单向推送够用，不需要双向。

项目实现（`chat.py:68-169`）三层配合：

```python
@router.post("/chat_stream")
async def chat_stream(request: ChatRequest):
    async def event_generator():                    # ① 内层：async 生成器（yield 逐块吐）
        async for chunk in rag_agent_service.query_stream(...):
            yield {"event": "message", "data": json.dumps({...})}

    return EventSourceResponse(event_generator())   # ② sse-starlette 库把生成器包成 SSE 响应
```

- ① 你已经懂了：**生成器 + async = 可暂停的流**（01 篇 §2.8/§2.9 合体）
- ② `EventSourceResponse` 拿着这个"遥控器"，客户端每 ready 一点就拉一点，拉到的就是 SSE 事件
- ③ 前端 `static/app.js` 用 fetch 逐块读响应流、边收边渲染

**面试一句话**："我们用 SSE + async 生成器实现流式输出——后端 LLM 每生成一块就 yield 一块，FastAPI 通过 EventSourceResponse 推给前端，用户看到打字机效果而不是等几十秒。选 SSE 不选 WebSocket 是因为只需要服务器单向推送。"

## 6. 三层如何串起来（以一次提问为例）

```
POST /api/chat  {"Id":"s1","Question":"CPU打满怎么排查"}
  │
  ├─ main.py    include_router 挂载的 chat 路由命中
  ├─ chat.py:18 FastAPI 把 JSON 反序列化成 ChatRequest（自动校验）
  ├─ chat.py:38 await rag_agent_service.query(...)     ← 全局单例，无注入
  ├─ rag_agent_service.py  千问决策 → 调 retrieve_knowledge 工具
  │                         → Milvus 检索 top3 → 千问生成答案
  └─ chat.py:45 return dict → 自动转 JSON 响应
```

对照 Spring：`Controller → Service → (工具/DAO)`，一层不多一层不少。**你不需要学新思想，只需要认新写法。**

## 7. 前端交互与 /docs（跑通后必玩）

- Web 界面：`http://localhost:9900`（static/ 下的纯静态页面）
- **Swagger UI：`http://localhost:9900/docs`** ← 自动生成的交互式文档，每个接口能直接填参数发请求。跑通项目后第一件事就是打开它，把 5 个核心接口挨个点一遍——比读代码更快建立手感

## 8. 自测三题（能答出来就过关）

1. `request: ChatRequest` 里 FastAPI 是怎么知道要从请求体取数的？（提示：§2 要点 2）
2. `main.py` 的 `lifespan` 里那个 `yield` 起什么作用？如果删掉它会怎样？
3. 项目里 `/chat_stream` 为什么用 SSE 而不是 WebSocket？为什么用生成器而不是一次性拼好大字符串返回？

（答案都在文中，答不出回对应小节再看一眼。）

## 9. 环境速查（阶段①要用）

```powershell
cd D:\学习笔记\训练营\OnCall\super_biz_agent_py-release-2026-03-21
.venv\Scripts\activate          # 激活虚拟环境
python -m uvicorn app.main:app --host 0.0.0.0 --port 9900   # 启动（≈ mvn spring-boot:run）
```

注意 `app.main:app` 的意思：`app/main.py` 文件里的 `app` 变量——"模块路径:实例名"，≈ Spring 里指定主类。
