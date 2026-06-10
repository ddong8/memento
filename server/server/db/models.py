"""SQLAlchemy ORM models for the Memento database."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String,
    Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

try:
    from pgvector.sqlalchemy import Vector
except ImportError:
    Vector = None  # pgvector not installed — models still loadable


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

    user: Mapped["User | None"] = relationship()
    documents: Mapped[list[Document]] = relationship(back_populates="machine")


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
    content_tsv: Mapped[object | None] = mapped_column(TSVECTOR, nullable=True)

    # Parsed metadata (tool-specific)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)

    # Rendering
    rendered_html: Mapped[str | None] = mapped_column(Text)

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
    embedding_attempts: Mapped[int] = mapped_column(Integer, default=0)
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
        Index("idx_documents_tool", "tool_id"),
        Index("idx_documents_project", "project_id"),
        Index("idx_documents_category", "category"),
        Index("idx_documents_synced_at", synced_at.desc()),
        Index("idx_documents_machine", "machine_id"),
        Index("idx_documents_machine_tool", "machine_id", "tool_id"),
        Index("idx_documents_tool_synced", "tool_id", synced_at.desc()),
        Index("idx_documents_project_synced", "project_id", synced_at.desc()),
        Index("idx_documents_project_category", "project_id", "category"),
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
        Index("idx_conv_msg_document", "document_id", "line_number"),
        Index("uq_conv_msg_doc_line", "document_id", "line_number", unique=True),
        Index("idx_conv_msg_timestamp", "timestamp"),
        Index("idx_conv_msg_doc_ts", "document_id", "timestamp"),
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
        Index("idx_daily_summary_user", "user_id"),
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
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("uq_sync_state", "machine_id", "tool_id", "relative_path", unique=True),
    )


# ---------------------------------------------------------------------------
# Document Embeddings (pgvector semantic search)
# ---------------------------------------------------------------------------
class DocumentEmbedding(Base):
    __tablename__ = "document_embeddings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding = mapped_column(Vector(1024) if Vector else Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    document: Mapped[Document] = relationship()

    __table_args__ = (
        UniqueConstraint("document_id", "chunk_index", name="uq_doc_embedding_chunk"),
        Index("idx_doc_embedding_doc", "document_id"),
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    observations: Mapped[list[KnowledgeObservation]] = relationship(back_populates="entity", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("user_id", "name", "entity_type", name="uq_entity_user_name_type"),
        Index("idx_entity_user", "user_id"),
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
    target_id: Mapped[str] = mapped_column(String(64), nullable=False)
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
