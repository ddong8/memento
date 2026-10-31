"""SQLAlchemy ORM models for the Memento database."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String,
    Text, UniqueConstraint, cast, func, text,
)
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

try:
    from pgvector.sqlalchemy import HALFVEC, Vector
except ImportError:
    HALFVEC = Vector = None  # pgvector not installed — models still loadable


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# Machines (registered collector instances)
# ---------------------------------------------------------------------------
class Machine(Base):
    __tablename__ = "machines"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    collector_token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    collector_version: Mapped[str | None] = mapped_column(String(50))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Per-device secret for remote execution, minted server-side and handed to
    # the collector over its authenticated heartbeat. Separate from the sync
    # token on purpose: that one lives in a config file and rides along on
    # every upload, so a leak of it must not also hand over a shell. Nothing
    # for the operator to configure — it only exists once MEMENTO_REMOTE_EXEC
    # is on, and stays NULL otherwise.
    remote_exec_key: Mapped[str | None] = mapped_column(String(64))
    # Resident-profile injection: which tool instruction files this device should
    # carry the profile block in (chosen in the web UI, off by default), and what
    # the collector last reported writing.
    profile_targets: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    profile_status: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # What the collector last reported writing into the tools' skills folders.
    skill_status: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # How collection is going on the device, from its heartbeat: backlog, failing files, upload lag.
    collect_status: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # Set when this record was folded into another one for the same computer
    # (its device id changed); the row is kept for audit, never listed again.
    merged_into: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("machines.id"))
    # Archived / unlinked flag: unbinds the device from active list while preserving all collected docs and data.
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User | None"] = relationship()
    documents: Mapped[list[Document]] = relationship(back_populates="machine")

    __table_args__ = (
        Index("idx_machines_collector_token_hash", "collector_token_hash"),
        Index("idx_machines_user_id", "user_id"),
    )


class MachineMerge(Base):
    """Audit and backup of one device-record merge: what moved where, so it can be undone."""

    __tablename__ = "machine_merges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    from_machine_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    into_machine_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    collector_token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    # Rows re-pointed from the old record: {"documents": [...], "sync_state": [...], "device_tasks": [...]},
    # and rows left on it because the target already had the same file.
    moved: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    kept: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    merged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# Tools (AI tools known to the system)
# ---------------------------------------------------------------------------
class Tool(Base):
    __tablename__ = "tools"

    id: Mapped[str] = mapped_column(String(50), primary_key=True)  # e.g. "claude_code"
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    icon: Mapped[str | None] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(Text)
    total_files: Mapped[int] = mapped_column(Integer, default=0)
    total_size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    documents: Mapped[list[Document]] = relationship(back_populates="tool")
    projects: Mapped[list[Project]] = relationship(back_populates="tool")


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------
class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    tool_id: Mapped[str | None] = mapped_column(ForeignKey("tools.id"))
    source_path: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(String(20), default="private")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    tool: Mapped[Tool | None] = relationship(back_populates="projects")
    documents: Mapped[list[Document]] = relationship(back_populates="project")
    permissions: Mapped[list[Permission]] = relationship(back_populates="project")


# ---------------------------------------------------------------------------
# Documents (every synced file)
# ---------------------------------------------------------------------------
class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tool_id: Mapped[str] = mapped_column(ForeignKey("tools.id"), nullable=False)
    project_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("projects.id"))
    machine_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("machines.id"))

    # File identity
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    content_type: Mapped[str] = mapped_column(String(50), nullable=False)

    # Content
    title: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str | None] = mapped_column(Text)              # for files < 1MB
    content_s3_key: Mapped[str | None] = mapped_column(String(500))  # for files > 1MB
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Full-text search index: space-joined jieba tokens of title + content,
    # fed through to_tsvector('simple', ...). Populated in ingest_service.
    # Deferred: only SQL uses it, and every select(Document) used to fetch it (up to 50k tokens a row).
    content_tsv: Mapped[object | None] = mapped_column(TSVECTOR, nullable=True, deferred=True)

    # Parsed metadata (tool-specific)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)

    # Rendering (never read by the app: deferred so select(Document) doesn't fetch it)
    rendered_html: Mapped[str | None] = mapped_column(Text, deferred=True)

    # AI summary
    ai_summary: Mapped[str | None] = mapped_column(Text)
    ai_summary_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # State
    visibility: Mapped[str] = mapped_column(String(20), default="private")
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False)
    # Tracks the outcome of the embedding pipeline so failures don't silently
    # drop documents. Values: pending (just ingested), ok (embedded), failed
    # (call errored — retry candidate), skipped (too short / binary — intentional).
    embedding_status: Mapped[str] = mapped_column(String(20), default="pending")
    # Failures in a row (0 after a success); sets how long the sweep waits before retrying.
    embedding_attempts: Mapped[int] = mapped_column(Integer, default=0)
    # When the sweep last embedded the document, and when it may try again after a failure.
    embedded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    embedding_next_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Knowledge-graph extraction pipeline status. Same shape as the
    # embedding pair above. Values: pending (just ingested), ok
    # (extracted), failed (LLM errored — retry candidate via
    # tasks/knowledge_retry.py), skipped (content too short / wrong
    # category — never run). Without this, an LLM hiccup at ingest
    # time silently dropped a doc out of the knowledge graph forever.
    knowledge_status: Mapped[str] = mapped_column(String(20), default="pending")
    knowledge_attempts: Mapped[int] = mapped_column(Integer, default=0)

    # Timestamps
    source_modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tool: Mapped[Tool] = relationship(back_populates="documents")
    project: Mapped[Project | None] = relationship(back_populates="documents")
    machine: Mapped[Machine | None] = relationship(back_populates="documents")
    messages: Mapped[list[ConversationMessage]] = relationship(back_populates="document", cascade="all, delete-orphan")
    versions: Mapped[list[DocumentVersion]] = relationship(back_populates="document", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_documents_category", "category"),
        Index("idx_documents_synced_at", synced_at.desc()),
        Index("idx_documents_machine_synced", "machine_id", synced_at.desc()),
        Index("idx_documents_tool_synced", "tool_id", synced_at.desc()),
        Index("idx_documents_project_synced", "project_id", synced_at.desc()),
        Index("idx_documents_project_category", "project_id", "category"),
        Index("idx_documents_metadata_session_id", text("((metadata->>'session_id'))"), postgresql_where=text("(metadata->>'session_id') IS NOT NULL")),
        Index("idx_documents_metadata_cascade_id", text("((metadata->>'cascade_id'))"), postgresql_where=text("(metadata->>'cascade_id') IS NOT NULL")),
        # Unique per machine+tool+path
        Index("uq_documents_machine_tool_path", "machine_id", "tool_id", "relative_path", unique=True),
    )


# ---------------------------------------------------------------------------
# Conversation messages (extracted from JSONL)
# ---------------------------------------------------------------------------
class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    line_number: Mapped[int] = mapped_column(Integer, nullable=False)
    message_type: Mapped[str | None] = mapped_column(String(50))
    role: Mapped[str | None] = mapped_column(String(50))
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)
    timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    document: Mapped[Document] = relationship(back_populates="messages")

    __table_args__ = (
        Index("uq_conv_msg_doc_line", "document_id", "line_number", unique=True),
        Index("idx_conv_msg_timestamp", "timestamp"),
        Index("idx_conv_msg_doc_ts", "document_id", "timestamp"),
        # Dialogue messages index for dialogue extraction (embedding, graph, compaction) skipping tool output noise
        Index("idx_conv_msg_doc_dialogue", "document_id", "line_number", postgresql_where=text("role IN ('user', 'assistant')")),
        # The daily views count and list only real chat messages: with this index they don't read every
        # message's text (the calendar read ~350 MB per call). Created on production by hand, CONCURRENTLY.
        Index("idx_conv_msg_chat_ts", "timestamp", "document_id", postgresql_where=text(
            "role IN ('user', 'assistant') AND content NOT LIKE '[Result]%' "
            "AND content NOT LIKE '[Tool:%' AND \"timestamp\" IS NOT NULL"
        )),
    )


# The condition of idx_conv_msg_chat_ts. Queries spell it with these constants, not bound parameters:
# a prepared statement's generic plan can't tell that parameters match a partial index's condition.
CHAT_MESSAGE = text(
    "conversation_messages.role IN ('user', 'assistant') "
    "AND conversation_messages.content NOT LIKE '[Result]%' "
    "AND conversation_messages.content NOT LIKE '[Tool:%' "
    "AND conversation_messages.timestamp IS NOT NULL"
)


# ---------------------------------------------------------------------------
# Daily summaries (AI-generated)
# ---------------------------------------------------------------------------
class DailySummary(Base):
    __tablename__ = "daily_summaries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # user_id scopes the summary to its owner. Historically this table was
    # global (single AI digest per date per tool across the whole instance),
    # which leaked one user's aggregated activity to every other user.
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    summary_date: Mapped[date] = mapped_column(Date, nullable=False)
    tool_id: Mapped[str | None] = mapped_column(ForeignKey("tools.id"))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    highlights: Mapped[dict | None] = mapped_column(JSONB)
    source_document_ids: Mapped[list | None] = mapped_column(ARRAY(UUID(as_uuid=True)))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        # Uniqueness now includes user_id so each user gets their own summary.
        Index("uq_daily_summary_user_date_tool", "user_id", "summary_date", "tool_id", unique=True),
    )


# ---------------------------------------------------------------------------
# Document version history
# ---------------------------------------------------------------------------
class DocumentVersion(Base):
    __tablename__ = "document_versions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    content_delta: Mapped[str | None] = mapped_column(Text)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    document: Mapped[Document] = relationship(back_populates="versions")

    __table_args__ = (
        Index("idx_doc_versions_doc_synced", "document_id", synced_at.desc()),
    )


class ConversationMessageRemoved(Base):
    """Messages taken out of a conversation, as they were: for review, and to put back. reason "audit":
    another copy of one it holds (services/message_audit.py); "upload": its log sent again from the
    start no longer holds it (services/message_store.py)."""

    __tablename__ = "conversation_messages_removed"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)  # its id when stored
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    line_number: Mapped[int] = mapped_column(Integer, nullable=False)
    message_type: Mapped[str | None] = mapped_column(String(50))
    role: Mapped[str | None] = mapped_column(String(50))
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)
    timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    reason: Mapped[str] = mapped_column(String(50), nullable=False)

    __table_args__ = (Index("idx_conv_msg_removed_doc", "document_id"),)


class MessageAudit(Base):
    """The audit's last look at a conversation: whether its messages matched its text (services/message_audit.py)."""

    __tablename__ = "message_audit"

    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True)
    content_hash: Mapped[str | None] = mapped_column(String(64))
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    outcome: Mapped[str] = mapped_column(String(30), nullable=False)
    expected: Mapped[int] = mapped_column(Integer, default=0)
    stored: Mapped[int] = mapped_column(Integer, default=0)
    missing: Mapped[int] = mapped_column(Integer, default=0)
    duplicates: Mapped[int] = mapped_column(Integer, default=0)
    unknown: Mapped[int] = mapped_column(Integer, default=0)
    detail: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    __table_args__ = (Index("idx_message_audit_outcome", "outcome", "checked_at"),)


