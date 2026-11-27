import { halfvec, pgTable, index, bigint, uuid, integer, varchar, text, jsonb, timestamp, uniqueIndex, unique, foreignKey, boolean, date, vector, doublePrecision, serial, bigserial, inet } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { tsvector } from "../types"



export const conversationMessagesRemoved = pgTable("conversation_messages_removed", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	lineNumber: integer("line_number").notNull(),
	messageType: varchar("message_type", { length: 50 }),
	role: varchar({ length: 50 }),
	content: text().notNull(),
	metadata: jsonb().notNull(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reason: varchar({ length: 50 }).notNull(),
}, (table) => [
	index("idx_conv_msg_removed_doc").using("btree", table.documentId.asc().nullsLast().op("uuid_ops")),
]);

export const users = pgTable("users", {
	id: uuid().primaryKey().notNull(),
	email: varchar({ length: 320 }).notNull(),
	name: varchar({ length: 255 }),
	avatarUrl: text("avatar_url"),
	hashedPassword: varchar("hashed_password", { length: 255 }),
	role: varchar({ length: 20 }).notNull(),
	status: varchar({ length: 20 }).notNull(),
	collectorToken: varchar("collector_token", { length: 64 }),
	githubId: varchar("github_id", { length: 50 }),
	wechatOpenid: varchar("wechat_openid", { length: 64 }),
	oidcSubject: varchar("oidc_subject", { length: 512 }),
	notifySettings: jsonb("notify_settings").default({}).notNull(),
	proactiveSettings: jsonb("proactive_settings").default({}).notNull(),
	llmSettings: jsonb("llm_settings").default({}).notNull(),
	avatarSettings: jsonb("avatar_settings").default({}).notNull(),
	collectSettings: jsonb("collect_settings").default({}).notNull(),
	pluginSettings: jsonb("plugin_settings").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_users_oidc_subject").using("btree", table.oidcSubject.asc().nullsLast().op("text_ops")).where(sql`(oidc_subject IS NOT NULL)`),
	unique("users_email_key").on(table.email),
	unique("users_collector_token_key").on(table.collectorToken),
	unique("users_wechat_openid_key").on(table.wechatOpenid),
]);

export const machines = pgTable("machines", {
	id: uuid().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	collectorTokenHash: varchar("collector_token_hash", { length: 255 }).notNull(),
	collectorVersion: varchar("collector_version", { length: 50 }),
	userId: uuid("user_id"),
	lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	remoteExecKey: varchar("remote_exec_key", { length: 64 }),
	profileTargets: jsonb("profile_targets").default([]).notNull(),
	profileTargetsOff: jsonb("profile_targets_off").default([]).notNull(),
	profileStatus: jsonb("profile_status").default({}).notNull(),
	skillStatus: jsonb("skill_status").default({}).notNull(),
	collectStatus: jsonb("collect_status").default({}).notNull(),
	mergedInto: uuid("merged_into"),
	isArchived: boolean("is_archived").default(false).notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_machines_collector_token_hash").using("btree", table.collectorTokenHash.asc().nullsLast().op("text_ops")),
	index("idx_machines_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "machines_user_id_fkey"
		}),
	foreignKey({
			columns: [table.mergedInto],
			foreignColumns: [table.id],
			name: "machines_merged_into_fkey"
		}),
]);

export const tools = pgTable("tools", {
	id: varchar({ length: 50 }).primaryKey().notNull(),
	displayName: varchar("display_name", { length: 100 }).notNull(),
	icon: varchar({ length: 50 }),
	description: text(),
	totalFiles: integer("total_files").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalSizeBytes: bigint("total_size_bytes", { mode: "number" }).notNull(),
	lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: 'string' }),
});

export const projects = pgTable("projects", {
	id: uuid().primaryKey().notNull(),
	slug: varchar({ length: 255 }).notNull(),
	title: varchar({ length: 500 }).notNull(),
	toolId: varchar("tool_id", { length: 50 }),
	sourcePath: text("source_path"),
	visibility: varchar({ length: 20 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.toolId],
			foreignColumns: [tools.id],
			name: "projects_tool_id_fkey"
		}),
	unique("projects_slug_key").on(table.slug),
]);

