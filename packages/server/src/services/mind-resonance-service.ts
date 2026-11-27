// Mind resonance: user context injected before an agent/ask works on a request
// (server/server/services/mind_resonance_service.py).
import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import { cacheDeletePrefix, cacheGet } from "../cache";
import type { Db } from "../db/client";
import {
  documents,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  userMemories,
} from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { CODE_BLUEPRINT_TITLES, codeBlueprintPath, pickFreshest } from "./blueprint-pick";
import { findEntity } from "./entity-canon";
import { score, termsFor, touchRecalled } from "./guidance-service";
import { getPublishedProfile } from "./profile-read";
import { splitProfileScopes } from "./profile-scopes";
import { cleanText } from "./session-compactor";
import { segment, STOPWORDS } from "./tokenize";
import { warmUserBlueprint } from "./user-blueprint-service";

export interface DomainScenario {
  id: string;
  name: string;
  keywords: readonly string[];
  mindset: string;
  target_project: string | null;
  anchors: string[];
  search_query_extras: string;
  defense_rules: string[];
  device_affinity: string | null;
}

export const DEFAULT_DOMAIN_SCENARIOS: DomainScenario[] = [
  {
    id: "evolution_memory",
    name: "AI 记忆与自进化底座",
    keywords: ["自进化", "心领神会", "懂我", "记忆", "画像", "dreaming", "memento", "mcp", "profile", "agentic"],
    mindset: "希望工具能越用越了解用户，具备自进化能力；打破工具孤岛，沉淀终身资产；一次做到位，不绕弯子。",
    target_project: "memento",
    anchors: ["心领神会", "常驻画像", "自进化", "避坑"],
    search_query_extras: "心领神会 常驻画像 自进化",
    defense_rules: [
      "1) 仔细深入调查问题，从根子上彻底解决，避免重复出现；一次做到位，交付前本地类型检查与自测确认通过。",
      "2) 直接给结论和指令，不绕弯子、不废话、不反问用户。",
    ],
    device_affinity: "mac",
  },
  {
    id: "chemistry_pubchem",
    name: "化学研发与逆合成规划",
    keywords: ["逆合成", "pubchem", "cas", "smiles", "化合物", "路线", "试剂", "化学", "分子"],
    mindset: "CAS号精准表述不猜测名称；路线条数可控且AI重排；严禁不稳定格式试剂；一键接入oneapi模型。",
    target_project: "pubchem",
    anchors: ["CAS", "SMILES", "逆合成", "格式试剂", "路线重排"],
    search_query_extras: "CAS SMILES 逆合成",
    defense_rules: [
      "1) 遇到原文中是 CAS 号的化合物，直接使用 CAS 号表述，严禁猜测化合物名称。",
      "2) 逆合成结果必须经过 AI 重排，步数多的路线不能排在前面；避免生成不稳定的格式试剂。",
    ],
    device_affinity: "linux",
  },
  {
    id: "data_harvest",
    name: "化学数据抓取与资产沉淀",
    keywords: ["workbuddy", "抓取", "爬虫", "爬取", "数据源", "数据清洗", "资产登记"],
    mindset: "优先中文网站且必抓中文名；CAS和SMILES为必须字段；先整库dump本地再处理；提供可溯源登记。",
    target_project: "workbuddy",
    anchors: ["CAS", "SMILES", "中文名称", "数据抓取", "资产登记"],
    search_query_extras: "数据抓取 中文名称 dump",
    defense_rules: [
      "1) 抓取化学数据源优先中文网站，且必须抓取中文名称；CAS 与 SMILES 为必须字段。",
      "2) 先整库 dump 到本地再处理数据；修改数据前先备份原表数据，倾向打标记而非硬删除。",
    ],
    device_affinity: "linux",
  },
  {
    id: "ui_performance",
    name: "前端交互极致性能与设计",
    keywords: ["前端", "tab", "切换", "卡顿", "渲染", "ui", "aurora", "延迟", "流畅", "动画", "保活"],
    mindset: "交互零延迟、0ms切换无损保活；界面精致高级；绝不阻塞主线程；桌面端应用名称去掉desktop后缀。",
    target_project: "memento",
    anchors: ["交互零延迟", "全屏铺满", "缓存", "流式输出"],
    search_query_extras: "零延迟 保活 页面流畅",
    defense_rules: [
      "1) 交互零延迟、避免卡顿与页面卡死，重视前端性能与流畅体验。",
      "2) 界面精致高级，符合 Aurora 设计规范。",
    ],
    device_affinity: "mac",
  },
  {
    id: "devops_release",
    name: "发布交付与无故障上线",
    keywords: ["发布", "部署", "k8s", "pod", "release", "tag", "更新", "发版", "构建", "docker", "fleet", "gitops", "kubectl", "流水线", "上线", "镜像"],
    mindset: "发版前必查历史经验避免重踩坑；代码发版打tag并确认所有pod状态；CI/CD零停机更新；帮用户做完勿让用户手动敲命令。",
    target_project: "memento",
    anchors: ["version.json", "kustomization", "Fleet", "package.json", "tag", "部署"],
    search_query_extras: "发布 三位一体 version.json tag",
    defense_rules: [
      "1) 发版前必查历史经验避免重踩坑，确认代码发版打 tag，且所有 pod 确认已部署更新。",
      "2) 桌面端发布严格遵守元数据三位一体校验（version.json、GitHub Release 与 updates.py 强一致）。",
      "3) 代码提交规范：中文 Conventional Commits 风格，严禁添加 Claude 共同作者信息，保持线性 Git 历史。",
      "4) 发布、部署全流程直接帮用户闭环做完，严禁让用户手动敲命令。",
    ],
    device_affinity: "linux",
  },
  {
    id: "data_safety",
    name: "数据资产安全与审计",
    keywords: ["删除", "解绑", "设备", "machine", "归档", "purge", "清理数据", "备份"],
    mindset: "修改前先备份原表数据；倾向打标记归档而非物理硬删除便于审计；删除设备允许保留数据。",
    target_project: null,
    anchors: ["归档", "备份", "保留标记", "审计"],
    search_query_extras: "数据安全 备份 归档 审计",
    defense_rules: [
      "1) 修改数据前先备份原表数据；数据操作倾向打标记而非硬删除，便于审计追踪。",
      "2) 设备解绑或数据清理操作确保可溯源与可恢复。",
    ],
    device_affinity: null,
  },
];