class DocumentPendingDelta(Base):
    """A delta waiting to be appended to a big conversation, see services/content_staging.py."""

    __tablename__ = "document_pending_deltas"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_pending_deltas_doc", "document_id", "id"),
    )


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String(255))
    avatar_url: Mapped[str | None] = mapped_column(Text)
    hashed_password: Mapped[str | None] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="pending")   # pending | viewer | admin | owner
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | active | disabled
    collector_token: Mapped[str | None] = mapped_column(String(64), unique=True)
    github_id: Mapped[str | None] = mapped_column(String(50))
    wechat_openid: Mapped[str | None] = mapped_column(String(64), unique=True)
    # Phone push settings: {"bark_url", "notify_risky", "notify_task_done"}.
    notify_settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # 24/7 Always-on agent preferences: {"enabled", "morning_brief", "evening_reflection", "quiet_hours", etc.}
    proactive_settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # Custom LLM API settings: {"custom_enabled", "provider", "base_url", "api_key", "model", "background_model", "temperature", etc.}
    llm_settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # Digital twin avatar & onboarding settings: {"is_initialized", "gender", "style", "preset_id", "nickname", "avatar_url", "custom_photo_url", "theme_color", "outfit_color", "features"}
    avatar_settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    permissions: Mapped[list[Permission]] = relationship(
        back_populates="user", foreign_keys="[Permission.user_id]",
    )