export const dailySummaries = pgTable("daily_summaries", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id"),
	summaryDate: date("summary_date").notNull(),
	toolId: varchar("tool_id", { length: 50 }),
	title: text().notNull(),
	summary: text().notNull(),
	highlights: jsonb(),
	sourceDocumentIds: uuid("source_document_ids").array(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("uq_daily_summary_user_date_tool").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.summaryDate.asc().nullsLast().op("text_ops"), table.toolId.asc().nullsLast().op("date_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "daily_summaries_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.toolId],
			foreignColumns: [tools.id],
			name: "daily_summaries_tool_id_fkey"
		}),
]);

export const inviteCodes = pgTable("invite_codes", {
	id: uuid().primaryKey().notNull(),
	code: varchar({ length: 48 }).notNull(),
	maxUses: integer("max_uses").notNull(),
	useCount: integer("use_count").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	roleOnAccept: varchar("role_on_accept", { length: 20 }).notNull(),
	note: text(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "invite_codes_created_by_fkey"
		}).onDelete("set null"),
	unique("invite_codes_code_key").on(table.code),
]);

export const knowledgeEntities = pgTable("knowledge_entities", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id"),
	name: text().notNull(),
	entityType: varchar("entity_type", { length: 50 }).notNull(),
	summary: text(),
	aliases: jsonb().default([]).notNull(),
	staleAt: timestamp("stale_at", { withTimezone: true, mode: 'string' }),
	staleReason: text("stale_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_entity_type").using("btree", table.entityType.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "knowledge_entities_user_id_fkey"
		}),
	unique("uq_entity_user_name_type").on(table.userId, table.name, table.entityType),
]);

export const shareLinks = pgTable("share_links", {
	id: uuid().primaryKey().notNull(),
	token: varchar({ length: 64 }).notNull(),
	kind: varchar({ length: 20 }).notNull(),
	targetId: text("target_id").notNull(),
	ownerUserId: uuid("owner_user_id").notNull(),
	targetUserId: uuid("target_user_id"),
	title: text(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_share_kind_target").using("btree", table.kind.asc().nullsLast().op("text_ops"), table.targetId.asc().nullsLast().op("text_ops")),
	index("idx_share_owner").using("btree", table.ownerUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_share_target_user").using("btree", table.targetUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "share_links_owner_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.targetUserId],
			foreignColumns: [users.id],
			name: "share_links_target_user_id_fkey"
		}).onDelete("cascade"),
	unique("share_links_token_key").on(table.token),
]);

export const askConversations = pgTable("ask_conversations", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id"),
	title: varchar({ length: 500 }).notNull(),
	turns: jsonb().notNull(),
	messageCount: integer("message_count").default(0).notNull(),
	deviceId: varchar("device_id", { length: 255 }),
	cwd: varchar({ length: 500 }),
	config: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_ask_conv_user_device").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.deviceId.asc().nullsLast().op("text_ops"), table.updatedAt.asc().nullsLast().op("text_ops")),
	index("idx_ask_conv_user_updated").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "ask_conversations_user_id_fkey"
		}).onDelete("cascade"),
]);

export const userMemories = pgTable("user_memories", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	category: varchar({ length: 50 }).notNull(),
	key: varchar({ length: 120 }).notNull(),
	content: text().notNull(),
	embedding: vector({ dimensions: 1024 }),
	confidence: doublePrecision().notNull(),
	source: varchar({ length: 50 }).notNull(),
	parentId: uuid("parent_id"),
	treePath: varchar("tree_path", { length: 255 }),
	isFolder: boolean("is_folder").notNull(),
	lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true, mode: 'string' }),
	recallCount: integer("recall_count").default(0).notNull(),
	status: varchar({ length: 20 }).default('active').notNull(),
	statusReason: text("status_reason"),
	supersededBy: uuid("superseded_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_user_memories_embedding_hnsw").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("idx_user_memory_parent").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.parentId.asc().nullsLast().op("uuid_ops")),
	index("idx_user_memory_tree_path").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.treePath.asc().nullsLast().op("text_ops")),
	index("idx_user_memory_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("ix_user_memories_parent_id").using("btree", table.parentId.asc().nullsLast().op("uuid_ops")),
	index("ix_user_memories_tree_path").using("btree", table.treePath.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_memories_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: "user_memories_parent_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.supersededBy],
			foreignColumns: [table.id],
			name: "user_memories_superseded_by_fkey"
		}).onDelete("set null"),
	unique("uq_user_memory_key").on(table.userId, table.category, table.key),
]);

