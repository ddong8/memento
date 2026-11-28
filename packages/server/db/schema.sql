--
-- PostgreSQL database dump
--

\restrict vthCywG1RrO8U03xU3N914uMUZJYIUt45ejvCQkm0XcBO1Gg4cHPxQhSziTVLP2

-- Dumped from database version 16.16 (Debian 16.16-1.pgdg12+1)
-- Dumped by pg_dump version 16.16 (Debian 16.16-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_logs (
    id bigint NOT NULL,
    user_id uuid,
    document_id uuid,
    action character varying(50) NOT NULL,
    ip_address character varying(45),
    user_agent text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: access_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.access_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: access_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.access_logs_id_seq OWNED BY public.access_logs.id;


--
-- Name: agent_missions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_missions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    goal text NOT NULL,
    status character varying(40) NOT NULL,
    risk_level character varying(20) NOT NULL,
    current_step integer NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    approval_token character varying(64),
    pending_action jsonb,
    summary text,
    error text,
    last_heartbeat timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_plans (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    goal text NOT NULL,
    status character varying(40) NOT NULL,
    auto_start boolean NOT NULL,
    cwd text,
    source_device_id character varying(255),
    project_id character varying(64),
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    plan_note text,
    summary text,
    error text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ask_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ask_conversations (
    id uuid NOT NULL,
    user_id uuid,
    title character varying(500) NOT NULL,
    turns jsonb NOT NULL,
    message_count integer DEFAULT 0 NOT NULL,
    device_id character varying(255),
    cwd character varying(500),
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_messages (
    id bigint NOT NULL,
    document_id uuid NOT NULL,
    line_number integer NOT NULL,
    message_type character varying(50),
    role character varying(50),
    content text NOT NULL,
    metadata jsonb NOT NULL,
    "timestamp" timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_messages_id_seq OWNED BY public.conversation_messages.id;


--
-- Name: conversation_messages_removed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_messages_removed (
    id bigint NOT NULL,
    document_id uuid NOT NULL,
    line_number integer NOT NULL,
    message_type character varying(50),
    role character varying(50),
    content text NOT NULL,
    metadata jsonb NOT NULL,
    "timestamp" timestamp with time zone,
    created_at timestamp with time zone,
    removed_at timestamp with time zone DEFAULT now() NOT NULL,
    reason character varying(50) NOT NULL
);


--
-- Name: correction_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.correction_events (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    topic_id uuid NOT NULL,
    quote text NOT NULL,
    said_at timestamp with time zone NOT NULL,
    repeat boolean NOT NULL,
    already_learned boolean NOT NULL,
    fingerprint character varying(40) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: correction_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.correction_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: correction_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.correction_events_id_seq OWNED BY public.correction_events.id;


--
-- Name: correction_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.correction_topics (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    statement text NOT NULL,
    category character varying(20) NOT NULL,
    status character varying(20) NOT NULL,
    scope character varying(200) DEFAULT 'global'::character varying NOT NULL,
    times integer NOT NULL,
    first_at timestamp with time zone,
    last_at timestamp with time zone,
    accepted_at timestamp with time zone,
    memory_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_summaries (
    id uuid NOT NULL,
    user_id uuid,
    summary_date date NOT NULL,
    tool_id character varying(50),
    title text NOT NULL,
    summary text NOT NULL,
    highlights jsonb,
    source_document_ids uuid[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_tasks (
    id uuid NOT NULL,
    device_id character varying(128) NOT NULL,
    machine_id uuid,
    user_id uuid,
    action character varying(40) NOT NULL,
    payload jsonb,
    status character varying(20) NOT NULL,
    exit_code integer,
    stdout text,
    stderr text,
    error text,
    alerts jsonb DEFAULT '[]'::jsonb NOT NULL,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    session_id character varying(128),
    timeout_seconds integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    finished_at timestamp with time zone
);


--
-- Name: document_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_embeddings (
    id uuid NOT NULL,
    document_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    chunk_text text NOT NULL,
    embedding public.halfvec(1024) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_pending_deltas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_pending_deltas (
    id bigint NOT NULL,
    document_id uuid NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_pending_deltas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_pending_deltas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_pending_deltas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_pending_deltas_id_seq OWNED BY public.document_pending_deltas.id;


--
-- Name: document_search; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_search (
    document_id uuid NOT NULL,
    content_tsv tsvector NOT NULL
);


--
-- Name: document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versions (
    id bigint NOT NULL,
    document_id uuid NOT NULL,
    content_hash character varying(64) NOT NULL,
    content_delta text,
    file_size_bytes bigint,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_versions_id_seq OWNED BY public.document_versions.id;


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid NOT NULL,
    tool_id character varying(50) NOT NULL,
    project_id uuid,
    machine_id uuid,
    relative_path text NOT NULL,
    category character varying(50) NOT NULL,
    content_type character varying(50) NOT NULL,
    title text,
    content text,
    content_s3_key character varying(500),
    content_hash character varying(64) NOT NULL,
    file_size_bytes bigint NOT NULL,
    metadata jsonb NOT NULL,
    rendered_html text,
    ai_summary text,
    ai_summary_generated_at timestamp with time zone,
    visibility character varying(20) NOT NULL,
    needs_review boolean NOT NULL,
    embedding_status character varying(20) NOT NULL,
    embedding_attempts integer NOT NULL,
    embedded_at timestamp with time zone,
    embedding_next_at timestamp with time zone,
    knowledge_status character varying(20) NOT NULL,
    knowledge_attempts integer NOT NULL,
    source_modified_at timestamp with time zone,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dream_journals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dream_journals (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    dream_date date NOT NULL,
    stage_metrics jsonb NOT NULL,
    light_sleep_notes text,
    rem_reflections text,
    deep_consolidations text,
    report_markdown text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eval_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_cases (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    set_version integer NOT NULL,
    query text NOT NULL,
    expected_doc_id uuid NOT NULL,
    evidence text,
    kind character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eval_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.eval_cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: eval_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.eval_cases_id_seq OWNED BY public.eval_cases.id;


--
-- Name: eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_runs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    set_version integer NOT NULL,
    cases integer NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    trigger character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guard_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guard_events (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    machine_id uuid,
    tool character varying(30) NOT NULL,
    session_id character varying(100),
    outcome character varying(20) NOT NULL,
    blocked boolean NOT NULL,
    followup boolean NOT NULL,
    deploy boolean NOT NULL,
    claim character varying(200),
    "check" character varying(200),
    cwd character varying(300),
    said_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guard_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.guard_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: guard_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.guard_events_id_seq OWNED BY public.guard_events.id;


--
-- Name: invite_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_codes (
    id uuid NOT NULL,
    code character varying(48) NOT NULL,
    max_uses integer NOT NULL,
    use_count integer NOT NULL,
    expires_at timestamp with time zone,
    role_on_accept character varying(20) NOT NULL,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_entities (
    id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    entity_type character varying(50) NOT NULL,
    summary text,
    aliases jsonb DEFAULT '[]'::jsonb NOT NULL,
    stale_at timestamp with time zone,
    stale_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_observations (
    id uuid NOT NULL,
    entity_id uuid NOT NULL,
    content text NOT NULL,
    source_document_id uuid,
    observed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_relations (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    target_id uuid NOT NULL,
    relation_type character varying(50) NOT NULL,
    strength double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: learning_evals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learning_evals (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    week date NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    trigger character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: machine_merges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine_merges (
    id integer NOT NULL,
    from_machine_id uuid NOT NULL,
    into_machine_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    collector_token_hash character varying(255) NOT NULL,
    moved jsonb DEFAULT '{}'::jsonb NOT NULL,
    kept jsonb DEFAULT '{}'::jsonb NOT NULL,
    merged_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: machine_merges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.machine_merges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: machine_merges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.machine_merges_id_seq OWNED BY public.machine_merges.id;


--
-- Name: machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machines (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    collector_token_hash character varying(255) NOT NULL,
    collector_version character varying(50),
    user_id uuid,
    last_heartbeat timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    remote_exec_key character varying(64),
    profile_targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    profile_targets_off jsonb DEFAULT '[]'::jsonb NOT NULL,
    profile_status jsonb DEFAULT '{}'::jsonb NOT NULL,
    skill_status jsonb DEFAULT '{}'::jsonb NOT NULL,
    collect_status jsonb DEFAULT '{}'::jsonb NOT NULL,
    merged_into uuid,
    is_archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: message_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_audit (
    document_id uuid NOT NULL,
    content_hash character varying(64),
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome character varying(30) NOT NULL,
    expected integer NOT NULL,
    stored integer NOT NULL,
    missing integer NOT NULL,
    duplicates integer NOT NULL,
    unknown integer NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id uuid,
    tool_id character varying(50),
    permission character varying(20) NOT NULL,
    granted_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid NOT NULL,
    slug character varying(255) NOT NULL,
    title character varying(500) NOT NULL,
    tool_id character varying(50),
    source_path text,
    visibility character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduled_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_tasks (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(200) NOT NULL,
    device character varying(255) NOT NULL,
    agent character varying(40) NOT NULL,
    prompt text NOT NULL,
    cwd text,
    permission_mode character varying(20) DEFAULT 'full'::character varying NOT NULL,
    schedule character varying(40) NOT NULL,
    tz_offset_min integer DEFAULT 480 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_task_id uuid,
    last_status character varying(20),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying(64) NOT NULL,
    applied_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: session_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_reviews (
    document_id uuid NOT NULL,
    user_id uuid NOT NULL,
    message_count integer NOT NULL,
    outcome character varying(20) NOT NULL,
    summary text,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: share_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.share_links (
    id uuid NOT NULL,
    token character varying(64) NOT NULL,
    kind character varying(20) NOT NULL,
    target_id text NOT NULL,
    owner_user_id uuid NOT NULL,
    target_user_id uuid,
    title text,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: share_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.share_views (
    id bigint NOT NULL,
    share_id uuid NOT NULL,
    ip inet,
    country character varying(80),
    region character varying(120),
    city character varying(120),
    user_agent text,
    referer text,
    viewed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: share_views_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.share_views_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: share_views_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.share_views_id_seq OWNED BY public.share_views.id;


--
-- Name: skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skills (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    slug character varying(64) NOT NULL,
    title character varying(120) NOT NULL,
    description text NOT NULL,
    body text NOT NULL,
    project character varying(120),
    status character varying(20) NOT NULL,
    version integer NOT NULL,
    pending_update jsonb,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    times_seen integer NOT NULL,
    edited_by_user boolean NOT NULL,
    first_seen_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_state (
    id integer NOT NULL,
    machine_id uuid,
    tool_id character varying(50),
    relative_path text NOT NULL,
    last_hash character varying(64),
    last_offset bigint NOT NULL,
    last_end_offset bigint,
    excluded_project character varying(255),
    last_synced_at timestamp with time zone
);


--
-- Name: sync_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sync_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sync_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sync_state_id_seq OWNED BY public.sync_state.id;


--
-- Name: todos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.todos (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(200) NOT NULL,
    detail text,
    project character varying(120),
    status character varying(20) NOT NULL,
    due_at timestamp with time zone,
    source character varying(20) NOT NULL,
    evidence text,
    source_doc_id uuid,
    fingerprint character varying(40) NOT NULL,
    closed_at timestamp with time zone,
    close_evidence text,
    reminded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tools (
    id character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    icon character varying(50),
    description text,
    total_files integer NOT NULL,
    total_size_bytes bigint NOT NULL,
    last_sync_at timestamp with time zone
);


--
-- Name: user_life_rhythms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_life_rhythms (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    log_date date NOT NULL,
    wakeup_time character varying(20),
    bedtime character varying(20),
    sleep_hours double precision,
    total_screen_minutes integer NOT NULL,
    productive_minutes integer NOT NULL,
    distraction_minutes integer NOT NULL,
    app_usages jsonb DEFAULT '[]'::jsonb NOT NULL,
    ai_advice text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_memories (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    category character varying(50) NOT NULL,
    key character varying(120) NOT NULL,
    content text NOT NULL,
    embedding public.vector(1024),
    confidence double precision NOT NULL,
    source character varying(50) NOT NULL,
    parent_id uuid,
    tree_path character varying(255),
    is_folder boolean NOT NULL,
    last_recalled_at timestamp with time zone,
    recall_count integer DEFAULT 0 NOT NULL,
    feedback_pos integer DEFAULT 0 NOT NULL,
    feedback_neg integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    status_reason text,
    superseded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    status character varying(20) NOT NULL,
    version integer,
    content text NOT NULL,
    stats jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email character varying(320) NOT NULL,
    name character varying(255),
    avatar_url text,
    hashed_password character varying(255),
    role character varying(20) NOT NULL,
    status character varying(20) NOT NULL,
    collector_token character varying(64),
    github_id character varying(50),
    wechat_openid character varying(64),
    oidc_subject character varying(512),
    notify_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    proactive_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    llm_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    avatar_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    collect_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    plugin_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: access_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_logs ALTER COLUMN id SET DEFAULT nextval('public.access_logs_id_seq'::regclass);


--
-- Name: conversation_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_messages ALTER COLUMN id SET DEFAULT nextval('public.conversation_messages_id_seq'::regclass);


--
-- Name: correction_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_events ALTER COLUMN id SET DEFAULT nextval('public.correction_events_id_seq'::regclass);


--
-- Name: document_pending_deltas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_pending_deltas ALTER COLUMN id SET DEFAULT nextval('public.document_pending_deltas_id_seq'::regclass);


--
-- Name: document_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions ALTER COLUMN id SET DEFAULT nextval('public.document_versions_id_seq'::regclass);


--
-- Name: eval_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_cases ALTER COLUMN id SET DEFAULT nextval('public.eval_cases_id_seq'::regclass);


--
-- Name: guard_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guard_events ALTER COLUMN id SET DEFAULT nextval('public.guard_events_id_seq'::regclass);


--
-- Name: machine_merges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_merges ALTER COLUMN id SET DEFAULT nextval('public.machine_merges_id_seq'::regclass);


--
-- Name: share_views id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_views ALTER COLUMN id SET DEFAULT nextval('public.share_views_id_seq'::regclass);


--
-- Name: sync_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state ALTER COLUMN id SET DEFAULT nextval('public.sync_state_id_seq'::regclass);


--
-- Name: access_logs access_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_logs
    ADD CONSTRAINT access_logs_pkey PRIMARY KEY (id);


--
-- Name: agent_missions agent_missions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_missions
    ADD CONSTRAINT agent_missions_pkey PRIMARY KEY (id);


--
-- Name: agent_plans agent_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plans
    ADD CONSTRAINT agent_plans_pkey PRIMARY KEY (id);


--
-- Name: ask_conversations ask_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ask_conversations
    ADD CONSTRAINT ask_conversations_pkey PRIMARY KEY (id);


--
-- Name: conversation_messages conversation_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_messages
    ADD CONSTRAINT conversation_messages_pkey PRIMARY KEY (id);


--
-- Name: conversation_messages_removed conversation_messages_removed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_messages_removed
    ADD CONSTRAINT conversation_messages_removed_pkey PRIMARY KEY (id);


--
-- Name: correction_events correction_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_events
    ADD CONSTRAINT correction_events_pkey PRIMARY KEY (id);


--
-- Name: correction_topics correction_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_topics
    ADD CONSTRAINT correction_topics_pkey PRIMARY KEY (id);


--
-- Name: daily_summaries daily_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_summaries
    ADD CONSTRAINT daily_summaries_pkey PRIMARY KEY (id);


--
-- Name: device_tasks device_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tasks
    ADD CONSTRAINT device_tasks_pkey PRIMARY KEY (id);


--
-- Name: document_embeddings document_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeddings
    ADD CONSTRAINT document_embeddings_pkey PRIMARY KEY (id);


--
-- Name: document_pending_deltas document_pending_deltas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_pending_deltas
    ADD CONSTRAINT document_pending_deltas_pkey PRIMARY KEY (id);


--
-- Name: document_search document_search_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_search
    ADD CONSTRAINT document_search_pkey PRIMARY KEY (document_id);


--
-- Name: document_versions document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: dream_journals dream_journals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dream_journals
    ADD CONSTRAINT dream_journals_pkey PRIMARY KEY (id);


--
-- Name: eval_cases eval_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_cases
    ADD CONSTRAINT eval_cases_pkey PRIMARY KEY (id);


--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);


--
-- Name: guard_events guard_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guard_events
    ADD CONSTRAINT guard_events_pkey PRIMARY KEY (id);


--
-- Name: invite_codes invite_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_code_key UNIQUE (code);


--
-- Name: invite_codes invite_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_pkey PRIMARY KEY (id);


--
-- Name: knowledge_entities knowledge_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_entities
    ADD CONSTRAINT knowledge_entities_pkey PRIMARY KEY (id);


--
-- Name: knowledge_observations knowledge_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_observations
    ADD CONSTRAINT knowledge_observations_pkey PRIMARY KEY (id);


--
-- Name: knowledge_relations knowledge_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_relations
    ADD CONSTRAINT knowledge_relations_pkey PRIMARY KEY (id);


--
-- Name: learning_evals learning_evals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_evals
    ADD CONSTRAINT learning_evals_pkey PRIMARY KEY (id);


--
-- Name: machine_merges machine_merges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_merges
    ADD CONSTRAINT machine_merges_pkey PRIMARY KEY (id);


--
-- Name: machines machines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_pkey PRIMARY KEY (id);


--
-- Name: message_audit message_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_audit
    ADD CONSTRAINT message_audit_pkey PRIMARY KEY (document_id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_slug_key UNIQUE (slug);


--
-- Name: scheduled_tasks scheduled_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session_reviews session_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_reviews
    ADD CONSTRAINT session_reviews_pkey PRIMARY KEY (document_id);


--
-- Name: share_links share_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_pkey PRIMARY KEY (id);


--
-- Name: share_links share_links_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_token_key UNIQUE (token);


--
-- Name: share_views share_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_views
    ADD CONSTRAINT share_views_pkey PRIMARY KEY (id);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (id);


--
-- Name: todos todos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.todos
    ADD CONSTRAINT todos_pkey PRIMARY KEY (id);


--
-- Name: tools tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (id);


--
-- Name: correction_events uq_correction_event_fingerprint; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_events
    ADD CONSTRAINT uq_correction_event_fingerprint UNIQUE (user_id, fingerprint);


--
-- Name: document_embeddings uq_doc_embedding_chunk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeddings
    ADD CONSTRAINT uq_doc_embedding_chunk UNIQUE (document_id, chunk_index);


--
-- Name: knowledge_entities uq_entity_user_name_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_entities
    ADD CONSTRAINT uq_entity_user_name_type UNIQUE (user_id, name, entity_type);


--
-- Name: learning_evals uq_learning_eval_user_week; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_evals
    ADD CONSTRAINT uq_learning_eval_user_week UNIQUE (user_id, week);


--
-- Name: skills uq_skill_user_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT uq_skill_user_slug UNIQUE (user_id, slug);


--
-- Name: user_memories uq_user_memory_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT uq_user_memory_key UNIQUE (user_id, category, key);


--
-- Name: user_profiles uq_user_profile_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT uq_user_profile_version UNIQUE (user_id, version);


--
-- Name: user_life_rhythms user_life_rhythms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_life_rhythms
    ADD CONSTRAINT user_life_rhythms_pkey PRIMARY KEY (id);


--
-- Name: user_memories user_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_pkey PRIMARY KEY (id);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);


--
-- Name: users users_collector_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_collector_token_key UNIQUE (collector_token);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_wechat_openid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_wechat_openid_key UNIQUE (wechat_openid);


--
-- Name: idx_access_logs_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_logs_document ON public.access_logs USING btree (document_id, created_at DESC);


--
-- Name: idx_access_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_logs_user ON public.access_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_agent_missions_heartbeat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_missions_heartbeat ON public.agent_missions USING btree (status, last_heartbeat);


--
-- Name: idx_agent_missions_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_missions_user_status ON public.agent_missions USING btree (user_id, status);


--
-- Name: idx_agent_plans_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_plans_status ON public.agent_plans USING btree (status);


--
-- Name: idx_agent_plans_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_plans_user_created ON public.agent_plans USING btree (user_id, created_at);


--
-- Name: idx_ask_conv_user_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ask_conv_user_device ON public.ask_conversations USING btree (user_id, device_id, updated_at);


--
-- Name: idx_ask_conv_user_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ask_conv_user_updated ON public.ask_conversations USING btree (user_id, updated_at);


--
-- Name: idx_conv_msg_chat_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_msg_chat_ts ON public.conversation_messages USING btree ("timestamp", document_id) WHERE (((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying])::text[])) AND (content !~~ '[Result]%'::text) AND (content !~~ '[Tool:%'::text) AND ("timestamp" IS NOT NULL));


--
-- Name: idx_conv_msg_doc_dialogue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_msg_doc_dialogue ON public.conversation_messages USING btree (document_id, line_number) WHERE ((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying])::text[]));


--
-- Name: idx_conv_msg_doc_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_msg_doc_ts ON public.conversation_messages USING btree (document_id, "timestamp");


--
-- Name: idx_conv_msg_removed_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_msg_removed_doc ON public.conversation_messages_removed USING btree (document_id);


--
-- Name: idx_conv_msg_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_msg_timestamp ON public.conversation_messages USING btree ("timestamp");


--
-- Name: idx_correction_event_user_said; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_correction_event_user_said ON public.correction_events USING btree (user_id, said_at);


--
-- Name: idx_correction_topic_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_correction_topic_user_status ON public.correction_topics USING btree (user_id, status);


--
-- Name: idx_device_task_poll; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_task_poll ON public.device_tasks USING btree (device_id, status, created_at);


--
-- Name: idx_device_task_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_task_user ON public.device_tasks USING btree (user_id, created_at);


--
-- Name: idx_device_tasks_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_tasks_user_active ON public.device_tasks USING btree (user_id, created_at DESC) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'still_running'::character varying, 'pending'::character varying, 'dispatched'::character varying])::text[]));


--
-- Name: idx_doc_embedding_hnsw_half; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_embedding_hnsw_half ON public.document_embeddings USING hnsw (embedding public.halfvec_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_doc_versions_doc_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_versions_doc_synced ON public.document_versions USING btree (document_id, synced_at DESC);


--
-- Name: idx_document_search_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_search_tsv ON public.document_search USING gin (content_tsv);


--
-- Name: idx_documents_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_category ON public.documents USING btree (category);


--
-- Name: idx_documents_machine_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_machine_synced ON public.documents USING btree (machine_id, synced_at DESC);


--
-- Name: idx_documents_metadata_cascade_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_metadata_cascade_id ON public.documents USING btree (((metadata ->> 'cascade_id'::text))) WHERE ((metadata ->> 'cascade_id'::text) IS NOT NULL);


--
-- Name: idx_documents_metadata_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_metadata_session_id ON public.documents USING btree (((metadata ->> 'session_id'::text))) WHERE ((metadata ->> 'session_id'::text) IS NOT NULL);


--
-- Name: idx_documents_project_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_project_category ON public.documents USING btree (project_id, category);


--
-- Name: idx_documents_project_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_project_synced ON public.documents USING btree (project_id, synced_at DESC);


--
-- Name: idx_documents_synced_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_synced_at ON public.documents USING btree (synced_at DESC);


--
-- Name: idx_documents_tool_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_tool_synced ON public.documents USING btree (tool_id, synced_at DESC);


--
-- Name: idx_dream_journal_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dream_journal_user_date ON public.dream_journals USING btree (user_id, dream_date, created_at DESC);


--
-- Name: idx_entity_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_type ON public.knowledge_entities USING btree (entity_type);


--
-- Name: idx_eval_case_user_set; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eval_case_user_set ON public.eval_cases USING btree (user_id, set_version);


--
-- Name: idx_eval_run_user_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eval_run_user_at ON public.eval_runs USING btree (user_id, created_at);


--
-- Name: idx_guard_event_user_said; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guard_event_user_said ON public.guard_events USING btree (user_id, said_at);


--
-- Name: idx_machines_collector_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_machines_collector_token_hash ON public.machines USING btree (collector_token_hash);


--
-- Name: idx_machines_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_machines_user_id ON public.machines USING btree (user_id);


--
-- Name: idx_message_audit_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_audit_outcome ON public.message_audit USING btree (outcome, checked_at);


--
-- Name: idx_observation_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observation_entity ON public.knowledge_observations USING btree (entity_id);


--
-- Name: idx_observation_source_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observation_source_doc ON public.knowledge_observations USING btree (source_document_id);


--
-- Name: idx_pending_deltas_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_deltas_doc ON public.document_pending_deltas USING btree (document_id, id);


--
-- Name: idx_relation_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relation_source ON public.knowledge_relations USING btree (source_id);


--
-- Name: idx_relation_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relation_target ON public.knowledge_relations USING btree (target_id);


--
-- Name: idx_session_review_user_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_review_user_at ON public.session_reviews USING btree (user_id, reviewed_at);


--
-- Name: idx_share_kind_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_kind_target ON public.share_links USING btree (kind, target_id);


--
-- Name: idx_share_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_owner ON public.share_links USING btree (owner_user_id);


--
-- Name: idx_share_target_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_target_user ON public.share_links USING btree (target_user_id);


--
-- Name: idx_share_view_share; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_view_share ON public.share_views USING btree (share_id, viewed_at);


--
-- Name: idx_skill_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_user_status ON public.skills USING btree (user_id, status);


--
-- Name: idx_todo_user_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_todo_user_fingerprint ON public.todos USING btree (user_id, fingerprint);


--
-- Name: idx_todo_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_todo_user_status ON public.todos USING btree (user_id, status, due_at);


--
-- Name: idx_user_memories_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_memories_embedding_hnsw ON public.user_memories USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_user_memory_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_memory_parent ON public.user_memories USING btree (user_id, parent_id);


--
-- Name: idx_user_memory_tree_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_memory_tree_path ON public.user_memories USING btree (user_id, tree_path);


--
-- Name: idx_user_memory_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_memory_user ON public.user_memories USING btree (user_id, updated_at DESC);


--
-- Name: idx_user_profile_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profile_user_status ON public.user_profiles USING btree (user_id, status, version DESC);


--
-- Name: ix_scheduled_tasks_next_run_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_scheduled_tasks_next_run_at ON public.scheduled_tasks USING btree (next_run_at);


--
-- Name: ix_scheduled_tasks_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_scheduled_tasks_user_id ON public.scheduled_tasks USING btree (user_id);


--
-- Name: ix_user_memories_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_memories_parent_id ON public.user_memories USING btree (parent_id);


--
-- Name: ix_user_memories_tree_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_memories_tree_path ON public.user_memories USING btree (tree_path);


--
-- Name: ix_users_oidc_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_users_oidc_subject ON public.users USING btree (oidc_subject) WHERE (oidc_subject IS NOT NULL);


--
-- Name: uq_conv_msg_doc_line; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_conv_msg_doc_line ON public.conversation_messages USING btree (document_id, line_number);


--
-- Name: uq_daily_summary_user_date_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_daily_summary_user_date_tool ON public.daily_summaries USING btree (user_id, summary_date, tool_id);


--
-- Name: uq_documents_machine_tool_path; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_documents_machine_tool_path ON public.documents USING btree (machine_id, tool_id, relative_path);


--
-- Name: uq_life_rhythm_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_life_rhythm_user_date ON public.user_life_rhythms USING btree (user_id, log_date);


--
-- Name: uq_permission_user_project_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_permission_user_project_tool ON public.permissions USING btree (user_id, project_id, tool_id);


--
-- Name: uq_sync_state; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sync_state ON public.sync_state USING btree (machine_id, tool_id, relative_path);


--
-- Name: access_logs access_logs_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_logs
    ADD CONSTRAINT access_logs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);


--
-- Name: access_logs access_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_logs
    ADD CONSTRAINT access_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: agent_missions agent_missions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_missions
    ADD CONSTRAINT agent_missions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_plans agent_plans_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plans
    ADD CONSTRAINT agent_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ask_conversations ask_conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ask_conversations
    ADD CONSTRAINT ask_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversation_messages conversation_messages_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_messages
    ADD CONSTRAINT conversation_messages_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: correction_events correction_events_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_events
    ADD CONSTRAINT correction_events_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.correction_topics(id) ON DELETE CASCADE;


--
-- Name: correction_events correction_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_events
    ADD CONSTRAINT correction_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: correction_topics correction_topics_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_topics
    ADD CONSTRAINT correction_topics_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.user_memories(id) ON DELETE SET NULL;


--
-- Name: correction_topics correction_topics_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correction_topics
    ADD CONSTRAINT correction_topics_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: daily_summaries daily_summaries_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_summaries
    ADD CONSTRAINT daily_summaries_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(id);


--
-- Name: daily_summaries daily_summaries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_summaries
    ADD CONSTRAINT daily_summaries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_tasks device_tasks_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tasks
    ADD CONSTRAINT device_tasks_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(id) ON DELETE SET NULL;


--
-- Name: device_tasks device_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tasks
    ADD CONSTRAINT device_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_embeddings document_embeddings_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeddings
    ADD CONSTRAINT document_embeddings_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_pending_deltas document_pending_deltas_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_pending_deltas
    ADD CONSTRAINT document_pending_deltas_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_search document_search_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_search
    ADD CONSTRAINT document_search_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_versions document_versions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: documents documents_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(id);


--
-- Name: documents documents_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: documents documents_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(id);


--
-- Name: dream_journals dream_journals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dream_journals
    ADD CONSTRAINT dream_journals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: eval_cases eval_cases_expected_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_cases
    ADD CONSTRAINT eval_cases_expected_doc_id_fkey FOREIGN KEY (expected_doc_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: eval_cases eval_cases_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_cases
    ADD CONSTRAINT eval_cases_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: eval_runs eval_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: guard_events guard_events_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guard_events
    ADD CONSTRAINT guard_events_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(id) ON DELETE SET NULL;


--
-- Name: guard_events guard_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guard_events
    ADD CONSTRAINT guard_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: invite_codes invite_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: knowledge_entities knowledge_entities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_entities
    ADD CONSTRAINT knowledge_entities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: knowledge_observations knowledge_observations_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_observations
    ADD CONSTRAINT knowledge_observations_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.knowledge_entities(id) ON DELETE CASCADE;


--
-- Name: knowledge_observations knowledge_observations_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_observations
    ADD CONSTRAINT knowledge_observations_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: knowledge_relations knowledge_relations_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_relations
    ADD CONSTRAINT knowledge_relations_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.knowledge_entities(id) ON DELETE CASCADE;


--
-- Name: knowledge_relations knowledge_relations_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_relations
    ADD CONSTRAINT knowledge_relations_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.knowledge_entities(id) ON DELETE CASCADE;


--
-- Name: learning_evals learning_evals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_evals
    ADD CONSTRAINT learning_evals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: machine_merges machine_merges_from_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_merges
    ADD CONSTRAINT machine_merges_from_machine_id_fkey FOREIGN KEY (from_machine_id) REFERENCES public.machines(id);


--
-- Name: machine_merges machine_merges_into_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_merges
    ADD CONSTRAINT machine_merges_into_machine_id_fkey FOREIGN KEY (into_machine_id) REFERENCES public.machines(id);


--
-- Name: machines machines_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.machines(id);


--
-- Name: machines machines_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: message_audit message_audit_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_audit
    ADD CONSTRAINT message_audit_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: permissions permissions_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: permissions permissions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: permissions permissions_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(id);


--
-- Name: permissions permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: projects projects_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(id);


--
-- Name: scheduled_tasks scheduled_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: session_reviews session_reviews_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_reviews
    ADD CONSTRAINT session_reviews_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: session_reviews session_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_reviews
    ADD CONSTRAINT session_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_views share_views_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_views
    ADD CONSTRAINT share_views_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.share_links(id) ON DELETE CASCADE;


--
-- Name: skills skills_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sync_state sync_state_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(id);


--
-- Name: sync_state sync_state_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(id);


--
-- Name: todos todos_source_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.todos
    ADD CONSTRAINT todos_source_doc_id_fkey FOREIGN KEY (source_doc_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: todos todos_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.todos
    ADD CONSTRAINT todos_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_life_rhythms user_life_rhythms_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_life_rhythms
    ADD CONSTRAINT user_life_rhythms_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_memories user_memories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.user_memories(id) ON DELETE CASCADE;


--
-- Name: user_memories user_memories_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.user_memories(id) ON DELETE SET NULL;


--
-- Name: user_memories user_memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_profiles user_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict vthCywG1RrO8U03xU3N914uMUZJYIUt45ejvCQkm0XcBO1Gg4cHPxQhSziTVLP2