# ---------------------------------------------------------------------------
# Invite codes — enable invite-only registration
# ---------------------------------------------------------------------------
class InviteCode(Base):
    __tablename__ = "invite_codes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code: Mapped[str] = mapped_column(String(48), unique=True, nullable=False)
    max_uses: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    use_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    role_on_accept: Mapped[str] = mapped_column(String(20), default="viewer", nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# Permissions (project-level access control)
# ---------------------------------------------------------------------------
class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    project_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    tool_id: Mapped[str | None] = mapped_column(ForeignKey("tools.id"))
    permission: Mapped[str] = mapped_column(String(20), default="read")
    granted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User] = relationship(back_populates="permissions", foreign_keys=[user_id])
    project: Mapped[Project | None] = relationship(back_populates="permissions")

    __table_args__ = (
        Index("uq_permission_user_project_tool", "user_id", "project_id", "tool_id", unique=True),
    )


# ---------------------------------------------------------------------------
# Access audit log
# ---------------------------------------------------------------------------
class AccessLog(Base):
    __tablename__ = "access_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("documents.id"))
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    ip_address: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_access_logs_user", "user_id", created_at.desc()),
        Index("idx_access_logs_document", "document_id", created_at.desc()),
    )


# ---------------------------------------------------------------------------
# Sync state tracking (server-side)
# ---------------------------------------------------------------------------
class SyncState(Base):
    __tablename__ = "sync_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    machine_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("machines.id"))
    tool_id: Mapped[str | None] = mapped_column(ForeignKey("tools.id"))
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    last_hash: Mapped[str | None] = mapped_column(String(64))
    last_offset: Mapped[int] = mapped_column(BigInteger, default=0)
    # Where the last slice the collector sent ends in the file: the next one has to start there
    # (ingest_service.claim_slice). NULL when unknown (a collector from before it sent end_offset).
    last_end_offset: Mapped[int | None] = mapped_column(BigInteger)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("uq_sync_state", "machine_id", "tool_id", "relative_path", unique=True),
    )