export const dreamJournals = pgTable("dream_journals", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	dreamDate: date("dream_date").notNull(),
	stageMetrics: jsonb("stage_metrics").notNull(),
	lightSleepNotes: text("light_sleep_notes"),
	remReflections: text("rem_reflections"),
	deepConsolidations: text("deep_consolidations"),
	reportMarkdown: text("report_markdown").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_dream_journal_user_date").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.dreamDate.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("date_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "dream_journals_user_id_fkey"
		}).onDelete("cascade"),
]);

export const userProfiles = pgTable("user_profiles", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	status: varchar({ length: 20 }).notNull(),
	version: integer(),
	content: text().notNull(),
	stats: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_user_profile_user_status").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("int4_ops"), table.version.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_profiles_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_user_profile_version").on(table.userId, table.version),
]);

export const skills = pgTable("skills", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	slug: varchar({ length: 64 }).notNull(),
	title: varchar({ length: 120 }).notNull(),
	description: text().notNull(),
	body: text().notNull(),
	project: varchar({ length: 120 }),
	status: varchar({ length: 20 }).notNull(),
	version: integer().notNull(),
	pendingUpdate: jsonb("pending_update"),
	evidence: jsonb().default([]).notNull(),
	timesSeen: integer("times_seen").notNull(),
	editedByUser: boolean("edited_by_user").notNull(),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_skill_user_status").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "skills_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_skill_user_slug").on(table.userId, table.slug),
]);

export const evalRuns = pgTable("eval_runs", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	setVersion: integer("set_version").notNull(),
	cases: integer().notNull(),
	metrics: jsonb().default({}).notNull(),
	config: jsonb().default({}).notNull(),
	trigger: varchar({ length: 20 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_eval_run_user_at").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "eval_runs_user_id_fkey"
		}).onDelete("cascade"),
]);

export const learningEvals = pgTable("learning_evals", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	week: date().notNull(),
	metrics: jsonb().default({}).notNull(),
	trigger: varchar({ length: 20 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "learning_evals_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_learning_eval_user_week").on(table.userId, table.week),
]);

export const agentMissions = pgTable("agent_missions", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	title: varchar({ length: 255 }).notNull(),
	goal: text().notNull(),
	status: varchar({ length: 40 }).notNull(),
	riskLevel: varchar("risk_level", { length: 20 }).notNull(),
	currentStep: integer("current_step").notNull(),
	steps: jsonb().default([]).notNull(),
	context: jsonb().default({}).notNull(),
	approvalToken: varchar("approval_token", { length: 64 }),
	pendingAction: jsonb("pending_action"),
	summary: text(),
	error: text(),
	lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_agent_missions_heartbeat").using("btree", table.status.asc().nullsLast().op("text_ops"), table.lastHeartbeat.asc().nullsLast().op("timestamptz_ops")),
	index("idx_agent_missions_user_status").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "agent_missions_user_id_fkey"
		}).onDelete("cascade"),
]);

export const agentPlans = pgTable("agent_plans", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	title: varchar({ length: 255 }).notNull(),
	goal: text().notNull(),
	status: varchar({ length: 40 }).notNull(),
	autoStart: boolean("auto_start").notNull(),
	cwd: text(),
	sourceDeviceId: varchar("source_device_id", { length: 255 }),
	projectId: varchar("project_id", { length: 64 }),
	options: jsonb().default({}).notNull(),
	steps: jsonb().default([]).notNull(),
	planNote: text("plan_note"),
	summary: text(),
	error: text(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_agent_plans_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_agent_plans_user_created").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "agent_plans_user_id_fkey"
		}).onDelete("cascade"),
]);

export const userLifeRhythms = pgTable("user_life_rhythms", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	logDate: date("log_date").notNull(),
	wakeupTime: varchar("wakeup_time", { length: 20 }),
	bedtime: varchar({ length: 20 }),
	sleepHours: doublePrecision("sleep_hours"),
	totalScreenMinutes: integer("total_screen_minutes").notNull(),
	productiveMinutes: integer("productive_minutes").notNull(),
	distractionMinutes: integer("distraction_minutes").notNull(),
	appUsages: jsonb("app_usages").default([]).notNull(),
	aiAdvice: text("ai_advice"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("uq_life_rhythm_user_date").using("btree", table.userId.asc().nullsLast().op("date_ops"), table.logDate.asc().nullsLast().op("date_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_life_rhythms_user_id_fkey"
		}).onDelete("cascade"),
]);