const dynamicScenarios = new Map<string, DomainScenario>();
const dbScenarioIds = new Set<string>();
let activeScenarios: DomainScenario[] = DEFAULT_DOMAIN_SCENARIOS.map((s) => ({ ...s }));
const SCENARIO_RELOAD_MS = 600_000;
let reloadTimer: ReturnType<typeof setInterval> | null = null;

function refreshActiveScenarios(): void {
  const merged: DomainScenario[] = [];
  const seen = new Set<string>();
  for (const s of DEFAULT_DOMAIN_SCENARIOS) {
    merged.push({ ...(dynamicScenarios.get(s.id) ?? s) });
    seen.add(s.id);
  }
  for (const [id, s] of dynamicScenarios) {
    if (!seen.has(id)) merged.push({ ...s });
  }
  activeScenarios = merged;
}

export function registerScenario(scenario: Record<string, unknown>): DomainScenario {
  const sid = String(scenario.id ?? "").trim();
  if (!sid) throw new Error("Scenario must contain an 'id' field");
  const anchors = Array.isArray(scenario.anchors) ? scenario.anchors.map((a) => String(a).trim()).filter(Boolean) : [];
  const norm: DomainScenario = {
    id: sid,
    name: String(scenario.name ?? sid).trim(),
    keywords: Array.isArray(scenario.keywords) ? scenario.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    mindset: String(scenario.mindset ?? "").trim(),
    target_project: String(scenario.target_project ?? "").trim() || null,
    anchors,
    search_query_extras: String(scenario.search_query_extras ?? anchors.slice(0, 3).join(" ")).trim(),
    defense_rules: Array.isArray(scenario.defense_rules) ? scenario.defense_rules.map((r) => String(r).trim()).filter(Boolean) : [],
    device_affinity: scenario.device_affinity ? String(scenario.device_affinity) : null,
  };
  dynamicScenarios.set(sid, norm);
  refreshActiveScenarios();
  return norm;
}

export function unregisterScenario(scenarioId: string): boolean {
  if (!dynamicScenarios.delete(scenarioId)) return false;
  refreshActiveScenarios();
  return true;
}

export function getAllScenarios(): DomainScenario[] {
  return activeScenarios.map((s) => ({ ...s }));
}

export async function loadDynamicScenariosFromDb(db: Db, userId?: string | null): Promise<DomainScenario[]> {
  const loaded: DomainScenario[] = [];
  try {
    const conds = [
      inArray(userMemories.category, ["resonance_scenario", "scenario", "custom_scenario"]),
      eq(userMemories.status, "active"),
      eq(userMemories.isFolder, false),
    ];
    if (userId) conds.push(eq(userMemories.userId, userId));
    const mems = await db.select().from(userMemories).where(and(...conds));
    for (const m of mems) {
      try {
        const data = JSON.parse(m.content) as Record<string, unknown>;
        if (data && typeof data === "object" && data.id) loaded.push(registerScenario(data));
      } catch {
        /* ignore */
      }
    }
    if (!userId) {
      const nowIds = new Set(loaded.map((d) => d.id));
      for (const gone of dbScenarioIds) if (!nowIds.has(gone)) unregisterScenario(gone);
      dbScenarioIds.clear();
      for (const id of nowIds) dbScenarioIds.add(id);
    }
  } catch {
    /* ignore */
  }
  return loaded;
}

export function startDynamicScenarioReloader(db: Db): void {
  if (reloadTimer) return;
  void loadDynamicScenariosFromDb(db);
  reloadTimer = setInterval(() => void loadDynamicScenariosFromDb(db), SCENARIO_RELOAD_MS);
  reloadTimer.unref?.();
}

export function stopDynamicScenarioReloader(): void {
  if (reloadTimer) {
    clearInterval(reloadTimer);
    reloadTimer = null;
  }
}

export function detectScenario(terms: string[], rawText = "", extraScenarios?: DomainScenario[]): DomainScenario {
  const lowText = rawText.toLowerCase();
  const termSet = new Set(terms);
  let best: DomainScenario | null = null;
  let bestScore = 0;
  const pool = extraScenarios?.length ? [...activeScenarios, ...extraScenarios] : activeScenarios;
  for (const scen of pool) {
    let sc = 0;
    for (const k of scen.keywords) {
      if (lowText.includes(k)) sc += 2;
      if (termSet.has(k)) sc += 1;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = scen;
    }
  }
  if (best && bestScore >= 2) return best;
  return {
    id: "general_engineering",
    name: "工程研发与深度协同",
    keywords: [],
    mindset: "直接给结论和指令，不绕弯子、不废话、不反问；仔细深入调查从根子上彻底解决；一次做到位，交付前自测确认。",
    target_project: null,
    anchors: [],
    search_query_extras: "",
    defense_rules: [
      "1) 仔细深入调查问题，从根子上彻底解决；一次做到位，交付前本地类型检查与自测确认通过。",
      "2) 直接给结论和指令，不绕弯子、不废话、不反问用户。",
    ],
    device_affinity: null,
  };
}

const ENTITY_CANDIDATES = 200;
const DISPATCH_ACTIONS = new Set(["agent", "ask", "chat"]);
const FILLER_EN = new Set(
  (
    "test testing code user users request session http https com www ok okay hi hello hey yes no please help run " +
    "use new add fix get set out ran being continued summary ping echo true false none null this that with from " +
    "have what when where which will would should could your about into just like make more only some than them " +
    "then there these they very want work also back been both each even here how its many most much must other " +
    "over same such sure take thing those through upon well were while who why year"
  ).split(" "),
);
const COMMON_ZH_LOW = new Set([
  "完成", "继续", "开始", "解决", "问题", "处理", "查看", "检查", "确认", "修改", "更新", "运行", "执行", "测试",
  "代码", "文件", "系统", "服务", "功能", "数据", "信息", "内容", "结果", "情况", "状态", "时间", "方法", "方式",
]);
const COMMON_ZH_MID = new Set(["部署", "优化", "提交", "发布", "构建", "同步", "接口", "配置", "日志", "数据库", "前端", "后端"]);
const CJK_RE = /[\u4e00-\u9fff]/;
const PARTICLES_RE = /[了吗呢吧啊呀么的嘛哦]+$/;

