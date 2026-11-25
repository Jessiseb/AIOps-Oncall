"""RAG Agent 服务 - 基于 LangGraph 的智能代理

支持两种生成模型提供商（由 RAG_LLM_PROVIDER 配置切换）：
- dashscope: langchain_qwq 的 ChatQwen 原生集成（qwen 系列）
- deepseek:  标准的 ChatOpenAI + DeepSeek 官方 OpenAI 兼容 API
两者都支持流式输出。

对话上下文自动压缩：token 估算达到模型上下文窗口的
RAG_CONTEXT_COMPRESS_THRESHOLD（默认 70%）时，SummarizationMiddleware
会把较早的对话交给大模型压缩成一条摘要，最近 20 条原样保留。
"""

from typing import Annotated, Any, AsyncGenerator, Dict, Sequence

from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware
from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
)
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph.message import REMOVE_ALL_MESSAGES, add_messages
from loguru import logger
from typing_extensions import TypedDict
from langchain_openai import ChatOpenAI
from langchain_qwq import ChatQwen

from app.config import config
from app.tools import get_current_time, retrieve_knowledge
from app.agent.mcp_client import get_mcp_client_with_retry

# 阿里千问大模型和langchain集成参考： https://docs.langchain.com/oss/python/integrations/chat/qwen
# 注意：需要配置环境变量 DASHSCOPE_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 否则默认访问的是新加坡站点
# 同时也需要配置环境变量 DASHSCOPE_API_KEY=your_api_key

# 各 provider 的默认上下文窗口（tokens），用于上下文压缩的阈值计算
_PROVIDER_WINDOW_TOKENS = {
    "deepseek": 64 * 1024,   # deepseek-chat (V3) 64k
    "dashscope": 32 * 1024,  # qwen-max 32k
}


class AgentState(TypedDict):
    """Agent 状态"""
    messages: Annotated[Sequence[BaseMessage], add_messages]


class LoggingSummarizationMiddleware(SummarizationMiddleware):
    """带日志的摘要中间件 - 压缩发生时打一条 info 日志，方便观察"""

    async def abefore_model(self, state, runtime):
        messages = state.get("messages", [])
        total_tokens = self.token_counter(messages)
        result = await super().abefore_model(state, runtime)

        if result is not None:
            new_count = len(result.get("messages", []))
            logger.info(
                f"上下文压缩触发: {len(messages)} 条消息(约{total_tokens} tokens) "
                f"-> 压缩后 {new_count} 条"
            )
        return result