export const scheduledTasks = pgTable("scheduled_tasks", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	title: varchar({ length: 200 }).notNull(),
	device: varchar({ length: 255 }).notNull(),
	agent: varchar({ length: 40 }).notNull(),
	prompt: text().notNull(),
	cwd: text(),
	permissionMode: varchar("permission_mode", { length: 20 }).default('full').notNull(),
	schedule: varchar({ length: 40 }).notNull(),
	tzOffsetMin: integer("tz_offset_min").default(480).notNull(),
	enabled: boolean().default(true).notNull(),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	lastTaskId: uuid("last_task_id"),
	lastStatus: varchar("last_status", { length: 20 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_scheduled_tasks_next_run_at").using("btree", table.nextRunAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_scheduled_tasks_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "scheduled_tasks_user_id_fkey"
		}).onDelete("cascade"),
]);

export const machineMerges = pgTable("machine_merges", {
	id: serial().primaryKey().notNull(),
	fromMachineId: uuid("from_machine_id").notNull(),
	intoMachineId: uuid("into_machine_id").notNull(),
	name: varchar({ length: 255 }).notNull(),
	collectorTokenHash: varchar("collector_token_hash", { length: 255 }).notNull(),
	moved: jsonb().default({}).notNull(),
	kept: jsonb().default({}).notNull(),
	mergedAt: timestamp("merged_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.fromMachineId],
			foreignColumns: [machines.id],
			name: "machine_merges_from_machine_id_fkey"
		}),
	foreignKey({
			columns: [table.intoMachineId],
			foreignColumns: [machines.id],
			name: "machine_merges_into_machine_id_fkey"
		}),
]);

export const documents = pgTable("documents", {
	id: uuid().primaryKey().notNull(),
	toolId: varchar("tool_id", { length: 50 }).notNull(),
	projectId: uuid("project_id"),
	machineId: uuid("machine_id"),
	relativePath: text("relative_path").notNull(),
	category: varchar({ length: 50 }).notNull(),
	contentType: varchar("content_type", { length: 50 }).notNull(),
	title: text(),
	content: text(),
	contentS3Key: varchar("content_s3_key", { length: 500 }),
	contentHash: varchar("content_hash", { length: 64 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
	metadata: jsonb().notNull(),
	renderedHtml: text("rendered_html"),
	aiSummary: text("ai_summary"),
	aiSummaryGeneratedAt: timestamp("ai_summary_generated_at", { withTimezone: true, mode: 'string' }),
	visibility: varchar({ length: 20 }).notNull(),
	needsReview: boolean("needs_review").notNull(),
	embeddingStatus: varchar("embedding_status", { length: 20 }).notNull(),
	embeddingAttempts: integer("embedding_attempts").notNull(),
	embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: 'string' }),
	embeddingNextAt: timestamp("embedding_next_at", { withTimezone: true, mode: 'string' }),
	knowledgeStatus: varchar("knowledge_status", { length: 20 }).notNull(),
	knowledgeAttempts: integer("knowledge_attempts").notNull(),
	sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true, mode: 'string' }),
	syncedAt: timestamp("synced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_documents_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("idx_documents_machine_synced").using("btree", table.machineId.asc().nullsLast().op("timestamptz_ops"), table.syncedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_documents_metadata_cascade_id").using("btree", sql`((metadata ->> 'cascade_id'::text))`).where(sql`((metadata ->> 'cascade_id'::text) IS NOT NULL)`),
	index("idx_documents_metadata_session_id").using("btree", sql`((metadata ->> 'session_id'::text))`).where(sql`((metadata ->> 'session_id'::text) IS NOT NULL)`),
	index("idx_documents_project_category").using("btree", table.projectId.asc().nullsLast().op("uuid_ops"), table.category.asc().nullsLast().op("text_ops")),
	index("idx_documents_project_synced").using("btree", table.projectId.asc().nullsLast().op("timestamptz_ops"), table.syncedAt.desc().nullsFirst().op("uuid_ops")),
	index("idx_documents_synced_at").using("btree", table.syncedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_documents_tool_synced").using("btree", table.toolId.asc().nullsLast().op("text_ops"), table.syncedAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("uq_documents_machine_tool_path").using("btree", table.machineId.asc().nullsLast().op("text_ops"), table.toolId.asc().nullsLast().op("uuid_ops"), table.relativePath.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.toolId],
			foreignColumns: [tools.id],
			name: "documents_tool_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "documents_project_id_fkey"
		}),
	foreignKey({
			columns: [table.machineId],
			foreignColumns: [machines.id],
			name: "documents_machine_id_fkey"
		}),
]);

