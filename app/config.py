"""配置管理模块

使用 Pydantic Settings 实现类型安全的配置管理
"""

from typing import Dict, Any
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # 应用配置
    app_name: str = "SuperBizAgent"
    app_version: str = "1.0.0"
    debug: bool = False
    host: str = "0.0.0.0"
    port: int = 9900

    # DashScope 配置
    dashscope_api_key: str = ""  # 默认空字符串，实际使用需从环境变量加载
    dashscope_model: str = "qwen-max"
    dashscope_embedding_model: str = "text-embedding-v4"  # v4 支持多种维度（默认 1024）

    # Milvus 配置
    milvus_host: str = "localhost"
    milvus_port: int = 19530
    milvus_timeout: int = 10000  # 毫秒

    # RAG 配置
    rag_top_k: int = 3
    rag_model: str = "qwen-max"  # 使用快速响应模型，不带扩展思考

    # DeepSeek 配置（OpenAI 兼容协议）
    deepseek_api_key: str = ""  # 官方平台 https://platform.deepseek.com/ 申请
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    deepseek_chat_model: str = "deepseek-chat"  # deepseek-chat(V3) / deepseek-reasoner(R1)

    # RAG 生成模型提供商：dashscope（qwen，默认）/ deepseek
    rag_llm_provider: str = "deepseek"

    # 对话上下文自动压缩（token 达窗口 70% 时用大模型压缩旧对话为摘要）
    rag_context_compress_enabled: bool = True
    rag_context_compress_threshold: float = 0.7  # 触发阈值（0~1，占模型上下文窗口比例）
    rag_context_window_tokens: int = 0  # 模型上下文窗口 tokens；0=按 provider 自动（deepseek 64k / qwen-max 32k）

    # RAG 二阶段重排配置（阿里云百炼 TextReRank）
    rag_rerank_enabled: bool = True  # 总开关；重排失败时不降级、直接报错
    rag_rerank_model: str = "gte-rerank-v2"  # 百炼平台重排模型
    rag_candidate_k: int = 10  # 初排候选池大小（召回多少条交给重排挑选）

    # 文档分块配置
    chunk_max_size: int = 800
    chunk_overlap: int = 100

    # MCP 服务配置
    mcp_cls_transport: str = "streamable-http"
    mcp_cls_url: str = "http://localhost:8003/mcp"
    mcp_monitor_transport: str = "streamable-http"
    mcp_monitor_url: str = "http://localhost:8004/mcp"

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


# 全局配置实例
config = Settings()