export function termSpecificity(term: string): number {
  if (STOPWORDS.has(term) || !/[a-z\u4e00-\u9fff]/.test(term)) return 0;
  if (CJK_RE.test(term)) {
    const base = term.replace(PARTICLES_RE, "");
    if (base.length < 2) return 0;
    if (COMMON_ZH_LOW.has(base)) return 0;
    if (COMMON_ZH_MID.has(base)) return 0.5;
    return 1.0;
  }
  const w = term.replace(/^[:.]+|[:.]+$/g, "");
  if (FILLER_EN.has(w) || w.length < 2) return 0;
  return w.length === 2 ? 0.5 : 1.0;
}

export function pitfallTerms(query: string, action?: string | null): string[] {
  const low = (query || "").toLowerCase();
  const raw = new Set(low.split(/[\s_\-/,，;；]+/).filter(Boolean));
  const tokens = new Set(segment(query || "").map((t) => t.toLowerCase().trim()));
  return termsFor(action, query).filter((t) => t.length >= 2 && !(raw.has(t) && CJK_RE.test(t) && !tokens.has(t)));
}

const PITFALL_MIN_SHARE = 0.94;
const PITFALL_KEEP_SHARE = 0.6;
const PITFALL_MIN_CORPUS = 50;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchScopedAndGeneralRules(
  db: Db,
  user: { id: string },
  terms: string[],
  scenario: DomainScenario,
  project: string | null,
): Promise<[string[], string[]]> {
  let scopedRules: string[] = [];
  let generalRules: string[] = [];
  try {
    const prof = await getPublishedProfile(db, user);
    if (prof?.content) {
      const scopes = splitProfileScopes(prof.content);
      const targetProj = (project || "").trim().toLowerCase() || (scenario.target_project || "").trim().toLowerCase();
      if (targetProj) {
        for (const [pName, lines] of Object.entries(scopes.projects)) {
          if (pName.toLowerCase().includes(targetProj) || targetProj.includes(pName.toLowerCase())) {
            scopedRules.push(...lines);
          }
        }
        if (!scopedRules.length) {
          let inTarget = false;
          for (const line of prof.content.split("\n")) {
            const hm = /^#{2,4}\s+([a-zA-Z0-9_\-\u4e00-\u9fa5]+)/.exec(line.trim());
            if (hm) {
              const hName = hm[1]!.toLowerCase();
              inTarget = hName.includes(targetProj) || targetProj.includes(hName);
              continue;
            }
            if (inTarget) {
              const st = line.trim();
              if (st.startsWith("-")) scopedRules.push(st.replace(/^[-* \t]+/, ""));
              else if (st.startsWith("#")) inTarget = false;
            }
          }
        }
      }
      scopedRules = scopedRules
        .map((line, i) => ({ line, i, sc: score(line, terms) }))
        .sort((a, b) => b.sc - a.sc || a.i - b.i)
        .map((x) => x.line);

      const genLines = scopes.general
        .split("\n")
        .filter((l) => l.trim().startsWith("-"))
        .map((l) => l.trim().replace(/^[-* \t]+/, "").replace(/[-* \t]+$/, ""))
        .filter(Boolean);
      generalRules = genLines.sort((a, b) => score(b, terms) - score(a, terms)).slice(0, 4);
    }
  } catch {
    /* ignore */
  }
  return [scopedRules, generalRules];
}