export const permissions = pgTable("permissions", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	projectId: uuid("project_id"),
	toolId: varchar("tool_id", { length: 50 }),
	permission: varchar({ length: 20 }).notNull(),
	grantedBy: uuid("granted_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("uq_permission_user_project_tool").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.projectId.asc().nullsLast().op("uuid_ops"), table.toolId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "permissions_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "permissions_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.toolId],
			foreignColumns: [tools.id],
			name: "permissions_tool_id_fkey"
		}),
	foreignKey({
			columns: [table.grantedBy],
			foreignColumns: [users.id],
			name: "permissions_granted_by_fkey"
		}),
]);

export const syncState = pgTable("sync_state", {
	id: serial().primaryKey().notNull(),
	machineId: uuid("machine_id"),
	toolId: varchar("tool_id", { length: 50 }),
	relativePath: text("relative_path").notNull(),
	lastHash: varchar("last_hash", { length: 64 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastOffset: bigint("last_offset", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastEndOffset: bigint("last_end_offset", { mode: "number" }),
	excludedProject: varchar("excluded_project", { length: 255 }),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("uq_sync_state").using("btree", table.machineId.asc().nullsLast().op("text_ops"), table.toolId.asc().nullsLast().op("uuid_ops"), table.relativePath.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.machineId],
			foreignColumns: [machines.id],
			name: "sync_state_machine_id_fkey"
		}),
	foreignKey({
			columns: [table.toolId],
			foreignColumns: [tools.id],
			name: "sync_state_tool_id_fkey"
		}),
]);

export const knowledgeRelations = pgTable("knowledge_relations", {
	id: uuid().primaryKey().notNull(),
	sourceId: uuid("source_id").notNull(),
	targetId: uuid("target_id").notNull(),
	relationType: varchar("relation_type", { length: 50 }).notNull(),
	strength: doublePrecision().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_relation_source").using("btree", table.sourceId.asc().nullsLast().op("uuid_ops")),
	index("idx_relation_target").using("btree", table.targetId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.sourceId],
			foreignColumns: [knowledgeEntities.id],
			name: "knowledge_relations_source_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.targetId],
			foreignColumns: [knowledgeEntities.id],
			name: "knowledge_relations_target_id_fkey"
		}).onDelete("cascade"),
]);

export const shareViews = pgTable("share_views", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	shareId: uuid("share_id").notNull(),
	ip: inet(),
	country: varchar({ length: 80 }),
	region: varchar({ length: 120 }),
	city: varchar({ length: 120 }),
	userAgent: text("user_agent"),
	referer: text(),
	viewedAt: timestamp("viewed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_share_view_share").using("btree", table.shareId.asc().nullsLast().op("timestamptz_ops"), table.viewedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.shareId],
			foreignColumns: [shareLinks.id],
			name: "share_views_share_id_fkey"
		}).onDelete("cascade"),
]);

export const deviceTasks = pgTable("device_tasks", {
	id: uuid().primaryKey().notNull(),
	deviceId: varchar("device_id", { length: 128 }).notNull(),
	machineId: uuid("machine_id"),
	userId: uuid("user_id"),
	action: varchar({ length: 40 }).notNull(),
	payload: jsonb(),
	status: varchar({ length: 20 }).notNull(),
	exitCode: integer("exit_code"),
	stdout: text(),
	stderr: text(),
	error: text(),
	alerts: jsonb().default([]).notNull(),
	events: jsonb().default([]).notNull(),
	sessionId: varchar("session_id", { length: 128 }),
	timeoutSeconds: integer("timeout_seconds").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_device_task_poll").using("btree", table.deviceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_device_task_user").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_device_tasks_user_active").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'still_running'::character varying, 'pending'::character varying, 'dispatched'::character varying])::text[]))`),
	foreignKey({
			columns: [table.machineId],
			foreignColumns: [machines.id],
			name: "device_tasks_machine_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "device_tasks_user_id_fkey"
		}).onDelete("set null"),
]);

