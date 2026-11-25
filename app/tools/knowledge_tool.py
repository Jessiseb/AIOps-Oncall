"""知识检索工具 - 从向量数据库中检索相关信息，支持二阶段重排"""

from typing import List, Tuple

from langchain_core.documents import Document
from langchain_core.tools import tool
from loguru import logger

from app.config import config
from app.services.rerank_service import rerank_service
from app.services.vector_store_manager import vector_store_manager


@tool(response_format="content_and_artifact")
def retrieve_knowledge(query: str) -> Tuple[str, List[Document]]:
    """从知识库中检索相关信息来回答问题
    
    当用户的问题涉及专业知识、文档内容或需要参考资料时，使用此工具。
    
    Args:
        query: 用户的问题或查询
        
    Returns:
        Tuple[str, List[Document]]: (格式化的上下文文本, 原始文档列表)
    """
    try:
        logger.info(f"知识检索工具被调用: query='{query}'")
        
        # 1. 初排：从向量存储召回候选池
        # 开启重排时召回 rag_candidate_k 条交给重排挑；否则按原逻辑取 rag_top_k 条
        candidate_k = config.rag_candidate_k if config.rag_rerank_enabled else config.rag_top_k

        vector_store = vector_store_manager.get_vector_store()
        retriever = vector_store.as_retriever(
            search_kwargs={"k": candidate_k}
        )
        
        docs = retriever.invoke(query)
        
        if not docs:
            logger.warning("未检索到相关文档")
            return "没有找到相关信息。", []
        
        # 2. 重排（可选）：初排候选交给重排模型精选
        if config.rag_rerank_enabled:
            docs = rerank_service.rerank(
                query=query,
                documents=docs,
                top_n=config.rag_top_k,
            )
            logger.info(f"重排后保留 {len(docs)} 条文档 (top_n={config.rag_top_k})")
        
        # 3. 格式化文档为上下文
        context = format_docs(docs)
        
        logger.info(f"检索到 {len(docs)} 个相关文档")
        return context, docs
        
    except Exception as e:
        logger.error(f"知识检索工具调用失败: {e}")
        return f"检索知识时发生错误: {str(e)}", []


def format_docs(docs: List[Document]) -> str:
    """
    格式化文档列表为上下文文本
    
    Args:
        docs: 文档列表
        
    Returns:
        str: 格式化的上下文文本
    """
    formatted_parts = []
    
    for i, doc in enumerate(docs, 1):
        # 提取元数据
        metadata = doc.metadata
        source = metadata.get("_file_name", "未知来源")
        
        # 提取标题信息 (如果有)
        headers = []
        for key in ["h1", "h2", "h3"]:
            if key in metadata and metadata[key]:
                headers.append(metadata[key])
        
        header_str = " > ".join(headers) if headers else ""
        
        # 构建格式化文本
        formatted = f"【参考资料 {i}】"
        if header_str:
            formatted += f"\n标题: {header_str}"
        formatted += f"\n来源: {source}"
        # 重排分数（开启重排时才有）
        if "rerank_score" in metadata:
            formatted += f"\n相关性: {metadata['rerank_score']}"
        formatted += f"\n内容:\n{doc.page_content}\n"
        
        formatted_parts.append(formatted)
    
    return "\n".join(formatted_parts)