# ---------------------------------------------------------------------------
# Document Embeddings (pgvector semantic search)
# ---------------------------------------------------------------------------
EMBEDDING_INDEX_DIM = 1024


class DocumentEmbedding(Base):
    __tablename__ = "document_embeddings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding = mapped_column(Vector(EMBEDDING_INDEX_DIM) if Vector else Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    document: Mapped[Document] = relationship()

    __table_args__ = (
        UniqueConstraint("document_id", "chunk_index", name="uq_doc_embedding_chunk"),
    )


def embedding_half():
    """The embedding at half precision: what the HNSW index is built over, so what a search orders by."""
    return cast(DocumentEmbedding.embedding, HALFVEC(EMBEDDING_INDEX_DIM))


if HALFVEC:
    # A third of the size of the full-precision index (260 MB against 787 MB on 10-28), so it stays in shared buffers
    Index(
        "idx_doc_embedding_hnsw_half",
        embedding_half().label("embedding_half"),
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding_half": "halfvec_cosine_ops"},
    )


# ---------------------------------------------------------------------------
# Knowledge Graph
# ---------------------------------------------------------------------------
class KnowledgeEntity(Base):
    __tablename__ = "knowledge_entities"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)  # project/tool/concept/person/technology
    summary: Mapped[str | None] = mapped_column(Text)
    # Same-name entities merged into this one (entity_canon): what each was before, for audit
    aliases: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]", nullable=False)
    # Set when the summary says it is gone but later conversations still use it; the summary isn't injected then
    stale_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stale_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    observations: Mapped[list[KnowledgeObservation]] = relationship(back_populates="entity", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("user_id", "name", "entity_type", name="uq_entity_user_name_type"),
        Index("idx_entity_type", "entity_type"),
    )