async function fetchGraphEntities(
  db: Db,
  user: { id: string },
  terms: string[],
  limitEntities: number,
  targetProject?: string | null,
  rankTerms?: string[],
) {
  const rk = rankTerms ?? terms;
  const out: { name: string; type: string; summary: string; observations: string[]; relations: string[] }[] = [];
  const valid = terms.slice(0, 12).map((t) => t.trim()).filter(Boolean);
  if (!valid.length) return out;
  try {
    const regexPattern = valid.map(escapeRegex).join("|");
    const entRows = await db
      .select()
      .from(knowledgeEntities)
      .where(
        and(
          eq(knowledgeEntities.userId, user.id),
          sql`(knowledge_entities.name || ' ' || coalesce(knowledge_entities.summary, '')) ~* ${regexPattern}`,
        ),
      )
      .orderBy(
        sql`CASE WHEN ${knowledgeEntities.name} ~* ${regexPattern} THEN 0 ELSE 1 END`,
        desc(knowledgeEntities.updatedAt),
      )
      .limit(ENTITY_CANDIDATES);

    const nowMs = Date.now();
    const affinity = (ent: typeof knowledgeEntities.$inferSelect) => {
      const base = score(`${ent.name} ${ent.summary || ""}`, rk) + 2 * score(ent.name, rk);
      const tMs = Date.parse(ent.updatedAt || ent.createdAt || "");
      const temporal = Number.isFinite(tMs) ? 1 / (1 + Math.max(0, (nowMs - tMs) / 86_400_000) / 7) : 0.5;
      let decayed = base * (0.4 + 0.6 * temporal);
      if (targetProject) {
        const lp = targetProject.toLowerCase();
        if (ent.name.toLowerCase().includes(lp) || (ent.summary || "").toLowerCase().includes(lp)) decayed += 15;
      }
      return decayed;
    };

    const sortedEnts = [...entRows].sort((a, b) => affinity(b) - affinity(a)).slice(0, limitEntities);
    if (!sortedEnts.length) return out;

    const entIds = sortedEnts.map((e) => e.id);
    const obsMap = new Map<string, string[]>(entIds.map((id) => [id, []]));
    const obsRows = await db
      .select({ eid: knowledgeObservations.entityId, content: knowledgeObservations.content })
      .from(knowledgeObservations)
      .where(inArray(knowledgeObservations.entityId, entIds))
      .orderBy(desc(knowledgeObservations.observedAt));
    for (const r of obsRows) {
      const list = obsMap.get(r.eid);
      if (list && list.length < 2) list.push(r.content);
    }

    const relMap = new Map<string, { rel: string; targetId: string; targetName: string }[]>(entIds.map((id) => [id, []]));
    const relRows = await db
      .select({
        sid: knowledgeRelations.sourceId,
        rtype: knowledgeRelations.relationType,
        tid: knowledgeEntities.id,
        tname: knowledgeEntities.name,
      })
      .from(knowledgeRelations)
      .innerJoin(knowledgeEntities, eq(knowledgeRelations.targetId, knowledgeEntities.id))
      .where(inArray(knowledgeRelations.sourceId, entIds));
    const targetIds: string[] = [];
    for (const r of relRows) {
      const list = relMap.get(r.sid);
      if (list && list.length < 2) {
        list.push({ rel: r.rtype, targetId: r.tid, targetName: r.tname });
        targetIds.push(r.tid);
      }
    }

    const secondHopMap = new Map<string, string[]>();
    if (targetIds.length) {
      const hop2Rows = await db
        .select({
          sid: knowledgeRelations.sourceId,
          rtype: knowledgeRelations.relationType,
          name: knowledgeEntities.name,
        })
        .from(knowledgeRelations)
        .innerJoin(knowledgeEntities, eq(knowledgeRelations.targetId, knowledgeEntities.id))
        .where(inArray(knowledgeRelations.sourceId, targetIds.slice(0, 6)));
      for (const r of hop2Rows) {
        const list = secondHopMap.get(r.sid) ?? [];
        if (list.length < 1) {
          list.push(`${r.rtype} → ${r.name}`);
          secondHopMap.set(r.sid, list);
        }
      }
    }

    for (const ent of sortedEnts) {
      const rels = (relMap.get(ent.id) ?? []).map((r) => {
        const h2 = secondHopMap.get(r.targetId);
        return h2?.length ? `${r.rel} → ${r.targetName} (${h2[0]})` : `${r.rel} → ${r.targetName}`;
      });
      out.push({
        name: ent.name,
        type: ent.entityType,
        summary: ent.staleAt ? "" : ent.summary || "",
        observations: obsMap.get(ent.id) ?? [],
        relations: rels,
      });
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function fetchPitfalls(
  db: Db,
  user: { id: string },
  terms: string[],
  limitPitfalls: number,
  targetProject?: string | null,
) {
  const out: { key: string; category: string; content: string }[] = [];
  if (!terms.length) return out;
  try {
    const allMems = await db
      .select()
      .from(userMemories)
      .where(
        and(
          eq(userMemories.userId, user.id),
          eq(userMemories.status, "active"),
          eq(userMemories.isFolder, false),
          inArray(userMemories.category, ["pitfall", "rule", "architecture"]),
        ),
      );
    const texts = allMems.map((m) => `${m.key} ${m.treePath || ""} ${m.content}`.toLowerCase());
    const n = Math.max(texts.length, PITFALL_MIN_CORPUS);
    const weight = new Map<string, number>();
    for (const t of new Set(terms)) {
      const spec = termSpecificity(t);
      if (spec > 0) {
        let df = 0;
        for (const x of texts) if (x.includes(t)) df++;
        weight.set(t, spec * Math.log((n + 1) / (1 + df)));
      }
    }
    const minScore = PITFALL_MIN_SHARE * Math.log((n + 1) / 2);
    const scored: { sc: number; m: (typeof allMems)[number] }[] = [];
    for (let i = 0; i < allMems.length; i++) {
      const m = allMems[i]!;
      const text = texts[i]!;
      let hit = [...weight.keys()].filter((t) => text.includes(t));
      hit = hit.filter((t) => !hit.some((o) => t !== o && o.includes(t)));
      let sc = hit.reduce((acc, t) => acc + (weight.get(t) ?? 0), 0);
      if (!hit.length || sc < minScore) continue;
      if (m.category === "pitfall") sc += 2;
      if (targetProject && (m.treePath || "").toLowerCase().includes(targetProject.toLowerCase())) sc += 2;
      scored.push({ sc, m });
    }
    scored.sort((a, b) => b.sc - a.sc);
    const best = scored[0]?.sc ?? 0;
    const handed: string[] = [];
    for (const { sc, m } of scored.slice(0, limitPitfalls)) {
      if (sc < PITFALL_KEEP_SHARE * best) break;
      out.push({ key: m.key, category: m.category, content: m.content });
      handed.push(m.id);
    }
    if (handed.length) void touchRecalled(db, handed);
  } catch {
    /* ignore */
  }
  return out;
}

async function resolveProjectName(db: Db, project: string | null | undefined): Promise<string | null> {
  const p = (project || "").trim();
  if (!p) return null;
  const uid = normalizeUuid(p);
  if (!uid) return p.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() || p;
  try {
    const [row] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, uid)).limit(1);
    return row?.title ?? null;
  } catch {
    return null;
  }
}

const ABOUT_PREFIXES = ["简介", "About", "项目", "定位", "概述"];

export function blueprintQuickSummary(md: string): string[] {
  const out: string[] = [];
  let inSec = false;
  for (const line of (md || "").split("\n")) {
    const s = line.trim();
    if (s.startsWith("## ")) {
      if (inSec) break;
      inSec = s.startsWith("## 0.");
      continue;
    }
    if (inSec && s.startsWith("- ")) {
      const item = s.slice(2).replaceAll("**", "").trim();
      if (!ABOUT_PREFIXES.some((p) => item.startsWith(p))) out.push(item);
    }
  }
  return out;
}

function quickSummary(raw: string, maxChars: number): string {
  const lines = blueprintQuickSummary(raw).map((x) => `- ${x}`);
  const out: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > maxChars) break;
    out.push(line);
    len += line.length + 1;
  }
  return out.join("\n");
}

export function summarizeBlueprintMarkdown(raw: string, maxChars = 1200): string {
  if (!raw || !CODE_BLUEPRINT_TITLES.some((t) => raw.includes(t))) return "";
  const quick = quickSummary(raw, maxChars);
  if (quick) {
    const title = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => CODE_BLUEPRINT_TITLES.some((t) => l.startsWith(t))) ?? "";
    return title ? `${title}\n${quick}` : quick;
  }
  const keep: string[] = [];
  let inMermaid = false;
  let total = 0;
  const prefixes = [
    ...CODE_BLUEPRINT_TITLES,
    "- **Project Type**:",
    "- **Core Languages**:",
    "- **Key Frameworks**:",
    "- **Infrastructure & Middleware**:",
    "| [`",
    "#### `/",
    "### Core Database Models",
  ];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (s.startsWith("```mermaid")) {
      inMermaid = true;
      continue;
    }
    if (inMermaid) {
      if (s.startsWith("```")) inMermaid = false;
      continue;
    }
    if ([">", "| :---", "## 2.", "## 6.", "## 7.", "## 9."].some((p) => s.startsWith(p))) continue;
    if (prefixes.some((p) => s.startsWith(p))) {
      const item = s.replaceAll("**", "");
      keep.push(item);
      total += item.length + 1;
    } else if (keep.length && keep[keep.length - 1]!.startsWith("### Core Database Models") && s.startsWith("`")) {
      const item = s.slice(0, 240);
      keep.push(item);
      total += item.length + 1;
    }
    if (total >= maxChars) break;
  }
  return keep.join("\n").slice(0, maxChars);
}

