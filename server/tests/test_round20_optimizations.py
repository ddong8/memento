from __future__ import annotations

import unittest
from server.db.models import (
    Document,
    DocumentEmbedding,
    DailySummary,
    KnowledgeEntity,
    AskConversation,
    UserMemory,
    UserProfile,
)


class TestRound20Optimizations(unittest.TestCase):
    def test_document_indexes_no_redundant_prefixes(self):
        """Verify redundant single-column indexes were removed in favor of composite indexes."""
        index_names = {idx.name for idx in Document.__table__.indexes}
        self.assertNotIn("idx_documents_tool", index_names)
        self.assertNotIn("idx_documents_project", index_names)
        self.assertNotIn("idx_documents_machine", index_names)
        self.assertNotIn("idx_documents_machine_tool", index_names)

        # Confirm covering indexes exist
        self.assertIn("idx_documents_tool_synced", index_names)
        self.assertIn("idx_documents_project_synced", index_names)
        self.assertIn("idx_documents_machine_synced", index_names)
        self.assertIn("uq_documents_machine_tool_path", index_names)

    def test_document_embeddings_no_redundant_doc_index(self):
        """Verify idx_doc_embedding_doc was removed as uq_doc_embedding_chunk covers document_id."""
        index_names = {idx.name for idx in DocumentEmbedding.__table__.indexes}
        self.assertNotIn("idx_doc_embedding_doc", index_names)

    def test_daily_summary_no_redundant_user_index(self):
        """Verify idx_daily_summary_user was removed as uq_daily_summary_user_date_tool covers user_id."""
        index_names = {idx.name for idx in DailySummary.__table__.indexes}
        self.assertNotIn("idx_daily_summary_user", index_names)
        self.assertIn("uq_daily_summary_user_date_tool", index_names)

    def test_knowledge_entity_no_redundant_user_index(self):
        """Verify idx_entity_user was removed as uq_entity_user_name_type covers user_id."""
        index_names = {idx.name for idx in KnowledgeEntity.__table__.indexes}
        self.assertNotIn("idx_entity_user", index_names)

    def test_ask_conversation_user_id_covered_by_composite_index(self):
        """Verify ask_conversations does not have duplicate single user_id index."""
        index_names = {idx.name for idx in AskConversation.__table__.indexes}
        self.assertNotIn("ix_ask_conversations_user_id", index_names)
        self.assertIn("idx_ask_conv_user_updated", index_names)

    def test_user_memory_no_redundant_category_index(self):
        """Verify idx_user_memory_category removed in favor of uq_user_memory_key."""
        index_names = {idx.name for idx in UserMemory.__table__.indexes}
        self.assertNotIn("idx_user_memory_category", index_names)

    def test_user_profile_no_redundant_user_index(self):
        """Verify user_profiles does not have duplicate single user_id index."""
        index_names = {idx.name for idx in UserProfile.__table__.indexes}
        self.assertNotIn("ix_user_profiles_user_id", index_names)
        self.assertIn("idx_user_profile_user_status", index_names)