class KnowledgeRelation(Base):
    __tablename__ = "knowledge_relations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("knowledge_entities.id", ondelete="CASCADE"), nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("knowledge_entities.id", ondelete="CASCADE"), nullable=False)
    relation_type: Mapped[str] = mapped_column(String(50), nullable=False)  # uses/creates/depends_on/discussed_in
    strength: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    source: Mapped[KnowledgeEntity] = relationship(foreign_keys=[source_id])
    target: Mapped[KnowledgeEntity] = relationship(foreign_keys=[target_id])

    __table_args__ = (
        Index("idx_relation_source", "source_id"),
        Index("idx_relation_target", "target_id"),
    )


class KnowledgeObservation(Base):
    __tablename__ = "knowledge_observations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("knowledge_entities.id", ondelete="CASCADE"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("documents.id", ondelete="SET NULL"))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    entity: Mapped[KnowledgeEntity] = relationship(back_populates="observations")

    __table_args__ = (
        Index("idx_observation_entity", "entity_id"),
        Index("idx_observation_source_doc", "source_document_id"),
    )


# ---------------------------------------------------------------------------
# Public share links (timeline / daily report)
# ---------------------------------------------------------------------------
class ShareLink(Base):
    __tablename__ = "share_links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Opaque token exposed in the URL. 24 bytes base32 ≈ 40 chars — plenty of
    # entropy so enumeration attacks aren't useful, short enough to be
    # copy-pasteable.
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    # "timeline" → target_id is a project uuid; "daily" → target_id is a date
    # string YYYY-MM-DD. Keeps the table a single type; discriminator logic
    # lives in the API.
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    target_id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # When set, only this user (after login) may view the share; the public
    # /s/<token> page still works as the URL but the API requires auth and
    # checks the user matches. NULL = anonymous public link (legacy default).
    target_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_share_owner", "owner_user_id"),
        Index("idx_share_kind_target", "kind", "target_id"),
        Index("idx_share_target_user", "target_user_id"),
    )


class ShareView(Base):
    __tablename__ = "share_views"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    share_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("share_links.id", ondelete="CASCADE"), nullable=False)
    ip: Mapped[str | None] = mapped_column(INET)
    country: Mapped[str | None] = mapped_column(String(80))
    region: Mapped[str | None] = mapped_column(String(120))
    city: Mapped[str | None] = mapped_column(String(120))
    user_agent: Mapped[str | None] = mapped_column(Text)
    referer: Mapped[str | None] = mapped_column(Text)
    viewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_share_view_share", "share_id", "viewed_at"),
    )


# ---------------------------------------------------------------------------
# Remote task execution — server dispatches work to collectors on devices
# ---------------------------------------------------------------------------
class DeviceTask(Base):
    """A unit of work dispatched to a device's collector.

    Replaces the in-memory ``_command_queue`` in api/devices.py, which lost
    every in-flight command whenever the API process restarted — fatal for
    agent runs that take minutes, and the API runs in k3s where rolling
    updates are routine. Persisting also gives an audit trail: with remote
    execution enabled, every task that ran on a device is recorded here with
    who dispatched it and what came back.

    Status flow:
      queued -> running -> succeeded | failed | timeout
                        \\-> cancelled (aborted before or during the run)
    """

    __tablename__ = "device_tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Target device, addressed by collector_token_hash — the identifier the
    # collector already sends on every poll, and it survives a machine purge.
    device_id: Mapped[str] = mapped_column(String(128), nullable=False)
    machine_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("machines.id", ondelete="SET NULL"))
    # Who dispatched it — retained for audit even if the user is deleted.
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    # "resync"/"update" (legacy control actions), or "shell"/"agent".
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    # Action parameters, e.g. {"command": ..., "cwd": ...} or
    # {"prompt": ..., "cwd": ...}. The old queue carried only an action
    # string, so nothing could be parameterized.
    payload: Mapped[dict | None] = mapped_column(JSONB)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    exit_code: Mapped[int | None] = mapped_column(Integer)
    # Captured output, truncated collector-side before upload so a runaway
    # process cannot push an unbounded body at the server.
    stdout: Mapped[str | None] = mapped_column(Text)
    stderr: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    # Risky operations the agent performed while running this task (see risk_policy).
    alerts: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    # Steps of a structured agent run: tool calls, file changes, steers, worktree, usage.
    events: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    # The agent session the device reports it ran (a resume that found no session runs a new one),
    # so a turn saved from this row later goes on in that session
    session_id: Mapped[str | None] = mapped_column(String(128))

    # Seconds the collector may spend before killing the process.
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=300)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        # The collector's poll: "my queued tasks, oldest first".
        Index("idx_device_task_poll", "device_id", "status", "created_at"),
        Index("idx_device_task_user", "user_id", "created_at"),
        Index(
            "idx_device_tasks_user_active",
            "user_id",
            created_at.desc(),
            postgresql_where=text("status IN ('queued', 'running', 'still_running', 'pending', 'dispatched')"),
        ),
    )