async function fetchProjectBlueprintSummary(
  db: Db,
  user: { id: string },
  projectName: string | null,
  rawProjectArg?: string | null,
): Promise<string> {
  const names: string[] = [];
  for (const cand of [projectName, rawProjectArg]) {
    if (!cand?.trim()) continue;
    const leaf = cand.trim().replace(/[/\\]+$/, "").split(/[/\\]/).pop()?.trim() || "";
    if (leaf && !names.includes(leaf) && !leaf.includes("%") && leaf !== "_") names.push(leaf);
  }
  if (!names.length) return "";
  try {
    const userMachines = await db.select({ id: machines.id }).from(machines).where(eq(machines.userId, user.id));
    if (!userMachines.length) return "";
    const mids = userMachines.map((m) => m.id);
    const conds = names.flatMap((name) => [
      ilike(projects.title, name),
      ilike(projects.slug, name),
      ilike(projects.slug, `%/${name}`),
      codeBlueprintPath(documents.relativePath, name),
    ]);
    const rows = await db
      .select({ content: documents.content, syncedAt: documents.syncedAt })
      .from(documents)
      .leftJoin(projects, eq(documents.projectId, projects.id))
      .where(and(or(...conds), codeBlueprintPath(documents.relativePath), inArray(documents.machineId, mids)))
      .orderBy(desc(documents.syncedAt))
      .limit(20);
    const best = pickFreshest(rows, (r) => r.content, (r) => r.syncedAt);
    return best?.content ? summarizeBlueprintMarkdown(best.content) : "";
  } catch {
    return "";
  }
}

function summarizeUserBlueprintMarkdown(raw: string, maxChars = 650): string {
  if (!raw || !raw.includes("# User Cognitive & Domain Blueprint")) return "";
  const quick = quickSummary(raw, maxChars);
  if (quick) return quick;
  const keep: string[] = [];
  let inMermaid = false;
  let currentSec = "";
  let total = 0;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (s.startsWith("```mermaid")) {
      inMermaid = true;
      continue;
    }
    if (inMermaid) {
      if (s.startsWith("```")) inMermaid = false;
      continue;
    }
    if (s.startsWith("## 2.")) currentSec = "disc";
    else if (s.startsWith("## 3.")) currentSec = "dom";
    else if (s.startsWith("## 4.")) currentSec = "proj";
    else if (s.startsWith("## ")) currentSec = "";
    else if ((currentSec === "disc" || currentSec === "dom" || currentSec === "proj") && s.startsWith("| **")) {
      const parts = s.replace(/^\||\|$/g, "").split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        const col0 = parts[0]!.replace(/<br\/>\*[^*]+\*/g, "").replaceAll("**", "").trim();
        const col1 = parts[1]!.replaceAll("**", "").trim();
        const col2 = parts[2]!.replaceAll("**", "").trim();
        const item = `- [${currentSec.toUpperCase()}] ${col0}: ${col1} (${col2})`;
        keep.push(item);
        total += item.length + 1;
      }
    }
    if (total >= maxChars) break;
  }
  return keep.join("\n").slice(0, maxChars);
}

// ---- Live & durable correction rules ----
const RULES_FALLBACK_MAX = 500;
const rulesFallback = new Map<string, string[]>();

function rememberFallback(key: string, rules: string[]): void {
  rulesFallback.delete(key);
  rulesFallback.set(key, rules);
  while (rulesFallback.size > RULES_FALLBACK_MAX) {
    const first = rulesFallback.keys().next().value;
    if (first !== undefined) rulesFallback.delete(first);
  }
}

async function loadRules(redis: Redis | null, key: string): Promise<string[]> {
  if (redis) {
    try {
      const raw = await redis.get(key);
      rulesFallback.delete(key);
      if (raw === null) return [];
      const val = JSON.parse(raw);
      return Array.isArray(val) ? val.map(String) : [];
    } catch {
      /* fallback */
    }
  }
  return [...(rulesFallback.get(key) ?? [])];
}

async function storeRules(redis: Redis | null, key: string, rules: string[], ttlSec: number): Promise<void> {
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(rules), "EX", ttlSec);
      rulesFallback.delete(key);
      return;
    } catch {
      /* fallback */
    }
  }
  rememberFallback(key, rules);
}

const QUESTION_PARTICLES = ["?", "？", "为什么", "怎么", "如何", "是不是", "能不能", "要不要", "有没有", "行不行", "好不好", "能否", "可否", "请问", "吗", "呢", "吧", "为何"];
const DIRECTIVE_PREFIXES = ["以后", "今后", "后续", "下次", "切记", "记住", "务必", "千万", "所有对话", "每次"];
const ACTION_DIRECTIVE_PREFIXES = ["回答时", "回复时", "写代码时", "交付前", "交付时", "输出时", "排查时", "回答", "回复", "回复中", "回答中", "发版", "发布", "部署", "提交", "改动", "重跑", "测试"];
const DIRECTIVE_WORDS_RE = /不要|严禁|杜绝|必须|统一|只能|只用|(?<![特区识级个差告类性派分辨鉴])别(?![人的])/;

