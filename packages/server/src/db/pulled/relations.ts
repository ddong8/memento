import { relations } from "drizzle-orm/relations";
import { users, machines, tools, projects, dailySummaries, inviteCodes, knowledgeEntities, shareLinks, askConversations, userMemories, dreamJournals, userProfiles, skills, evalRuns, learningEvals, agentMissions, agentPlans, userLifeRhythms, scheduledTasks, machineMerges, documents, permissions, syncState, knowledgeRelations, shareViews, deviceTasks, correctionTopics, guardEvents, documentSearch, conversationMessages, documentVersions, messageAudit, documentPendingDeltas, accessLogs, documentEmbeddings, knowledgeObservations, correctionEvents, sessionReviews, todos, evalCases } from "./schema";

export const machinesRelations = relations(machines, ({one, many}) => ({
	user: one(users, {
		fields: [machines.userId],
		references: [users.id]
	}),
	machine: one(machines, {
		fields: [machines.mergedInto],
		references: [machines.id],
		relationName: "machines_mergedInto_machines_id"
	}),
	machines: many(machines, {
		relationName: "machines_mergedInto_machines_id"
	}),
	machineMerges_fromMachineId: many(machineMerges, {
		relationName: "machineMerges_fromMachineId_machines_id"
	}),
	machineMerges_intoMachineId: many(machineMerges, {
		relationName: "machineMerges_intoMachineId_machines_id"
	}),
	documents: many(documents),
	syncStates: many(syncState),
	deviceTasks: many(deviceTasks),
	guardEvents: many(guardEvents),
}));

export const usersRelations = relations(users, ({many}) => ({
	machines: many(machines),
	dailySummaries: many(dailySummaries),
	inviteCodes: many(inviteCodes),
	knowledgeEntities: many(knowledgeEntities),
	shareLinks_ownerUserId: many(shareLinks, {
		relationName: "shareLinks_ownerUserId_users_id"
	}),
	shareLinks_targetUserId: many(shareLinks, {
		relationName: "shareLinks_targetUserId_users_id"
	}),
	askConversations: many(askConversations),
	userMemories: many(userMemories),
	dreamJournals: many(dreamJournals),
	userProfiles: many(userProfiles),
	skills: many(skills),
	evalRuns: many(evalRuns),
	learningEvals: many(learningEvals),
	agentMissions: many(agentMissions),
	agentPlans: many(agentPlans),
	userLifeRhythms: many(userLifeRhythms),
	scheduledTasks: many(scheduledTasks),
	permissions_userId: many(permissions, {
		relationName: "permissions_userId_users_id"
	}),
	permissions_grantedBy: many(permissions, {
		relationName: "permissions_grantedBy_users_id"
	}),
	deviceTasks: many(deviceTasks),
	correctionTopics: many(correctionTopics),
	guardEvents: many(guardEvents),
	accessLogs: many(accessLogs),
	correctionEvents: many(correctionEvents),
	sessionReviews: many(sessionReviews),
	todos: many(todos),
	evalCases: many(evalCases),
}));

export const projectsRelations = relations(projects, ({one, many}) => ({
	tool: one(tools, {
		fields: [projects.toolId],
		references: [tools.id]
	}),
	documents: many(documents),
	permissions: many(permissions),
}));

export const toolsRelations = relations(tools, ({many}) => ({
	projects: many(projects),
	dailySummaries: many(dailySummaries),
	documents: many(documents),
	permissions: many(permissions),
	syncStates: many(syncState),
}));

export const dailySummariesRelations = relations(dailySummaries, ({one}) => ({
	user: one(users, {
		fields: [dailySummaries.userId],
		references: [users.id]
	}),
	tool: one(tools, {
		fields: [dailySummaries.toolId],
		references: [tools.id]
	}),
}));

export const inviteCodesRelations = relations(inviteCodes, ({one}) => ({
	user: one(users, {
		fields: [inviteCodes.createdBy],
		references: [users.id]
	}),
}));

export const knowledgeEntitiesRelations = relations(knowledgeEntities, ({one, many}) => ({
	user: one(users, {
		fields: [knowledgeEntities.userId],
		references: [users.id]
	}),
	knowledgeRelations_sourceId: many(knowledgeRelations, {
		relationName: "knowledgeRelations_sourceId_knowledgeEntities_id"
	}),
	knowledgeRelations_targetId: many(knowledgeRelations, {
		relationName: "knowledgeRelations_targetId_knowledgeEntities_id"
	}),
	knowledgeObservations: many(knowledgeObservations),
}));

export const shareLinksRelations = relations(shareLinks, ({one, many}) => ({
	user_ownerUserId: one(users, {
		fields: [shareLinks.ownerUserId],
		references: [users.id],
		relationName: "shareLinks_ownerUserId_users_id"
	}),
	user_targetUserId: one(users, {
		fields: [shareLinks.targetUserId],
		references: [users.id],
		relationName: "shareLinks_targetUserId_users_id"
	}),
	shareViews: many(shareViews),
}));