# ---------------------------------------------------------------------------
# Ask Conversations (user Q&A and agent dispatch history in /ask)
# ---------------------------------------------------------------------------
class AskConversation(Base):
    __tablename__ = "ask_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="新对话")
    turns: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    device_id: Mapped[str | None] = mapped_column(String(255))
    cwd: Mapped[str | None] = mapped_column(String(500))
    config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user: Mapped["User | None"] = relationship()

    __table_args__ = (
        Index("idx_ask_conv_user_updated", "user_id", "updated_at"),
    )


# ---------------------------------------------------------------------------
# Long-Term Core Memory (L3 Semantic Memory — maps to MEMORY.md)
# ---------------------------------------------------------------------------
class UserMemory(Base):
    __tablename__ = "user_memories"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False, default="general")  # rule | architecture | preference | project | general
    key: Mapped[str] = mapped_column(String(120), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding = mapped_column(Vector(EMBEDDING_INDEX_DIM) if Vector else Text, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    source: Mapped[str] = mapped_column(String(50), default="dreaming")  # dreaming | manual | mcp
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_memories.id", ondelete="CASCADE"), nullable=True, index=True)
    tree_path: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    is_folder: Mapped[bool] = mapped_column(Boolean, default=False)
    last_recalled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    recall_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # active | dormant (unused for a long time, kept out of retrieval) | superseded
    # (a newer memory says the same or the opposite). Never deleted, for audit.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", server_default="active")
    status_reason: Mapped[str | None] = mapped_column(Text)
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_memories.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship()
    parent: Mapped["UserMemory | None"] = relationship(
        "UserMemory", remote_side=[id], backref="children", foreign_keys=[parent_id],
    )

    __table_args__ = (
        UniqueConstraint("user_id", "category", "key", name="uq_user_memory_key"),
        Index("idx_user_memory_user", "user_id", updated_at.desc()),
        Index("idx_user_memory_parent", "user_id", "parent_id"),
        Index("idx_user_memory_tree_path", "user_id", "tree_path"),
        Index(
            "idx_user_memories_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )


# ---------------------------------------------------------------------------
# Dream Journals (Audit trail of nightly & on-demand dreaming sweeps — DREAMS.md)
# ---------------------------------------------------------------------------
class DreamJournal(Base):
    __tablename__ = "dream_journals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    dream_date: Mapped[date] = mapped_column(Date, nullable=False)
    stage_metrics: Mapped[dict] = mapped_column(JSONB, default=dict)
    light_sleep_notes: Mapped[str | None] = mapped_column(Text)
    rem_reflections: Mapped[str | None] = mapped_column(Text)
    deep_consolidations: Mapped[str | None] = mapped_column(Text)
    report_markdown: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship()

    __table_args__ = (
        Index("idx_dream_journal_user_date", "user_id", "dream_date", created_at.desc()),
    )



# ---------------------------------------------------------------------------
# Resident profile — the short "about me" block injected into every AI tool
# ---------------------------------------------------------------------------
class UserProfile(Base):
    """One row per draft or published profile version.

    Nightly dreaming refreshes the single draft row; nothing reaches any AI tool
    until the user publishes it, which freezes the text under the next version
    number. Collectors only ever see the highest published version.
    """
    __tablename__ = "user_profiles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")  # draft | published
    version: Mapped[int | None] = mapped_column(Integer)  # set on publish
    content: Mapped[str] = mapped_column(Text, nullable=False)
    stats: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship()

    __table_args__ = (
        Index("idx_user_profile_user_status", "user_id", "status", version.desc()),
        UniqueConstraint("user_id", "version", name="uq_user_profile_version"),
    )


# ---------------------------------------------------------------------------
# Corrections — the times the user told an AI it got something wrong
# ---------------------------------------------------------------------------
class CorrectionTopic(Base):
    """One thing the user keeps telling AIs, e.g. "始终用中文回复".

    Found in the user's own messages within minutes, then waits for the user to
    accept it (it joins their memories and the published profile) or dismiss it.
    A topic that matches something already remembered starts out accepted.
    """

    __tablename__ = "correction_topics"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    statement: Mapped[str] = mapped_column(Text, nullable=False)  # imperative, addressed to the AI
    category: Mapped[str] = mapped_column(String(20), nullable=False, default="rule")  # communication | rule | workflow | tech
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending | accepted | dismissed
    # "global", "project:<name>" or "device:<name>": where the rule holds.
    scope: Mapped[str] = mapped_column(String(200), nullable=False, default="global", server_default="global")
    times: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    memory_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_memories.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (Index("idx_correction_topic_user_status", "user_id", "status"),)


class CorrectionEvent(Base):
    """One time the user said a topic. repeat / already_learned are as of that moment,
    which is what the repeat-correction rate is measured from."""

    __tablename__ = "correction_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    topic_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("correction_topics.id", ondelete="CASCADE"), nullable=False)
    quote: Mapped[str] = mapped_column(Text, nullable=False)
    said_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    repeat: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    already_learned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # sha1 of said_at + text: re-synced transcripts get new message ids, not new events.
    fingerprint: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "fingerprint", name="uq_correction_event_fingerprint"),
        Index("idx_correction_event_user_said", "user_id", "said_at"),
    )


# ---------------------------------------------------------------------------
# Session reviews — what each finished session taught (skills, pitfalls, todos)
# ---------------------------------------------------------------------------
class SessionReview(Base):
    """One nightly look back at a session. A session that grew a lot since its
    review (resumed later) is reviewed again."""

    __tablename__ = "session_reviews"

    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")  # done | partial | failed | chat | error
    summary: Mapped[str | None] = mapped_column(Text)
    # {"skill": slug | None, "pitfalls_new": n, "pitfalls_seen": [memory ids], "todos_new": n, "todos_done": n}
    result: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("idx_session_review_user_at", "user_id", "reviewed_at"),)