export function extractLiveCorrectionRules(text: string): string[] {
  if (!text) return [];
  const rules: string[] = [];
  for (const rawClause of text.split(/[\n。；;！!，,]/)) {
    const clause = rawClause.replace(/^[ ，,、\t\r]+|[ ，,、\t\r]+$/g, "");
    if (clause.length < 4 || clause.length > 60) continue;
    if (QUESTION_PARTICLES.some((q) => clause.includes(q))) continue;
    if (["报错", "异常", "失败原因", "为什么", "提示", "堆栈"].some((e) => clause.includes(e))) continue;
    let matched: string | null = null;
    if (DIRECTIVE_PREFIXES.some((p) => clause.startsWith(p)) && DIRECTIVE_WORDS_RE.test(clause)) matched = clause;
    else if (ACTION_DIRECTIVE_PREFIXES.some((p) => clause.startsWith(p)) && DIRECTIVE_WORDS_RE.test(clause)) matched = clause;
    else if (/(?:不要|(?<![特区识级个差告类性派分辨鉴])别|严禁|杜绝)\s*(?:在|用|加|使用|包含|反问|回滚|删除|臆测|编造|截断|乱动)/.test(clause)) matched = clause;
    else if (/(?:必须|统一)\s*(?:用|在|按照|保持|使用|确认|检查|自测|先|打|记录)/.test(clause)) matched = clause;
    if (matched) {
      const clean = matched.replace(/^[ ，,、*#\- ]+|[ ，,、*#\- ]+$/g, "");
      if (clean.length >= 4 && !rules.includes(clean)) rules.push(clean);
    }
  }
  return rules.slice(0, 4);
}

async function incrementRuleFrequency(redis: Redis | null, userId: string, rule: string): Promise<number> {
  if (!redis) return 1;
  const hash = createHash("md5").update(rule.trim()).digest("hex").slice(0, 12);
  const key = `rule_freq:${userId}:${hash}`;
  try {
    const pipe = redis.pipeline();
    pipe.incr(key);
    pipe.expire(key, 86400 * 7);
    const res = await pipe.exec();
    return Number(res?.[0]?.[1] ?? 1);
  } catch {
    return 1;
  }
}

export async function getUserDurableCorrections(redis: Redis | null, userId: string): Promise<string[]> {
  return loadRules(redis, `user_durable_corrections:${userId}`);
}

export async function saveUserDurableCorrection(redis: Redis | null, userId: string, rule: string): Promise<string[]> {
  const cleanR = rule.replace(/^[-*# \t\n]+|[-*# \t\n]+$/g, "");
  if (cleanR.length < 3) return [];
  const key = `user_durable_corrections:${userId}`;
  const combined = await getUserDurableCorrections(redis, userId);
  if (!combined.includes(cleanR)) combined.push(cleanR);
  const trimmed = combined.slice(-20);
  await storeRules(redis, key, trimmed, 86400 * 7);
  return trimmed;
}

export async function getSessionLiveRules(redis: Redis | null, userId: string, conversationId: string): Promise<string[]> {
  if (!conversationId) return [];
  return loadRules(redis, `session_live_rules:${userId}:${conversationId}`);
}

export async function saveSessionLiveRules(
  redis: Redis | null,
  userId: string,
  conversationId: string,
  newRules: string[],
): Promise<string[]> {
  if (!conversationId || !newRules.length) return [];
  const key = `session_live_rules:${userId}:${conversationId}`;
  const combined = await getSessionLiveRules(redis, userId, conversationId);
  for (const r of newRules) {
    if (!combined.includes(r)) combined.push(r);
    const explicit = ["以后", "今后", "记住", "切记", "所有对话", "永久"].some((k) => r.includes(k));
    if (explicit || (await incrementRuleFrequency(redis, userId, r)) >= 2) {
      await saveUserDurableCorrection(redis, userId, r);
    }
  }
  const trimmed = combined.slice(-10);
  await storeRules(redis, key, trimmed, 7200);
  return trimmed;
}

export interface ResonancePayload {
  scenario: DomainScenario;
  mindset: string;
  scoped_rules: string[];
  general_rules: string[];
  entities: { name: string; type: string; summary: string; observations: string[]; relations: string[] }[];
  pitfalls: { key: string; category: string; content: string }[];
  durable_corrections: string[];
  blueprint_summary: string;
  user_blueprint_summary: string;
  live_rules?: string[];
}

export async function senseResonance(
  db: Db,
  redis: Redis | null,
  user: { id: string },
  opts: { query?: string | null; project?: string | null; action?: string | null; limitEntities?: number; limitPitfalls?: number } = {},
): Promise<ResonancePayload> {
  const rawProjectArg = opts.project ?? null;
  const qText = cleanText(opts.query || "");
  const project = await resolveProjectName(db, rawProjectArg);
  const topicAction = opts.action && DISPATCH_ACTIONS.has(opts.action.toLowerCase()) ? null : (opts.action ?? null);
  const terms = termsFor(topicAction, project, qText);
  const matchTerms = terms.filter((t) => t.length >= 2);
  const topicTerms = termsFor(topicAction, qText).filter((t) => t.length >= 2);
  const rankTerms = topicTerms.length ? topicTerms : matchTerms;

  let scenario = detectScenario(termsFor(topicAction, qText), `${qText} ${topicAction || ""}`);
  if (scenario.id === "general_engineering" && project) {
    scenario = detectScenario(terms, `${qText} ${project} ${topicAction || ""}`);
  }
  const effectiveProject = project || scenario.target_project;

  const [durableCorrections, [scopedRules, generalRules], entitiesData, pitfallsData, blueprintSummary, cachedUserBp] = await Promise.all([
    getUserDurableCorrections(redis, user.id),
    fetchScopedAndGeneralRules(db, user, matchTerms, scenario, project),
    fetchGraphEntities(db, user, matchTerms, opts.limitEntities ?? 4, project, rankTerms),
    fetchPitfalls(db, user, pitfallTerms(qText, topicAction), opts.limitPitfalls ?? 4, project),
    fetchProjectBlueprintSummary(db, user, effectiveProject, rawProjectArg),
    cacheGet(redis, `user:blueprint:v4:${user.id}`).catch(() => null),
  ]);

  const ubpMd =
    cachedUserBp && typeof cachedUserBp === "object" && typeof (cachedUserBp as { markdown?: unknown }).markdown === "string"
      ? (cachedUserBp as { markdown: string }).markdown
      : "";
  if (!ubpMd) warmUserBlueprint(db, () => redis, user);
  const userBlueprintSummary = ubpMd ? summarizeUserBlueprintMarkdown(ubpMd) : "";

  return {
    scenario,
    mindset: scenario.mindset,
    scoped_rules: scopedRules,
    general_rules: generalRules,
    entities: entitiesData,
    pitfalls: pitfallsData,
    durable_corrections: durableCorrections,
    blueprint_summary: blueprintSummary,
    user_blueprint_summary: userBlueprintSummary,
  };
}

export function renderMindResonanceMarkdown(res: ResonancePayload, liveRules?: string[] | null): string {
  const scen = res.scenario;
  const lines = [
    "【心领神会·默契前置激活层 (Mind Resonance)】",
    `识别场景：${scen?.name || "通用工程"} ｜ 核心心智模型：${res.mindset || ""}`,
  ];
  const activeLive = liveRules?.length ? liveRules : (res.live_rules ?? []);
  if (activeLive.length) {
    lines.push("\n【当前会话实时纠偏与行为守则（用户在本会话中特别强调，必须绝对遵守）】：");
    for (const lr of activeLive.slice(0, 5)) lines.push(`- ${lr.replace(/^[-* ]+|[-* ]+$/g, "")}`);
  }
  if (res.durable_corrections?.length) {
    lines.push("\n【用户历史多轮强化纠偏铁律（已通过自进化沉淀，必须严格遵守）】：");
    for (const dr of res.durable_corrections.slice(-5)) lines.push(`- ${dr.replace(/^[-* ]+|[-* ]+$/g, "")}`);
  }
  if (res.scoped_rules?.length) {
    lines.push("\n当前场景专项铁律与深层偏好：");
    for (const r of res.scoped_rules.slice(0, 5)) lines.push(`- ${r.replace(/^[-* ]+|[-* ]+$/g, "")}`);
  } else if (res.general_rules?.length) {
    lines.push("\n高优先级通用协作准则：");
    for (const g of res.general_rules.slice(0, 3)) lines.push(`- ${g.replace(/^[-* ]+|[-* ]+$/g, "")}`);
  }
  if (res.entities?.length) {
    lines.push("\n知识图谱前置热激活实体网络（背景事实与已定决策）：");
    for (const e of res.entities) {
      lines.push(`- 实体「${e.name}」(${e.type})${e.summary ? `：${e.summary}` : ""}`);
      for (const obs of e.observations || []) lines.push(`  · 沉淀经验: ${obs}`);
      for (const rel of e.relations || []) lines.push(`  · 关联关系: ${rel}`);
    }
  }
  if (res.pitfalls?.length) {
    lines.push("\n历史避坑与防御性预警（历史上类似场景踩过的深坑，绝不能重复出现）：");
    for (const p of res.pitfalls) lines.push(`- 避坑提醒 [${p.key}]：${p.content}`);
  }
  if (res.blueprint_summary?.trim()) {
    lines.push("\n【目标项目代码蓝图快照 (CODE_BLUEPRINT.md)】：", res.blueprint_summary.trim());
  } else if (res.user_blueprint_summary?.trim()) {
    lines.push("\n【用户个人全域认知与项目矩阵蓝图 (USER_BLUEPRINT.md)】：", res.user_blueprint_summary.trim());
  }
  lines.push("\n心领神会行动要求：严格基于上述心智模型与图谱关联展开工作，不反问用户，直达终局。");
  return lines.join("\n");
}

export function cleanGuardrailOutput(text: string): string {
  if (!text) return "";
  const parts = text.split("```");
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!.replace(/\*\*([^\n*]+?)\*\*/g, "$1").replace(/\*\*/g, "");
  }
  return parts.join("```");
}

export async function recordOnlineGraphObservation(
  db: Db,
  redis: Redis | null,
  userId: string,
  entityName: string,
  observationContent: string,
  opts: { entityType?: string; summary?: string | null } = {},
) {
  const cleanName = (entityName || "").trim();
  const cleanObs = (observationContent || "").trim();
  if (!userId || !cleanName || !cleanObs) return null;
  const entityType = opts.entityType ?? "technology";
  try {
    let entity = await findEntity(db, userId, cleanName, entityType);
    const nowIso = new Date().toISOString();
    if (!entity) {
      const id = randomUUID();
      const [inserted] = await db
        .insert(knowledgeEntities)
        .values({
          id,
          userId,
          name: cleanName,
          entityType,
          summary: opts.summary || cleanObs.slice(0, 150),
          aliases: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .returning();
      entity = inserted ?? null;
    } else {
      await db
        .update(knowledgeEntities)
        .set({ summary: entity.summary || opts.summary || null, updatedAt: nowIso })
        .where(eq(knowledgeEntities.id, entity.id));
    }
    if (!entity) return null;

    const [dup] = await db
      .select()
      .from(knowledgeObservations)
      .where(and(eq(knowledgeObservations.entityId, entity.id), eq(knowledgeObservations.content, cleanObs)))
      .limit(1);
    if (dup) return dup;

    const [obs] = await db
      .insert(knowledgeObservations)
      .values({ id: randomUUID(), entityId: entity.id, content: cleanObs, observedAt: nowIso })
      .returning();
    await cacheDeletePrefix(redis, `memory:resonance:${userId}`).catch(() => {});
    return obs ?? null;
  } catch {
    return null;
  }
}

export function validateShellCommandAgainstIronRules(
  command: string,
  machineName = "",
  platformHint = "",
): [boolean, string | null] {
  const cmdLower = command.trim().toLowerCase();
  const dangerousDb = [/\bdrop\s+database\b/, /\bdrop\s+table\b/, /\btruncate\s+table\b/, /\btruncate\b\s+[a-zA-Z0-9_]+/];
  for (const pat of dangerousDb) {
    if (pat.test(cmdLower)) {
      return [false, "【用户铁律守门拦截】：严禁执行未经备份的物理硬删除！修改或清空数据前必须先备份原表数据；数据操作倾向打标记归档而非物理删除，便于审计。"];
    }
  }
  const dangerousRm = [
    /\brm\s+-(?:r|rf|fr)\s+\/(?:\s|$)/,
    /\brm\s+-(?:r|rf|fr)\s+\/data2?(?:\s|\/|$)/,
    /\brm\s+-(?:r|rf|fr)\s+~\/?(?:\s|$)/,
    /\brm\s+-(?:r|rf|fr)\s+\*$/,
  ];
  for (const pat of dangerousRm) {
    if (pat.test(cmdLower)) {
      return [false, "【系统安全防线】：检测到针对根目录、用户主目录或核心数据目录的破坏性递归删除命令，已被拦截。请改用精细化、可审计的归档清理策略。"];
    }
  }
  if (["run_all", "batch_run", "harvest_all", "reindex_all"].some((k) => cmdLower.includes(k))) {
    if (!cmdLower.includes("--version") && !cmdLower.includes("-v ")) {
      return [true, "【用户铁律提醒】：已标注的数据不要重跑，重跑需带版本号；重跑前先确认已停掉旧服务/旧任务，且只针对指定范围。"];
    }
  }
  const plat = (platformHint || machineName).toLowerCase();
  const isMac = ["mac", "darwin", "mbp", "apple", "imac", "mini"].some((k) => plat.includes(k));
  const isLinux = ["linux", "ubuntu", "debian", "centos", "server"].some((k) => plat.includes(k));
  if (isMac && ["systemctl ", "apt-get ", "apt ", "yum ", "journalctl "].some((t) => cmdLower.includes(t))) {
    return [false, `【平台指令不匹配】：目标设备「${machineName}」为 macOS 环境，不支持 systemctl/apt/yum 等 Linux 命令。请选用 Linux 运算设备或改用 macOS 对应命令（如 brew / launchctl）。`];
  }
  if (isLinux && ["osascript ", "pbcopy", "pbpaste", "open -a "].some((t) => cmdLower.includes(t))) {
    return [false, `【平台指令不匹配】：目标设备「${machineName}」为 Linux 环境，不支持 AppleScript 或 macOS 专属命令。请选用 Mac 设备执行。`];
  }
  return [true, null];
}

function resolveScenarioMeta(scenario: Partial<DomainScenario>): Partial<DomainScenario> {
  if (scenario.id) {
    const reg = activeScenarios.find((s) => s.id === scenario.id);
    if (reg) return { ...reg, ...scenario };
  }
  return scenario;
}

export function enrichSearchQueryWithMindset(query: string, scenario: Partial<DomainScenario>): string {
  const cleanQ = query.trim();
  if (cleanQ.length > 40) return cleanQ;
  const scen = resolveScenarioMeta(scenario);
  const extras = scen.search_query_extras || "";
  if (!extras) return cleanQ;
  const words = extras.split(/\s+/).filter((w) => w && !cleanQ.toLowerCase().includes(w.toLowerCase()));
  return words.length ? `${cleanQ} ${words.join(" ")}` : cleanQ;
}

export function enrichSkillWithMindset(skillMd: string, scenario: Partial<DomainScenario>): string {
  const scen = resolveScenarioMeta(scenario);
  const defense = scen.defense_rules?.length
    ? scen.defense_rules
    : [
        "1) 仔细深入调查问题，从根子上彻底解决；一次做到位，交付前本地类型检查与自测确认通过。",
        "2) 直接给结论和指令，不绕弯子、不废话、不反问用户。",
      ];
  return `${skillMd.trimEnd()}\n\n【心领神会·本操作专项执行防线与心智铁律】：\n${defense.join("\n")}`;
}

export function enrichCheckRulesResult(guidanceMd: string, resonance: ResonancePayload): string {
  const sections = [guidanceMd.trim()];
  const mindLines = [
    `\n【心领神会·场景综合心智感知 (${resonance.scenario?.name || "工程研发"})】`,
    `核心导向：${resonance.mindset || ""}`,
  ];
  if (resonance.scoped_rules.length) {
    mindLines.push("\n【当前项目专项铁律与深层偏好】：");
    for (const r of resonance.scoped_rules.slice(0, 5)) mindLines.push(`- ${r.replace(/^[-* ]+|[-* ]+$/g, "")}`);
  } else if (resonance.general_rules.length) {
    mindLines.push("\n【高优先级通用协作准则】：");
    for (const g of resonance.general_rules.slice(0, 3)) mindLines.push(`- ${g.replace(/^[-* ]+|[-* ]+$/g, "")}`);
  }
  if (resonance.durable_corrections.length) {
    mindLines.push("\n【跨会话强化铁律（用户多轮纠偏记忆）】：");
    for (const d of resonance.durable_corrections.slice(0, 4)) mindLines.push(`- ${d.replace(/^[-* ]+|[-* ]+$/g, "")}`);
  }
  if (resonance.entities.length) {
    mindLines.push("\n【相关知识图谱实体与历史决策】：");
    for (const e of resonance.entities.slice(0, 3)) {
      const obs = e.observations?.[0] ? `（${e.observations[0]}）` : "";
      mindLines.push(`- ${e.name}${obs}`);
    }
  }
  if (resonance.pitfalls.length) {
    mindLines.push("\n【必须坚决规避的历史踩坑】：");
    for (const p of resonance.pitfalls.slice(0, 3)) mindLines.push(`- ${p.key}：${p.content.slice(0, 120)}`);
  }
  if (resonance.blueprint_summary.trim()) {
    mindLines.push("\n【目标项目代码蓝图快照 (CODE_BLUEPRINT.md)】：", resonance.blueprint_summary.trim());
  }
  if (resonance.user_blueprint_summary.trim()) {
    mindLines.push("\n【用户个人全域认知与项目矩阵蓝图 (USER_BLUEPRINT.md)】：", resonance.user_blueprint_summary.trim());
  }
  sections.push(mindLines.join("\n"));
  return sections.filter((s) => s.trim()).join("\n\n");
}

export function enrichTodoCreation(
  title: string,
  project: string | null | undefined,
  scenario: Partial<DomainScenario>,
): [string, string | null, string | null] {
  const cleanTitle = title.trim();
  const scen = resolveScenarioMeta(scenario);
  const proj = (project || "").trim() || scen.target_project || null;
  const hint = ["现在", "马上", "立即", "正在", "当前"].some((k) => cleanTitle.includes(k))
    ? "【用户心智规约提示】：当前就要做的事不要记为待办，应由智能体直接执行完成；待办仅用于沉淀后续跟进事项。"
    : null;
  return [cleanTitle, proj, hint];
}

export function enrichDeviceListing(devices: Record<string, unknown>[], scenario: Partial<DomainScenario>): Record<string, unknown>[] {
  const scen = resolveScenarioMeta(scenario);
  const preferredOs = scen.device_affinity;
  return devices.map((d) => {
    const copy = { ...d };
    const nameLower = String(d.name ?? "").toLowerCase();
    const isMac = ["mac", "darwin", "mbp", "apple", "imac", "mini"].some((k) => nameLower.includes(k));
    const isLinux = ["linux", "ubuntu", "debian", "centos", "server"].some((k) => nameLower.includes(k));
    copy.affinity = isMac
      ? "推荐用于 Mac 本地开发 / 前端 UI 调试 / AppleScript / 客户端打包"
      : isLinux
        ? "推荐用于 Linux / 高并发后端 / 化学逆合成 / /data2 数据集抓取与处理"
        : "通用设备节点";
    if ((preferredOs === "linux" && isLinux) || (preferredOs === "mac" && isMac)) copy.scenario_best_match = true;
    return copy;
  });
}