export const askConversationsRelations = relations(askConversations, ({one}) => ({
	user: one(users, {
		fields: [askConversations.userId],
		references: [users.id]
	}),
}));

export const userMemoriesRelations = relations(userMemories, ({one, many}) => ({
	user: one(users, {
		fields: [userMemories.userId],
		references: [users.id]
	}),
	userMemory_parentId: one(userMemories, {
		fields: [userMemories.parentId],
		references: [userMemories.id],
		relationName: "userMemories_parentId_userMemories_id"
	}),
	userMemories_parentId: many(userMemories, {
		relationName: "userMemories_parentId_userMemories_id"
	}),
	userMemory_supersededBy: one(userMemories, {
		fields: [userMemories.supersededBy],
		references: [userMemories.id],
		relationName: "userMemories_supersededBy_userMemories_id"
	}),
	userMemories_supersededBy: many(userMemories, {
		relationName: "userMemories_supersededBy_userMemories_id"
	}),
	correctionTopics: many(correctionTopics),
}));

export const dreamJournalsRelations = relations(dreamJournals, ({one}) => ({
	user: one(users, {
		fields: [dreamJournals.userId],
		references: [users.id]
	}),
}));

export const userProfilesRelations = relations(userProfiles, ({one}) => ({
	user: one(users, {
		fields: [userProfiles.userId],
		references: [users.id]
	}),
}));

export const skillsRelations = relations(skills, ({one}) => ({
	user: one(users, {
		fields: [skills.userId],
		references: [users.id]
	}),
}));

export const evalRunsRelations = relations(evalRuns, ({one}) => ({
	user: one(users, {
		fields: [evalRuns.userId],
		references: [users.id]
	}),
}));

export const learningEvalsRelations = relations(learningEvals, ({one}) => ({
	user: one(users, {
		fields: [learningEvals.userId],
		references: [users.id]
	}),
}));

export const agentMissionsRelations = relations(agentMissions, ({one}) => ({
	user: one(users, {
		fields: [agentMissions.userId],
		references: [users.id]
	}),
}));

export const agentPlansRelations = relations(agentPlans, ({one}) => ({
	user: one(users, {
		fields: [agentPlans.userId],
		references: [users.id]
	}),
}));

export const userLifeRhythmsRelations = relations(userLifeRhythms, ({one}) => ({
	user: one(users, {
		fields: [userLifeRhythms.userId],
		references: [users.id]
	}),
}));

export const scheduledTasksRelations = relations(scheduledTasks, ({one}) => ({
	user: one(users, {
		fields: [scheduledTasks.userId],
		references: [users.id]
	}),
}));

export const machineMergesRelations = relations(machineMerges, ({one}) => ({
	machine_fromMachineId: one(machines, {
		fields: [machineMerges.fromMachineId],
		references: [machines.id],
		relationName: "machineMerges_fromMachineId_machines_id"
	}),
	machine_intoMachineId: one(machines, {
		fields: [machineMerges.intoMachineId],
		references: [machines.id],
		relationName: "machineMerges_intoMachineId_machines_id"
	}),
}));

export const documentsRelations = relations(documents, ({one, many}) => ({
	tool: one(tools, {
		fields: [documents.toolId],
		references: [tools.id]
	}),
	project: one(projects, {
		fields: [documents.projectId],
		references: [projects.id]
	}),
	machine: one(machines, {
		fields: [documents.machineId],
		references: [machines.id]
	}),
	documentSearches: many(documentSearch),
	conversationMessages: many(conversationMessages),
	documentVersions: many(documentVersions),
	messageAudits: many(messageAudit),
	documentPendingDeltas: many(documentPendingDeltas),
	accessLogs: many(accessLogs),
	documentEmbeddings: many(documentEmbeddings),
	knowledgeObservations: many(knowledgeObservations),
	sessionReviews: many(sessionReviews),
	todos: many(todos),
	evalCases: many(evalCases),
}));

export const permissionsRelations = relations(permissions, ({one}) => ({
	user_userId: one(users, {
		fields: [permissions.userId],
		references: [users.id],
		relationName: "permissions_userId_users_id"
	}),
	project: one(projects, {
		fields: [permissions.projectId],
		references: [projects.id]
	}),
	tool: one(tools, {
		fields: [permissions.toolId],
		references: [tools.id]
	}),
	user_grantedBy: one(users, {
		fields: [permissions.grantedBy],
		references: [users.id],
		relationName: "permissions_grantedBy_users_id"
	}),
}));