class GuardEvent(Base):
    """One time an AI tool said it was done / fixed / live and the collector's
    Stop hook judged whether it had checked (packages/daemon/src/guard.ts).
    followup marks the stop right after a block: what the AI did when sent back."""

    __tablename__ = "guard_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    machine_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("machines.id", ondelete="SET NULL"))
    tool: Mapped[str] = mapped_column(String(30), nullable=False)
    session_id: Mapped[str | None] = mapped_column(String(100))
    # verified | no_evidence | failed_check | disclosed | unread
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    followup: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    deploy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    claim: Mapped[str | None] = mapped_column(String(200))
    check: Mapped[str | None] = mapped_column(String(200))
    cwd: Mapped[str | None] = mapped_column(String(300))
    said_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("idx_guard_event_user_said", "user_id", "said_at"),)


# ---------------------------------------------------------------------------
# Skills — procedures learned from sessions, shipped to AI tools as SKILL.md
# ---------------------------------------------------------------------------
class Skill(Base):
    """A procedure that got something done in the user's own environment.

    Mined from sessions as a draft; nothing reaches any AI tool until the user
    publishes it. A later session doing the same thing again adds evidence, and
    if it changes the steps of a published skill the change waits in
    pending_update instead of silently rewriting what the user approved.
    """

    __tablename__ = "skills"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), nullable=False)  # directory and `name:`; a-z 0-9 -
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)  # when to use it — what the AI matches on
    body: Mapped[str] = mapped_column(Text, nullable=False)  # markdown steps
    project: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")  # draft | published | dismissed | retired
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # bumped on every publish
    pending_update: Mapped[dict | None] = mapped_column(JSONB)  # {"description", "body", "reason", "at"}
    evidence: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")  # [{"doc_id", "title", "tool_id", "at"}]
    times_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    edited_by_user: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    first_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "slug", name="uq_skill_user_slug"),
        Index("idx_skill_user_status", "user_id", "status"),
    )


