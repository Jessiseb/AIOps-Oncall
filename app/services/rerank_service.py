"""重排服务模块 - 基于阿里云百炼平台的 TextReRank 模型

RAG 二阶段检索：向量初排召回候选池后，用重排模型对 query 与
每条候选的语义相关性做精细打分，返回按分数降序的文档列表。

注意：本服务遵循「不降级」原则——重排失败时抛出 RuntimeError，
由调用方决定如何暴露错误，不做静默回退。
"""

from typing import Any, Dict, List

from dashscope import TextReRank
from langchain_core.documents import Document
from loguru import logger

from app.config import config


class RerankService:
    """重排服务 - 封装百炼 TextReRank API"""

    def __init__(self, api_key: str, model: str):
        """
        初始化重排服务

        Args:
            api_key: DashScope API Key
            model: 重排模型名称（百炼平台）
        """
        self.api_key = api_key
        self.model = model

    def rerank(
        self,
        query: str,
        documents: List[Document],
        top_n: int,
    ) -> List[Document]:
        """
        对候选文档按与 query 的相关性重排

        Args:
            query: 用户查询文本
            documents: 初排召回的候选文档列表
            top_n: 重排后保留的文档数量

        Returns:
            List[Document]: 按相关性分数降序排列的前 top_n 个文档，
            每个文档的 metadata 中写入 "rerank_score" 字段

        Raises:
            ValueError: documents 为空
            RuntimeError: 重排 API 调用失败或返回结构异常（不降级，直接抛出）
        """
        if not documents:
            raise ValueError("候选文档列表不能为空")

        # 候选正文（只送正文，不送 metadata，避免干扰打分）
        contents = [doc.page_content for doc in documents]

        logger.info(
            f"开始重排: model={self.model}, query='{query[:50]}...', "
            f"候选数={len(contents)}, top_n={top_n}"
        )

        try:
            response = TextReRank.call(
                api_key=self.api_key,
                model=self.model,
                query=query,
                documents=contents,
                top_n=top_n,
                return_documents=False,
            )
        except Exception as e:
            # 网络异常 / SDK 异常：不降级，直接抛出
            logger.error(f"重排 API 调用异常: {e}")
            raise RuntimeError(f"重排调用失败: {e}") from e

        # HTTP 层面的失败（SDK 200 以外会带 code/status）
        status = getattr(response, "status_code", None)
        if status is not None and status != 200:
            logger.error(f"重排 API 返回失败: status={status}, response={response}")
            raise RuntimeError(f"重排 API 返回失败: status={status}, code={getattr(response, 'code', None)}")

        results = getattr(response, "output", None) and response.output.get("results")
        if not results:
            logger.error(f"重排返回结果为空或结构异常: {response}")
            raise RuntimeError("重排返回结果为空或结构异常，无法继续（不降级）")

        # 按返回顺序（分数降序）重建文档列表，并写入 rerank_score
        reranked: List[Document] = []
        for item in results:
            index = item["index"]
            score = item["relevance_score"]
            doc = documents[index]
            # 复制 metadata 再写入，避免污染 Milvus 里的原始缓存文档
            new_doc = Document(
                page_content=doc.page_content,
                metadata={**doc.metadata, "rerank_score": round(float(score), 4)},
            )
            reranked.append(new_doc)

        score_line = ", ".join(
            f"{d.metadata['rerank_score']:.3f}" for d in reranked
        )
        logger.info(f"重排完成, 保留 {len(reranked)} 条, 分数: [{score_line}]")

        return reranked

    def is_enabled(self) -> bool:
        """重排功能是否启用（由配置决定）"""
        return config.rag_rerank_enabled


# 全局单例
rerank_service = RerankService(
    api_key=config.dashscope_api_key,
    model=config.rag_rerank_model,
)