export const syncStateRelations = relations(syncState, ({one}) => ({
	machine: one(machines, {
		fields: [syncState.machineId],
		references: [machines.id]
	}),
	tool: one(tools, {
		fields: [syncState.toolId],
		references: [tools.id]
	}),
}));

export const knowledgeRelationsRelations = relations(knowledgeRelations, ({one}) => ({
	knowledgeEntity_sourceId: one(knowledgeEntities, {
		fields: [knowledgeRelations.sourceId],
		references: [knowledgeEntities.id],
		relationName: "knowledgeRelations_sourceId_knowledgeEntities_id"
	}),
	knowledgeEntity_targetId: one(knowledgeEntities, {
		fields: [knowledgeRelations.targetId],
		references: [knowledgeEntities.id],
		relationName: "knowledgeRelations_targetId_knowledgeEntities_id"
	}),
}));

export const shareViewsRelations = relations(shareViews, ({one}) => ({
	shareLink: one(shareLinks, {
		fields: [shareViews.shareId],
		references: [shareLinks.id]
	}),
}));

export const deviceTasksRelations = relations(deviceTasks, ({one}) => ({
	machine: one(machines, {
		fields: [deviceTasks.machineId],
		references: [machines.id]
	}),
	user: one(users, {
		fields: [deviceTasks.userId],
		references: [users.id]
	}),
}));

export const correctionTopicsRelations = relations(correctionTopics, ({one, many}) => ({
	user: one(users, {
		fields: [correctionTopics.userId],
		references: [users.id]
	}),
	userMemory: one(userMemories, {
		fields: [correctionTopics.memoryId],
		references: [userMemories.id]
	}),
	correctionEvents: many(correctionEvents),
}));

export const guardEventsRelations = relations(guardEvents, ({one}) => ({
	user: one(users, {
		fields: [guardEvents.userId],
		references: [users.id]
	}),
	machine: one(machines, {
		fields: [guardEvents.machineId],
		references: [machines.id]
	}),
}));

export const documentSearchRelations = relations(documentSearch, ({one}) => ({
	document: one(documents, {
		fields: [documentSearch.documentId],
		references: [documents.id]
	}),
}));

export const conversationMessagesRelations = relations(conversationMessages, ({one}) => ({
	document: one(documents, {
		fields: [conversationMessages.documentId],
		references: [documents.id]
	}),
}));

export const documentVersionsRelations = relations(documentVersions, ({one}) => ({
	document: one(documents, {
		fields: [documentVersions.documentId],
		references: [documents.id]
	}),
}));

export const messageAuditRelations = relations(messageAudit, ({one}) => ({
	document: one(documents, {
		fields: [messageAudit.documentId],
		references: [documents.id]
	}),
}));

export const documentPendingDeltasRelations = relations(documentPendingDeltas, ({one}) => ({
	document: one(documents, {
		fields: [documentPendingDeltas.documentId],
		references: [documents.id]
	}),
}));

export const accessLogsRelations = relations(accessLogs, ({one}) => ({
	user: one(users, {
		fields: [accessLogs.userId],
		references: [users.id]
	}),
	document: one(documents, {
		fields: [accessLogs.documentId],
		references: [documents.id]
	}),
}));

export const documentEmbeddingsRelations = relations(documentEmbeddings, ({one}) => ({
	document: one(documents, {
		fields: [documentEmbeddings.documentId],
		references: [documents.id]
	}),
}));

export const knowledgeObservationsRelations = relations(knowledgeObservations, ({one}) => ({
	knowledgeEntity: one(knowledgeEntities, {
		fields: [knowledgeObservations.entityId],
		references: [knowledgeEntities.id]
	}),
	document: one(documents, {
		fields: [knowledgeObservations.sourceDocumentId],
		references: [documents.id]
	}),
}));

export const correctionEventsRelations = relations(correctionEvents, ({one}) => ({
	user: one(users, {
		fields: [correctionEvents.userId],
		references: [users.id]
	}),
	correctionTopic: one(correctionTopics, {
		fields: [correctionEvents.topicId],
		references: [correctionTopics.id]
	}),
}));

export const sessionReviewsRelations = relations(sessionReviews, ({one}) => ({
	document: one(documents, {
		fields: [sessionReviews.documentId],
		references: [documents.id]
	}),
	user: one(users, {
		fields: [sessionReviews.userId],
		references: [users.id]
	}),
}));

export const todosRelations = relations(todos, ({one}) => ({
	user: one(users, {
		fields: [todos.userId],
		references: [users.id]
	}),
	document: one(documents, {
		fields: [todos.sourceDocId],
		references: [documents.id]
	}),
}));

export const evalCasesRelations = relations(evalCases, ({one}) => ({
	user: one(users, {
		fields: [evalCases.userId],
		references: [users.id]
	}),
	document: one(documents, {
		fields: [evalCases.expectedDocId],
		references: [documents.id]
	}),
}));