export const correctionTopics = pgTable("correction_topics", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	statement: text().notNull(),
	category: varchar({ length: 20 }).notNull(),
	status: varchar({ length: 20 }).notNull(),
	scope: varchar({ length: 200 }).default('global').notNull(),
	times: integer().notNull(),
	firstAt: timestamp("first_at", { withTimezone: true, mode: 'string' }),
	lastAt: timestamp("last_at", { withTimezone: true, mode: 'string' }),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
	memoryId: uuid("memory_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_correction_topic_user_status").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "correction_topics_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.memoryId],
			foreignColumns: [userMemories.id],
			name: "correction_topics_memory_id_fkey"
		}).onDelete("set null"),
]);

export const guardEvents = pgTable("guard_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	machineId: uuid("machine_id"),
	tool: varchar({ length: 30 }).notNull(),
	sessionId: varchar("session_id", { length: 100 }),
	outcome: varchar({ length: 20 }).notNull(),
	blocked: boolean().notNull(),
	followup: boolean().notNull(),
	deploy: boolean().notNull(),
	claim: varchar({ length: 200 }),
	check: varchar({ length: 200 }),
	cwd: varchar({ length: 300 }),
	saidAt: timestamp("said_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_guard_event_user_said").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.saidAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "guard_events_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.machineId],
			foreignColumns: [machines.id],
			name: "guard_events_machine_id_fkey"
		}).onDelete("set null"),
]);

export const documentSearch = pgTable("document_search", {
	documentId: uuid("document_id").primaryKey().notNull(),
	contentTsv: tsvector("content_tsv").notNull(),
}, (table) => [
	index("idx_document_search_tsv").using("gin", table.contentTsv.asc().nullsLast().op("tsvector_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "document_search_document_id_fkey"
		}).onDelete("cascade"),
]);

export const conversationMessages = pgTable("conversation_messages", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	lineNumber: integer("line_number").notNull(),
	messageType: varchar("message_type", { length: 50 }),
	role: varchar({ length: 50 }),
	content: text().notNull(),
	metadata: jsonb().notNull(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_conv_msg_chat_ts").using("btree", table.timestamp.asc().nullsLast().op("uuid_ops"), table.documentId.asc().nullsLast().op("uuid_ops")).where(sql`(((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying])::text[])) AND (content !~~ '[Result]%'::text) AND (content !~~ '[Tool:%'::text) AND ("timestamp" IS NOT NULL))`),
	index("idx_conv_msg_doc_dialogue").using("btree", table.documentId.asc().nullsLast().op("int4_ops"), table.lineNumber.asc().nullsLast().op("uuid_ops")).where(sql`((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying])::text[]))`),
	index("idx_conv_msg_doc_ts").using("btree", table.documentId.asc().nullsLast().op("timestamptz_ops"), table.timestamp.asc().nullsLast().op("uuid_ops")),
	index("idx_conv_msg_timestamp").using("btree", table.timestamp.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("uq_conv_msg_doc_line").using("btree", table.documentId.asc().nullsLast().op("uuid_ops"), table.lineNumber.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "conversation_messages_document_id_fkey"
		}).onDelete("cascade"),
]);

export const documentVersions = pgTable("document_versions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	contentHash: varchar("content_hash", { length: 64 }).notNull(),
	contentDelta: text("content_delta"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
	syncedAt: timestamp("synced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_doc_versions_doc_synced").using("btree", table.documentId.asc().nullsLast().op("timestamptz_ops"), table.syncedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "document_versions_document_id_fkey"
		}).onDelete("cascade"),
]);

export const messageAudit = pgTable("message_audit", {
	documentId: uuid("document_id").primaryKey().notNull(),
	contentHash: varchar("content_hash", { length: 64 }),
	checkedAt: timestamp("checked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	outcome: varchar({ length: 30 }).notNull(),
	expected: integer().notNull(),
	stored: integer().notNull(),
	missing: integer().notNull(),
	duplicates: integer().notNull(),
	unknown: integer().notNull(),
	detail: jsonb().default({}).notNull(),
}, (table) => [
	index("idx_message_audit_outcome").using("btree", table.outcome.asc().nullsLast().op("text_ops"), table.checkedAt.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "message_audit_document_id_fkey"
		}).onDelete("cascade"),
]);