# ---------------------------------------------------------------------------
# Todos — things the user said they'd do later, and whether they got done
# ---------------------------------------------------------------------------
class Todo(Base):
    __tablename__ = "todos"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text)
    project: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")  # open | done | dropped
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")  # voice | session | manual | mcp | agent
    evidence: Mapped[str | None] = mapped_column(Text)  # the words it came from
    source_doc_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("documents.id", ondelete="SET NULL"))
    # sha1 of the normalized title: the same todo said twice stays one row.
    fingerprint: Mapped[str] = mapped_column(String(40), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    close_evidence: Mapped[str | None] = mapped_column(Text)
    reminded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_todo_user_status", "user_id", "status", "due_at"),
        Index("idx_todo_user_fingerprint", "user_id", "fingerprint"),
    )


# ---------------------------------------------------------------------------
# Retrieval evaluation — a frozen question set per version, and each run's scores
# ---------------------------------------------------------------------------
class EvalCase(Base):
    __tablename__ = "eval_cases"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    set_version: Mapped[int] = mapped_column(Integer, nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    expected_doc_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="synthetic")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("idx_eval_case_user_set", "user_id", "set_version"),)


class EvalRun(Base):
    __tablename__ = "eval_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    set_version: Mapped[int] = mapped_column(Integer, nullable=False)
    cases: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # {"hybrid": {"hit1", "hit5", "hit10", "mrr"}, "keyword": {...}, "semantic": {...}}
    metrics: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    trigger: Mapped[str] = mapped_column(String(20), nullable=False, default="scheduled")  # scheduled | manual
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("idx_eval_run_user_at", "user_id", "created_at"),)


class LearningEval(Base):
    """One week of "does Memento learn": corrections per 100 prompts, corrections of
    rules already learned, and how often accepted rules are corrected again
    (services/learning_eval_service.py). Recomputed while late transcripts arrive."""

    __tablename__ = "learning_evals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    week: Mapped[date] = mapped_column(Date, nullable=False)  # Monday, user's local time
    metrics: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    trigger: Mapped[str] = mapped_column(String(20), nullable=False, default="scheduled")  # scheduled | manual | backfill
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (UniqueConstraint("user_id", "week", name="uq_learning_eval_user_week"),)


# ---------------------------------------------------------------------------
# 24/7 Autonomous Background Missions
# ---------------------------------------------------------------------------
class AgentMission(Base):
    """Long-running autonomous agent missions scheduled and driven 24/7."""

    __tablename__ = "agent_missions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    # queued | running | waiting_approval | paused | succeeded | failed | cancelled
    status: Mapped[str] = mapped_column(String(40), default="running", nullable=False)
    risk_level: Mapped[str] = mapped_column(String(20), default="low", nullable=False)
    current_step: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    steps: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    context: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    approval_token: Mapped[str | None] = mapped_column(String(64))
    pending_action: Mapped[dict | None] = mapped_column(JSONB)
    summary: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    last_heartbeat: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship()

    __table_args__ = (
        Index("idx_agent_missions_user_status", "user_id", "status"),
        Index("idx_agent_missions_heartbeat", "status", "last_heartbeat"),
    )


# ---------------------------------------------------------------------------
# 24/7 Life Rhythm & App Screen Time Allocation
# ---------------------------------------------------------------------------
class UserLifeRhythm(Base):
    """Daily sleep, wake-up schedule, screen time, and app usage allocation."""

    __tablename__ = "user_life_rhythms"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    log_date: Mapped[date] = mapped_column(Date, nullable=False)
    wakeup_time: Mapped[str | None] = mapped_column(String(20))     # e.g. "07:35"
    bedtime: Mapped[str | None] = mapped_column(String(20))         # e.g. "00:45"
    sleep_hours: Mapped[float | None] = mapped_column(Float)        # e.g. 6.8
    total_screen_minutes: Mapped[int] = mapped_column(Integer, default=0)
    productive_minutes: Mapped[int] = mapped_column(Integer, default=0)
    distraction_minutes: Mapped[int] = mapped_column(Integer, default=0)
    # [{"name": "VS Code", "category": "work", "minutes": 240}, {"name": "微信", "category": "social", "minutes": 90}]
    app_usages: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    # AI lifestyle & focus diagnosis
    ai_advice: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship()

    __table_args__ = (
        Index("uq_life_rhythm_user_date", "user_id", "log_date", unique=True),
    )