class RagAgentService:
    """RAG Agent 服务 - LangGraph + 可切换提供商的生成模型 + 上下文自动压缩"""

    def __init__(self, streaming: bool = True):
        """初始化 RAG Agent 服务

        Args:
            streaming: 是否启用流式输出，默认为 True
        """
        self.streaming = streaming
        self.system_prompt = self._build_system_prompt()

        # 上下文窗口（tokens）：显式配置优先，否则按 provider 取默认值
        if config.rag_context_window_tokens > 0:
            self.context_window = config.rag_context_window_tokens
        else:
            self.context_window = _PROVIDER_WINDOW_TOKENS.get("deepseek", 32 * 1024)

        # 按配置选择生成模型提供商
        self.provider = config.rag_llm_provider.lower()
        if self.provider == "deepseek":
            if not config.deepseek_api_key:
                raise ValueError(
                    "RAG_LLM_PROVIDER=deepseek 但未配置 DEEPSEEK_API_KEY，"
                    "请在 .env 中填入（申请地址 https://platform.deepseek.com/）"
                )
            self.model_name = config.deepseek_chat_model
            self.model = ChatOpenAI(
                model=self.model_name,
                api_key=config.deepseek_api_key,
                base_url=config.deepseek_base_url,
                temperature=0.7,
                streaming=streaming,
                # 显式声明上下文窗口：fraction 触发器依赖它计算 70% 阈值，
                # 不传则 profile 为 None，触发器会静默失效
                profile={"max_input_tokens": self.context_window},
            )
        else:
            # 默认走 DashScope qwen（原行为）
            self.model_name = config.rag_model
            self.context_window = config.rag_context_window_tokens or _PROVIDER_WINDOW_TOKENS["dashscope"]
            self.model = ChatQwen(
                model=self.model_name,
                api_key=config.dashscope_api_key,
                temperature=0.7,
                streaming=streaming,
                profile={"max_input_tokens": self.context_window},
            )

        # 上下文压缩中间件（开关控制）
        self.middleware = []
        if config.rag_context_compress_enabled:
            self.middleware.append(
                LoggingSummarizationMiddleware(
                    model=self.model,
                    trigger=("fraction", config.rag_context_compress_threshold),
                    keep=("messages", 20),  # 最近 20 条原样保留
                )
            )

        # 定义基础工具
        self.tools = [retrieve_knowledge, get_current_time]

        # MCP 客户端（延迟初始化，使用全局管理）
        self.mcp_tools: list = []

        # 创建内存检查点（用于会话管理）
        self.checkpointer = MemorySaver()

        # Agent 初始化（会在异步方法中完成）
        self.agent = None
        self._agent_initialized = False

        compress_state = "on" if self.middleware else "off"
        logger.info(
            f"RAG Agent 服务初始化完成 (provider={self.provider}, "
            f"model={self.model_name}, streaming={streaming}, "
            f"compress={compress_state}, window={self.context_window}t, "
            f"threshold={config.rag_context_compress_threshold})"
        )

    async def _initialize_agent(self):
        """异步初始化 Agent（包括 MCP 工具）"""
        if self._agent_initialized:
            return

        # 使用全局 MCP 客户端管理器（带重试拦截器）
        mcp_client = await get_mcp_client_with_retry()

        # 获取 MCP 工具
        mcp_tools = await mcp_client.get_tools()
        logger.info(f"成功加载 {len(mcp_tools)} 个 MCP 工具")

        # 将 MCP 工具添加到实例变量中
        self.mcp_tools = mcp_tools

        # 合并所有工具
        all_tools = self.tools + self.mcp_tools

        self.agent = create_agent(
            self.model,
            tools=all_tools,
            # 系统提示词走参数而非塞进 messages：
            # 框架在调模型前拼接，不进对话历史，不会被上下文压缩吞掉
            system_prompt=self.system_prompt,
            middleware=self.middleware,
            checkpointer=self.checkpointer,
        )

        self._agent_initialized = True


        if all_tools:
            tool_names = [tool.name if hasattr(tool, "name") else str(tool) for tool in all_tools]
            logger.info(f"可用工具列表: {', '.join(tool_names)}")

    def _build_system_prompt(self) -> str:
        """
        构建系统提示词

        注意：LangChain 框架会自动将工具信息传递给 LLM，
        因此系统提示词中无需列举具体的工具列表。

        Returns:
            str: 系统提示词
        """
        from textwrap import dedent

        return dedent("""
            你是一个专业的AI助手，能够使用多种工具来帮助用户解决问题。

            工作原则:
            1. 理解用户需求，选择合适的工具来完成任务
            2. 当需要获取实时信息或专业知识时，主动使用相关工具
            3. 基于工具返回的结果提供准确、专业的回答
            4. 如果工具无法提供足够信息，请诚实地告知用户

            回答要求:
            - 保持友好、专业的语气
            - 回答简洁明了，重点突出
            - 基于事实，不编造信息
            - 如有不确定的地方，明确说明

            请根据用户的问题，灵活使用可用工具，提供高质量的帮助。
        """).strip()

    async def query(
        self,
        question: str,
        session_id: str,
    ) -> str:
        """
        非流式处理用户问题（一次性返回完整答案）

        Args:
            question: 用户问题
            session_id: 会话ID（作为 thread_id）

        Returns:
            str: 完整答案
        """
        try:
            await self._initialize_agent()

            logger.info(f"[会话 {session_id}] RAG Agent 收到查询（非流式）: {question}")

            # 只发用户消息：系统提示词已通过 create_agent(system_prompt=) 固定注入，
            # 不再塞进 messages（否则每轮重复一条 SystemMessage，且会被压缩逻辑处理）
            messages = [HumanMessage(content=question)]

            # 构建 Agent 输入
            agent_input = {"messages": messages}

            # 配置 thread_id（用于会话持久化）
            config_dict = {
                "configurable": {
                    "thread_id": session_id
                }
            }

            result = await self.agent.ainvoke(
                input=agent_input,
                config=config_dict,
            )

            # 提取最终答案
            messages_result = result.get("messages", [])
            if messages_result:
                last_message = messages_result[-1]
                answer = last_message.content if hasattr(last_message, 'content') else str(last_message)

                # 记录工具调用
                if hasattr(last_message, "tool_calls") and last_message.tool_calls:
                    tool_names = [tc.get("name", "unknown") for tc in last_message.tool_calls]
                    logger.info(f"[会话 {session_id}] Agent 调用了工具: {tool_names}")

                logger.info(f"[会话 {session_id}] RAG Agent 查询完成（非流式）")
                return answer

            logger.warning(f"[会话 {session_id}] Agent 返回结果为空")
            return ""

        except Exception as e:
            logger.error(f"[会话 {session_id}] RAG Agent 查询失败（非流式）: {e}")
            raise

    async def query_stream(
        self,
        question: str,
        session_id: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        流式处理用户问题（逐步返回答案片段）

        Args:
            question: 用户问题
            session_id: 会话ID（作为 thread_id）

        Yields:
            Dict[str, Any]: 包含流式数据的字典
                - type: "content" | "tool_call" | "complete" | "error"
                - data: 具体内容
        """
        try:
            await self._initialize_agent()

            logger.info(f"[会话 {session_id}] RAG Agent 收到查询（流式）: {question}")

            # 只发用户消息：系统提示词由 create_agent(system_prompt=) 注入
            messages = [HumanMessage(content=question)]

            # 构建 Agent 输入
            agent_input = {"messages": messages}

            # 配置 thread_id（用于会话持久化）
            config_dict = {
                "configurable": {
                    "thread_id": session_id
                }
            }

            async for token, metadata in self.agent.astream(
                input=agent_input,
                config=config_dict,
                stream_mode="messages",
            ):
                node_name = metadata.get('langgraph_node', 'unknown') if isinstance(metadata, dict) else 'unknown'
                message_type = type(token).__name__

                if message_type in ("AIMessage", "AIMessageChunk"):
                    # 优先读 ChatQwen 特有的 content_blocks（qwen 扩展思考结构），
                    # 没有则读标准 content（ChatOpenAI / DeepSeek 走这条）。
                    # content 可能是 str（绝大多数场景）或 list[dict]（多块内容），都做兼容
                    content_blocks = getattr(token, 'content_blocks', None)
                    text_content = ""

                    if content_blocks and isinstance(content_blocks, list):
                        for block in content_blocks:
                            if isinstance(block, dict) and block.get('type') == 'text':
                                text_content += block.get('text', '')
                    elif isinstance(token.content, str):
                        text_content = token.content
                    elif isinstance(token.content, list):
                        # 标准 content 的多块形式：拼接其中 text 块
                        for block in token.content:
                            if isinstance(block, dict) and block.get('type') == 'text':
                                text_content += block.get('text', '')

                    if text_content:
                        yield {
                            "type": "content",
                            "data": text_content,
                            "node": node_name
                        }

            logger.info(f"[会话 {session_id}] RAG Agent 查询完成（流式）")
            yield {"type": "complete"}

        except Exception as e:
            logger.error(f"[会话 {session_id}] RAG Agent 查询失败（流式）: {e}")
            yield {
                "type": "error",
                "data": str(e)
            }
            raise

    def get_session_history(self, session_id: str) -> list:
        """
        获取会话历史（从 MemorySaver checkpointer 中读取）

        Args:
            session_id: 会话ID（即 thread_id）

        Returns:
            list: 消息历史列表 [{"role": "user|assistant", "content": "...", "timestamp": "..."}]
        """
        try:
            # 使用 checkpointer 的 get 方法获取最新的检查点
            config = {"configurable": {"thread_id": session_id}}

            # 获取该 thread 的最新检查点
            checkpoint_tuple = self.checkpointer.get(config)

            if not checkpoint_tuple:
                logger.info(f"获取会话历史: {session_id}, 消息数量: 0")
                return []

            # checkpoint_tuple 可能是命名元组或普通元组，安全地提取 checkpoint
            # 通常第一个元素是 checkpoint 数据
            if hasattr(checkpoint_tuple, 'checkpoint'):
                checkpoint_data = checkpoint_tuple.checkpoint  # type: ignore
            else:
                # 如果是普通元组，第一个元素是 checkpoint
                checkpoint_data = checkpoint_tuple[0] if checkpoint_tuple else {}

            # 从检查点中提取消息
            messages = checkpoint_data.get("channel_values", {}).get("messages", [])

            # 转换为前端需要的格式
            history = []
            for msg in messages:
                # 跳过系统消息
                if isinstance(msg, SystemMessage):
                    continue

                # 跳过 RemoveMessage：上下文压缩后历史里会混入这种
                # langgraph 删除指令（不是真实消息），过滤掉避免前端出现空消息
                if isinstance(msg, RemoveMessage):
                    continue

                # 摘要消息标记为 assistant（内容是"Here is a summary..."）
                role = "user" if isinstance(msg, HumanMessage) else "assistant"
                content = msg.content if hasattr(msg, 'content') else str(msg)

                # 提取时间戳（如果有的话）
                timestamp = getattr(msg, 'timestamp', None)
                if timestamp:
                    history.append({
                        "role": role,
                        "content": content,
                        "timestamp": timestamp
                    })
                else:
                    from datetime import datetime
                    history.append({
                        "role": role,
                        "content": content,
                        "timestamp": datetime.now().isoformat()
                    })

            logger.info(f"获取会话历史: {session_id}, 消息数量: {len(history)}")
            return history

        except Exception as e:
            logger.error(f"获取会话历史失败: {session_id}, 错误: {e}")
            return []

    def clear_session(self, session_id: str) -> bool:
        """
        清空会话历史（从 MemorySaver checkpointer 中删除）

        Args:
            session_id: 会话ID（即 thread_id）

        Returns:
            bool: 是否成功
        """
        try:
            # 使用 checkpointer 的 delete_thread 方法删除该 thread 的所有检查点
            self.checkpointer.delete_thread(session_id)

            logger.info(f"已清除会话历史: {session_id}")
            return True

        except Exception as e:
            logger.error(f"清空会话历史失败: {session_id}, 错误: {e}")
            return False

    async def cleanup(self):
        """清理资源"""
        try:
            logger.info("清理 RAG Agent 服务资源...")
            # MCP 客户端由全局管理器统一管理，无需手动清理
            logger.info("RAG Agent 服务资源已清理")
        except Exception as e:
            logger.error(f"清理资源失败: {e}")


# 全局单例 - 启用流式输出
rag_agent_service = RagAgentService(streaming=True)