export const documentPendingDeltas = pgTable("document_pending_deltas", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	content: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_pending_deltas_doc").using("btree", table.documentId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "document_pending_deltas_document_id_fkey"
		}).onDelete("cascade"),
]);

export const accessLogs = pgTable("access_logs", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id"),
	documentId: uuid("document_id"),
	action: varchar({ length: 50 }).notNull(),
	ipAddress: varchar("ip_address", { length: 45 }),
	userAgent: text("user_agent"),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_access_logs_document").using("btree", table.documentId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("idx_access_logs_user").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "access_logs_user_id_fkey"
		}),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "access_logs_document_id_fkey"
		}),
]);

export const documentEmbeddings = pgTable("document_embeddings", {
	id: uuid().primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	chunkText: text("chunk_text").notNull(),
	embedding: halfvec("embedding", { dimensions: 1024 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_doc_embedding_hnsw_half").using("hnsw", table.embedding.asc().nullsLast().op("halfvec_cosine_ops")).with({m: "16",ef_construction: "64"}),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "document_embeddings_document_id_fkey"
		}).onDelete("cascade"),
	unique("uq_doc_embedding_chunk").on(table.documentId, table.chunkIndex),
]);

export const knowledgeObservations = pgTable("knowledge_observations", {
	id: uuid().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	content: text().notNull(),
	sourceDocumentId: uuid("source_document_id"),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_observation_entity").using("btree", table.entityId.asc().nullsLast().op("uuid_ops")),
	index("idx_observation_source_doc").using("btree", table.sourceDocumentId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [knowledgeEntities.id],
			name: "knowledge_observations_entity_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sourceDocumentId],
			foreignColumns: [documents.id],
			name: "knowledge_observations_source_document_id_fkey"
		}).onDelete("set null"),
]);

export const correctionEvents = pgTable("correction_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	topicId: uuid("topic_id").notNull(),
	quote: text().notNull(),
	saidAt: timestamp("said_at", { withTimezone: true, mode: 'string' }).notNull(),
	repeat: boolean().notNull(),
	alreadyLearned: boolean("already_learned").notNull(),
	fingerprint: varchar({ length: 40 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_correction_event_user_said").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.saidAt.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "correction_events_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.topicId],
			foreignColumns: [correctionTopics.id],
			name: "correction_events_topic_id_fkey"
		}).onDelete("cascade"),
	unique("uq_correction_event_fingerprint").on(table.userId, table.fingerprint),
]);

export const sessionReviews = pgTable("session_reviews", {
	documentId: uuid("document_id").primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	messageCount: integer("message_count").notNull(),
	outcome: varchar({ length: 20 }).notNull(),
	summary: text(),
	result: jsonb().default({}).notNull(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_session_review_user_at").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.reviewedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "session_reviews_document_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "session_reviews_user_id_fkey"
		}).onDelete("cascade"),
]);

export const todos = pgTable("todos", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	title: varchar({ length: 200 }).notNull(),
	detail: text(),
	project: varchar({ length: 120 }),
	status: varchar({ length: 20 }).notNull(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	source: varchar({ length: 20 }).notNull(),
	evidence: text(),
	sourceDocId: uuid("source_doc_id"),
	fingerprint: varchar({ length: 40 }).notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	closeEvidence: text("close_evidence"),
	remindedAt: timestamp("reminded_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_todo_user_fingerprint").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.fingerprint.asc().nullsLast().op("uuid_ops")),
	index("idx_todo_user_status").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("uuid_ops"), table.dueAt.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "todos_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sourceDocId],
			foreignColumns: [documents.id],
			name: "todos_source_doc_id_fkey"
		}).onDelete("set null"),
]);

export const evalCases = pgTable("eval_cases", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	setVersion: integer("set_version").notNull(),
	query: text().notNull(),
	expectedDocId: uuid("expected_doc_id").notNull(),
	evidence: text(),
	kind: varchar({ length: 20 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_eval_case_user_set").using("btree", table.userId.asc().nullsLast().op("int4_ops"), table.setVersion.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "eval_cases_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.expectedDocId],
			foreignColumns: [documents.id],
			name: "eval_cases_expected_doc_id_fkey"
		}).onDelete("cascade"),
]);

export const schemaMigrations = pgTable("schema_migrations", {
	version: varchar({ length: 64 }).primaryKey().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
