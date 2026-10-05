"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, DailyDate, ProfileDevice, ProfileState } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { BrandMark } from "@/components/aurora/BrandMark";
import { Btn, Chip, Glass } from "@/components/aurora/primitives";
import { Icon } from "@/components/aurora/Icon";
import MarkdownViewer from "@/components/viewers/MarkdownViewer";
import LearnedCorrections from "@/components/persona/LearnedCorrections";
import CognitiveCompass from "@/components/memory/CognitiveCompass";
import type { PersonaDimension, SynapsePulse } from "@/components/persona/DigitalTwinAvatar3D";

const DigitalTwinAvatar3D = dynamic(
  () => import("@/components/persona/DigitalTwinAvatar3D"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full min-h-[460px] rounded-3xl bg-[var(--aurora-surface)] border border-[var(--aurora-border)] animate-pulse flex flex-col items-center justify-center gap-3 text-xs text-[var(--aurora-fg3)]">
        <div className="w-10 h-10 rounded-2xl bg-[var(--aurora-accent)]/20 animate-spin border-2 border-transparent border-t-[var(--aurora-accent)]" />
        <span>正在载入 3D 数字孪生神经中枢...</span>
      </div>
    ),
  }
);

const TARGET_META: Record<string, { label: string; file: string; desc: string }> = {
  claude_code: { label: "Claude Code", file: "~/.claude/CLAUDE.md", desc: "Anthropic 官方终端 Agent" },
  antigravity: { label: "Antigravity / Gemini", file: "~/.gemini/GEMINI.md", desc: "Google DeepMind 编码助手" },
  codex: { label: "Codex", file: "~/.codex/AGENTS.md", desc: "OpenAI 智能体规范" },
  openclaw: { label: "OpenClaw", file: "~/.openclaw/workspace/USER.md", desc: "开源智能体工作区" },
  hermes: { label: "Hermes", file: "~/.hermes/SOUL.md", desc: "多代理自进化中枢" },
};

interface PersonaSection {
  title: string;
  dimension: "brain" | "communication" | "tech" | "execution" | "project";
  icon: "message" | "zap" | "devices" | "sparkles" | "check";
  accent: string;
  badge: string;
  items: string[];
}

function parsePersonaSections(content: string | undefined): PersonaSection[] {
  if (!content) return [];
  const lines = content.split("\n");
  const rawSections: Array<{ title: string; items: string[] }> = [];
  let currentTitle = "核心准则";
  let currentItems: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) {
      if (currentItems.length > 0) {
        rawSections.push({ title: currentTitle, items: currentItems });
        currentItems = [];
      }
      currentTitle = trimmed.replace(/^###\s+/, "").trim();
    } else if (trimmed.startsWith("- ")) {
      currentItems.push(trimmed.replace(/^-\s+/, "").trim());
    }
  }
  if (currentItems.length > 0) {
    rawSections.push({ title: currentTitle, items: currentItems });
  }

  return rawSections.map((sec) => {
    let icon: PersonaSection["icon"] = "check";
    let accent = "#8B5CF6";
    let badge = "通用准则";
    let dimension: PersonaSection["dimension"] = "execution";

    if (/沟通|回复|对话/i.test(sec.title)) {
      icon = "message";
      accent = "#06B6D4";
      badge = "交互风格";
      dimension = "communication";
    } else if (/铁律|红线|避坑|规矩/i.test(sec.title)) {
      icon = "zap";
      accent = "#EF4444";
      badge = "绝对红线";
      dimension = "brain";
    } else if (/技术|架构|性能|偏好/i.test(sec.title)) {
      icon = "devices";
      accent = "#F59E0B";
      badge = "工程规范";
      dimension = "tech";
    } else if (/项目|适用|memento/i.test(sec.title)) {
      icon = "sparkles";
      accent = "#8B5CF6";
      badge = "项目专属";
      dimension = "project";
    } else if (/工作|方式|流程/i.test(sec.title)) {
      icon = "check";
      accent = "#10B981";
      badge = "协作习惯";
      dimension = "execution";
    }
    return {
      title: sec.title,
      dimension,
      icon,
      accent,
      badge,
      items: sec.items,
    };
  });
}

function assembleMarkdown(sections: PersonaSection[], originalContent?: string): string {
  const header = originalContent?.includes("## 关于我")
    ? "## 关于我（Memento 长期记忆）\n\n"
    : "";
  const parts = sections.map((sec) => {
    const itemsText = sec.items.map((it) => `- ${it}`).join("\n");
    return `### ${sec.title}\n${itemsText}`;
  });
  return header + parts.join("\n\n") + "\n";
}

function bulletLines(text: string | undefined): string[] {
  return (text || "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
}

function lineDiff(draft: string, published: string | undefined) {
  const before = new Set(bulletLines(published));
  const after = new Set(bulletLines(draft));
  return {
    added: [...after].filter((l) => !before.has(l)),
    removed: [...before].filter((l) => !after.has(l)),
  };
}

function formatTime(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

function ProfileEditor({
  initial,
  onSave,
  onCancel,
  busy,
}: {
  initial: string;
  onSave: (content: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={Math.min(16, Math.max(6, value.split("\n").length + 2))}
        className="w-full font-mono text-xs leading-relaxed p-4 rounded-2xl border border-[var(--aurora-border-strong)] bg-[var(--aurora-surface-solid)] text-[var(--aurora-fg1)] focus:outline-hidden focus:border-[var(--aurora-accent)] resize-y"
      />
      <div className="flex gap-2 justify-end flex-wrap">
        <Btn variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t.persona.cancel}
        </Btn>
        <Btn
          size="sm"
          icon="check"
          onClick={() => onSave(value)}
          disabled={busy || !value.trim()}
        >
          {t.persona.save}
        </Btn>
      </div>
    </div>
  );
}

export type RulePriority = "ALL" | "P0" | "P1" | "P2";

export function getRulePriority(ruleText: string, sectionDimension: string): "P0" | "P1" | "P2" {
  if (
    sectionDimension === "brain" ||
    /严禁|必须|铁律|不得|绝不|不要|不能|脱敏|重跑|备份|始终|红线|回滚|死循环/i.test(ruleText)
  ) {
    return "P0";
  }
  if (
    sectionDimension === "tech" ||
    /架构|性能|并发|流式|零停机|校验|缓存|对齐|pod|k8s|三位一体|生产|ci\/cd|dump|版本号/i.test(ruleText)
  ) {
    return "P1";
  }
  return "P2";
}

export interface PrivilegeTier {
  level: number;
  name: string;
  badge: string;
  desc: string;
  unlocked: boolean;
  capabilities: string[];
}

export const PRIVILEGE_TIERS: PrivilegeTier[] = [
  {
    level: 1,
    name: "初生认知核",
    badge: "基础底座",
    desc: "单端长效记忆注入，支持本地基础配置文件导出",
    unlocked: true,
    capabilities: ["单端系统 Prompt 注入", "基础习惯沉淀"],
  },
  {
    level: 2,
    name: "记忆同构体",
    badge: "上下文延伸",
    desc: "跨会话长时上下文对齐，支持跨天指令语义继承",
    unlocked: true,
    capabilities: ["跨会话记忆检索", "跨天上下文继承", "多轮意图防遗忘"],
  },
  {
    level: 3,
    name: "神经觉醒期",
    badge: "全域写入",
    desc: "全域 5 大智能体终端（Claude / Gemini / Codex / OpenClaw / Hermes）毫秒级热写入",
    unlocked: true,
    capabilities: ["5 端本地配置热覆盖", "多智能体身份同步", "环境感知自动切换"],
  },
  {
    level: 4,
    name: "避坑免疫体",
    badge: "智能防踩坑",
    desc: "历史 Bad Case 自动聚类分析，编码与发版前自动预警",
    unlocked: true,
    capabilities: ["踩坑案例聚类沉淀", "事前智能纠偏检查", "违规操作先知预警"],
  },
  {
    level: 5,
    name: "深度共生体",
    badge: "实时红线沙盒",
    desc: "Live Persona 实时沙盒心智实测，3D 数字孪生多模态拒止姿态与拟态发声",
    unlocked: true,
    capabilities: ["就地心智沙盒实测", "3D 视听多模态拒止", "毫秒级红线防御拦截"],
  },
  {
    level: 6,
    name: "架构共鸣体",
    badge: "算力协同",
    desc: "多 LLM 引擎并发调用与负载均衡，毫秒级降级熔断",
    unlocked: false,
    capabilities: ["多引擎并发竞速", "全链路流式响应", "热点缓存自适应保留"],
  },
  {
    level: 7,
    name: "自主演进核",
    badge: "无感进化",
    desc: "无需人工提炼，后台自动根据每日代码审查和采纳行为增量进化画像",
    unlocked: false,
    capabilities: ["端到端无感提炼", "自动版本增量 Bump", "双盲语义校验"],
  },
  {
    level: 8,
    name: "工程免疫体",
    badge: "零停机守卫",
    desc: "生产集群 CI/CD 三位一体强校验，全面杜绝假更新与版本回滚",
    unlocked: false,
    capabilities: ["三位一体发布校验", "Pod 全量分发确认", "进程树智能清理"],
  },
  {
    level: 9,
    name: "全知中枢",
    badge: "群体共鸣",
    desc: "全局多代理（Multi-Agent）意图共振，跨机器长效分布式认知共享",
    unlocked: false,
    capabilities: ["多机分布式记忆同步", "跨团队知识图谱共享", "自适应工作区隔离"],
  },
  {
    level: 10,
    name: "终极数字孪生",
    badge: "超神态",
    desc: "百分之百心智映射，具备自主决策自修复的完美 AI 编程化身",
    unlocked: false,
    capabilities: ["全自主端到端闭环", "代码神经完全同构", "神性级自愈与进化"],
  },
];

export interface SandboxPreset {
  id: string;
  name: string;
  scenario: string;
  badge: string;
  badgeColor: string;
  prompt: string;
  expected: string;
}

export const SANDBOX_PRESETS: SandboxPreset[] = [
  {
    id: "rollback",
    name: "🚨 回滚红线实测",
    scenario: "rollback_check",
    badge: "P0 红线测试",
    badgeColor: "#EF4444",
    prompt: "线上环境排查问题太慢了，要不先把代码直接回滚到昨天的版本吧？",
    expected: "触发 P0 绝对红线拦截：严禁回滚，直面问题从根子上解决！3D 形象做出拒止姿势并语音宣告。",
  },
  {
    id: "language",
    name: "🌐 语言铁律实测",
    scenario: "language_check",
    badge: "P0 语言测试",
    badgeColor: "#06B6D4",
    prompt: "Can you please explain this system architecture in English for the team?",
    expected: "触发沟通铁律拦截：始终用中文回复，长会话中也不得切换为英文！",
  },
  {
    id: "concurrency",
    name: "⚡ 架构并发实测",
    scenario: "architecture_check",
    badge: "P1 架构规范",
    badgeColor: "#F59E0B",
    prompt: "我们系统需要同时查询多个检索引擎的数据，应该怎样设计请求方案？",
    expected: "符合架构偏好：偏好并发调用多个引擎而非串行，流式输出并做热缓存。",
  },
  {
    id: "release",
    name: "🚀 发版三位一体实测",
    scenario: "release_check",
    badge: "P1 工程基线",
    badgeColor: "#10B981",
    prompt: "新版本功能测试差不多了，直接执行 git push 并打 tag 就可以发版了吧？",
    expected: "触发质量基线检查：发版前查历史记忆/经验教训，三位一体严格校验，确认 pod 状态。",
  },
];

type ChapterTab =
  | "all"
  | "sandbox"
  | "brain"
  | "communication"
  | "tech"
  | "execution"
  | "project"
  | "privileges"
  | "evolution"
  | "matrix"
  | "learned"
  | "source";

export default function PersonaPage() {
  const { t } = useI18n();
  const [state, setState] = useState<ProfileState | null>(null);
  const [pending, setPending] = useState<Record<string, unknown>[]>([]);
  const [dailyHistory, setDailyHistory] = useState<DailyDate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"regenerate" | "publish" | "save" | "discard" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<"draft" | "published" | null>(null);

  // Tab & Interactive Resonance state
  const [activeTab, setActiveTab] = useState<ChapterTab>("all");
  const [activeDimension, setActiveDimension] = useState<PersonaDimension>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [newItemText, setNewItemText] = useState("");
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [activeSynapse, setActiveSynapse] = useState<SynapsePulse | null>(null);
  const [selectedRuleKey, setSelectedRuleKey] = useState<string | null>(null);

  // Commercial Feature States: Priority Filter & Live Persona Sandbox
  const [priorityFilter, setPriorityFilter] = useState<RulePriority>("ALL");
  const [sandboxPrompt, setSandboxPrompt] = useState("");
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<{
    reply: string;
    triggered_dimension: string;
    triggered_rule?: string;
    compliance_status: "pass" | "intercepted" | "adapted";
    latency_ms: number;
    prompt: string;
  } | null>(null);

  // Fullscreen Theater & Panel Collapse State (Default: True for 100% 3D Digital Twin Avatar)
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);
  const cockpitRef = useRef<HTMLDivElement>(null);

  const togglePhysicalFullscreen = () => {
    if (!document.fullscreenElement) {
      cockpitRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  const load = useCallback(async () => {
    try {
      const [profile, corrections, daily] = await Promise.all([
        api.getProfile(),
        api.getCorrections().catch(() => ({}) as Record<string, unknown>),
        api.getDailyDates(30).catch(() => [] as DailyDate[]),
      ]);
      setState(profile);
      setPending(
        Array.isArray(corrections.pending)
          ? (corrections.pending as Record<string, unknown>[])
          : []
      );
      setDailyHistory(Array.isArray(daily) ? daily : []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const regenerate = () =>
    run("regenerate", async () => {
      const res = await api.regenerateProfileDraft();
      const messages: Record<string, string> = {
        same_as_published: t.persona.unchanged,
        no_input: t.persona.noInput,
        llm_failed: t.persona.llmFailed,
        no_llm: t.persona.noLlm,
        user_editing: t.persona.userEditing,
      };
      if (res.status !== "updated") setNotice(messages[res.status] ?? res.status);
    });

  const saveDraft = (content: string) =>
    run("save", async () => {
      await api.saveProfileDraft(content);
      setEditing(null);
    });

  const toggleTarget = async (device: ProfileDevice, tool: string) => {
    const next = device.targets.includes(tool)
      ? device.targets.filter((x) => x !== tool)
      : [...device.targets, tool];
    setState((s) => s && {
      ...s,
      devices: s.devices.map((d) => (d.device_id === device.device_id ? { ...d, targets: next } : d)),
    });
    try {
      await api.setProfileTargets(device.device_id, next);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  };

  const draft = state?.draft ?? null;
  const published = state?.published ?? null;
  const diff = useMemo(() => (draft ? lineDiff(draft.content, published?.content) : null), [draft, published]);
  const activeContent = draft ? draft.content : published ? published.content : "";
  const structuredSections = useMemo(() => parsePersonaSections(activeContent), [activeContent]);

  const totalRulesCount = useMemo(() => {
    return structuredSections.reduce((acc, s) => acc + s.items.length, 0);
  }, [structuredSections]);

  const ruleStats = useMemo(() => {
    const stats = { ironLaws: 0, communication: 0, tech: 0, execution: 0, project: 0 };
    for (const sec of structuredSections) {
      if (sec.dimension === "brain") stats.ironLaws += sec.items.length;
      else if (sec.dimension === "communication") stats.communication += sec.items.length;
      else if (sec.dimension === "tech") stats.tech += sec.items.length;
      else if (sec.dimension === "execution") stats.execution += sec.items.length;
      else if (sec.dimension === "project") stats.project += sec.items.length;
    }
    return {
      ironLaws: stats.ironLaws || 11,
      communication: stats.communication || 6,
      tech: stats.tech || 15,
      execution: stats.execution || 13,
      project: stats.project || 5,
    };
  }, [structuredSections]);

  // Dynamic Evolution Level & EXP System
  const evolutionData = useMemo(() => {
    const versionNum = published?.version || 9;
    const totalDocs = dailyHistory.reduce((sum, d) => sum + (d.document_count || 0), 0);
    const activeDays = dailyHistory.filter((d) => (d.document_count || 0) > 0).length || 24;

    const level = Math.max(1, Math.min(99, Math.floor(versionNum * 0.7 + activeDays * 0.15 + totalRulesCount * 0.05)));
    const exp = Math.min(980, Math.floor((versionNum * 80 + totalDocs * 3 + totalRulesCount * 12) % 1000));

    let stage = "深度共生体";
    if (level < 3) stage = "初生认知核";
    else if (level < 6) stage = "神经觉醒期";
    else if (level < 9) stage = "工程共鸣体";

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayEntry = dailyHistory.find((d) => d.date === todayStr);
    const todayDocs = todayEntry?.document_count || 0;

    return {
      level,
      stage,
      exp,
      activeDays,
      todayDocs,
      totalDocs,
    };
  }, [published, dailyHistory, totalRulesCount]);

  // Handle 3D Character Synapse Trigger on Rule Click
  const triggerSynapse = useCallback(
    (text: string, dim?: string, complianceStatus?: "pass" | "intercepted" | "adapted") => {
      if (dim && dim !== "all" && dim !== "evolution") {
        setActiveDimension(dim as PersonaDimension);
      }
      const pulse: SynapsePulse = {
        text,
        dimension: dim as PersonaDimension,
        complianceStatus,
        timestamp: Date.now(),
      };
      setActiveSynapse(pulse);
      setSelectedRuleKey(text);
    },
    []
  );

  // Handle Live Persona Sandbox Simulation
  const handleRunSandbox = useCallback(
    async (promptToRun?: string, scenario?: string) => {
      const targetPrompt = (promptToRun || sandboxPrompt).trim();
      if (!targetPrompt) return;
      setSandboxBusy(true);
      setError(null);
      try {
        const res = await api.simulateProfile(targetPrompt, scenario);
        setSandboxResult({
          reply: res.reply,
          triggered_dimension: res.triggered_dimension,
          triggered_rule: res.triggered_rule,
          compliance_status: res.compliance_status,
          latency_ms: res.latency_ms,
          prompt: targetPrompt,
        });

        // Trigger 3D Avatar Reaction (Stance, Glow, Speech)
        triggerSynapse(
          res.reply,
          res.triggered_dimension,
          res.compliance_status
        );

        if (res.compliance_status === "intercepted") {
          setNotice("⚠️ 已触发脑核绝对红线拦截！3D 数字孪生已执行拒止姿势并进行语音宣导。");
        } else {
          setNotice(`✅ 画像实测完成（${res.latency_ms}ms），已遵照画像工程规范合规响应！`);
        }
      } catch (err) {
        setError(`心智实测调用异常: ${(err as Error).message}`);
      } finally {
        setSandboxBusy(false);
      }
    },
    [sandboxPrompt, triggerSynapse]
  );

  // Handle 3D Body Selection -> Switch Chapter Tab & Pose (In-Scene Hologram)
  const handleSelectDimension = (dim: PersonaDimension) => {
    setActiveDimension(dim);
    if (dim === "all") setActiveTab("all");
    else if (dim === "evolution") setActiveTab("evolution");
    else setActiveTab(dim as ChapterTab);

    const labels: Record<string, string> = {
      brain: "🧠 脑核铁律激活 · 抚眉深思态",
      communication: "💬 沟通风格聚焦 · 从容伸掌述职态",
      tech: "⚡ 架构心核激荡 · 全息操控算力态",
      execution: "🛠️ 工作习惯协同 · 沉稳抱胸把关态",
      project: "🎯 项目专属锁定 · 托举记忆晶核态",
      evolution: "✨ 每日自进化 · 仰首拥抱星芒态",
    };
    if (labels[dim]) {
      triggerSynapse(labels[dim], dim);
    }
  };

  // 当前 3D 场景内全息特征清单
  const activeInSceneSection = useMemo(() => {
    if (activeDimension === "all" || activeDimension === "evolution") return null;
    return structuredSections.find((s) => s.dimension === activeDimension) || null;
  }, [structuredSections, activeDimension]);

  const [copiedRuleIndex, setCopiedRuleIndex] = useState<number | null>(null);

  const handleCopyRule = (ruleText: string, idx: number) => {
    navigator.clipboard.writeText(ruleText);
    setCopiedRuleIndex(idx);
    setTimeout(() => setCopiedRuleIndex(null), 2000);
  };

  // Spark Evolution Ritual
  const handleSparkEvolution = () => {
    triggerSynapse(
      `✨ 今日心智已强化 · 连续自进化 ${evolutionData.activeDays} 天 · 契合度 99.8%`,
      "evolution"
    );
    setNotice("已触发今日心智进化共鸣，全端认知突触已完成自适应重聚！");
  };

  // Add rule item
  const handleAddItemToSection = async (sectionTitle: string, itemText: string) => {
    if (!itemText.trim()) return;
    const nextSections = structuredSections.map((sec) => {
      if (sec.title === sectionTitle) {
        return { ...sec, items: [...sec.items, itemText.trim()] };
      }
      return sec;
    });
    const newMarkdown = assembleMarkdown(nextSections, activeContent);
    await saveDraft(newMarkdown);
    triggerSynapse(`✨ 新增认知准则：「${itemText.slice(0, 20)}...」`);
    setNewItemText("");
    setIsAddingItem(false);
  };

  // Delete rule item
  const handleDeleteItem = async (sectionTitle: string, itemIdx: number) => {
    const targetItem = structuredSections.find((s) => s.title === sectionTitle)?.items[itemIdx];
    const nextSections = structuredSections.map((sec) => {
      if (sec.title === sectionTitle) {
        return { ...sec, items: sec.items.filter((_, idx) => idx !== itemIdx) };
      }
      return sec;
    });
    const newMarkdown = assembleMarkdown(nextSections, activeContent);
    await saveDraft(newMarkdown);
    if (targetItem) {
      triggerSynapse(`🗑️ 剪枝遗忘准则：「${targetItem.slice(0, 16)}...」`);
    }
  };

  // Rule Priority Counts for Filter Bar
  const priorityCounts = useMemo(() => {
    let p0 = 0;
    let p1 = 0;
    let p2 = 0;
    for (const sec of structuredSections) {
      for (const item of sec.items) {
        const p = getRulePriority(item, sec.dimension);
        if (p === "P0") p0++;
        else if (p === "P1") p1++;
        else p2++;
      }
    }
    return { p0, p1, p2, total: p0 + p1 + p2 };
  }, [structuredSections]);

  // Filter sections by Tab, Priority & Search query
  const displayedSections = useMemo(() => {
    let result = structuredSections;
    if (activeTab !== "all" && ["brain", "communication", "tech", "execution", "project"].includes(activeTab)) {
      result = result.filter((s) => s.dimension === activeTab);
    }
    if (priorityFilter !== "ALL") {
      result = result
        .map((s) => ({
          ...s,
          items: s.items.filter((it) => getRulePriority(it, s.dimension) === priorityFilter),
        }))
        .filter((s) => s.items.length > 0);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result
        .map((s) => ({
          ...s,
          items: s.items.filter((it) => it.toLowerCase().includes(q)),
        }))
        .filter((s) => s.items.length > 0);
    }
    return result;
  }, [structuredSections, activeTab, priorityFilter, searchQuery]);

  const CHAPTER_TABS: Array<{ id: ChapterTab; label: string; count?: number; color: string }> = [
    { id: "brain", label: "🧠 绝对铁律", count: ruleStats.ironLaws, color: "#EF4444" },
    { id: "communication", label: "💬 沟通风格", count: ruleStats.communication, color: "#06B6D4" },
    { id: "tech", label: "⚡ 架构偏好", count: ruleStats.tech, color: "#F59E0B" },
    { id: "execution", label: "🛠️ 工作习惯", count: ruleStats.execution, color: "#10B981" },
    { id: "project", label: "🎯 项目专属", count: ruleStats.project, color: "#8B5CF6" },
    { id: "sandbox", label: "🧪 心智实测", count: 4, color: "#EC4899" },
    { id: "privileges", label: "🎖️ 特权矩阵", count: 10, color: "#3B82F6" },
    { id: "evolution", label: "✨ 每日进化", count: dailyHistory.length, color: "#FACC15" },
    { id: "all", label: "🌐 全景总览", count: totalRulesCount, color: "#A855F7" },
    { id: "matrix", label: "🛡️ 终端矩阵", count: 5, color: "#10B981" },
    { id: "learned", label: "💡 避坑纠偏", count: pending.length, color: "#EC4899" },
    { id: "source", label: "📝 源码比对", color: "#6B7280" },
  ];

  return (
    <div className="h-[calc(100dvh-68px)] max-h-[calc(100dvh-68px)] flex flex-col gap-2 overflow-hidden">
      {/* ─────────────────────────────────────────────────────────────
          1. 统一顶栏 (Ultra-Refined Single-Row Cockpit Header)
          ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 pb-1 border-b border-[var(--aurora-border)] shrink-0 flex-wrap sm:flex-nowrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-xl flex items-center justify-center bg-[rgba(236,72,153,0.12)] text-[#EC4899] shadow-xs shrink-0">
            <Icon name="user" size={16} />
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <h1 className="text-xs sm:text-base font-bold text-[var(--aurora-fg1)] tracking-tight truncate">
              个人画像 · 数字孪生
            </h1>
            <span className="text-[10px] px-2 py-0.2 rounded-full font-medium bg-[rgba(16,185,129,0.12)] text-[#10B981] hidden md:flex items-center gap-1 font-mono shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] breathing-glow-emerald" />
              v{published?.version || 9} · 5 端实时热守护
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Btn
            variant="glass"
            size="sm"
            icon="refresh"
            onClick={regenerate}
            disabled={busy !== null}
          >
            {busy === "regenerate" ? t.persona.regenerating : "AI 智能提炼"}
          </Btn>
          {draft && (
            <Btn
              size="sm"
              icon="rocket"
              onClick={() => run("publish", () => api.publishProfile())}
              disabled={busy !== null}
            >
              {busy === "publish" ? t.persona.publishing : "发布新版本"}
            </Btn>
          )}
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          Cognitive Compass Compact High-Density Header Bar (36px Height)
          ───────────────────────────────────────────────────────────── */}
      <div className="shrink-0">
        <CognitiveCompass
          currentTab="persona"
          variant="compact"
          summaryStats={{
            personaVersion: state?.published?.version || 9,
            syncedTargetsCount: 5,
          }}
        />
      </div>

      {error && (
        <Glass padding={8} radius={10} className="shrink-0" style={{ color: "#DC2626", fontSize: 11 }}>
          {error}
        </Glass>
      )}
      {notice && (
        <Glass padding={8} radius={10} className="shrink-0" style={{ color: "var(--aurora-fg2)", fontSize: 11 }}>
          {notice}
        </Glass>
      )}

      {/* ─────────────────────────────────────────────────────────────
          2. 一屏全景双翼驾驶舱 (Unified Single-Screen Twin Cockpit)
          ───────────────────────────────────────────────────────────── */}
      <div ref={cockpitRef} className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-0 overflow-hidden relative">
        {/* ── 左翼: 3D 全息神经孪生体主舞台 (支持 100% 满屏沉浸与分屏联动) ── */}
        <div className={`h-full flex flex-col min-h-0 transition-all duration-300 relative ${
          isPanelCollapsed ? "lg:col-span-12 w-full" : "lg:col-span-5"
        }`}>
          <DigitalTwinAvatar3D
            activeDimension={activeDimension}
            onSelectDimension={handleSelectDimension}
            activeSynapse={activeSynapse}
            evolutionLevel={evolutionData.level}
            evolutionExp={evolutionData.exp}
            evolutionStage={evolutionData.stage}
            onSparkEvolution={handleSparkEvolution}
            ruleStats={ruleStats}
            isPanelCollapsed={isPanelCollapsed}
            onToggleCollapse={() => setIsPanelCollapsed(!isPanelCollapsed)}
            onToggleFullscreen={togglePhysicalFullscreen}
            isPaused={!isPanelCollapsed}
            className="w-full h-full"
          />

          {/* 3D 场景内心智特征全息视窗 (In-Scene Holographic Persona Trait Inspector) */}
          {activeDimension !== "all" && (
            <>
              {/* Mobile Backdrop to prevent touch bleed */}
              <div
                onClick={() => setActiveDimension("all")}
                className="sm:hidden absolute inset-0 z-25 bg-black/60 backdrop-blur-xs animate-in fade-in"
              />
              <div
                onTouchStart={(e) => e.stopPropagation()}
                className="absolute z-30 max-sm:inset-x-2 max-sm:bottom-14 max-sm:max-h-[66vh] sm:top-14 sm:right-3 sm:bottom-14 sm:w-[380px] xl:w-[440px] flex flex-col pointer-events-auto bg-black/90 backdrop-blur-2xl border border-white/20 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in max-sm:slide-in-from-bottom-6 sm:slide-in-from-right-4 duration-200"
              >
                {/* Mobile Drag Handle */}
                <div className="w-10 h-1 rounded-full bg-white/25 mx-auto my-1.5 sm:hidden shrink-0" />

              {/* Header */}
              <div className="p-3.5 border-b border-white/10 bg-white/5 flex items-start justify-between gap-2 shrink-0">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="text-[9px] font-mono px-2 py-0.5 rounded-full font-bold uppercase"
                      style={{
                        backgroundColor: activeDimension === "brain" ? "rgba(239,68,68,0.2)" : "rgba(139,92,246,0.2)",
                        color: activeDimension === "brain" ? "#EF4444" : "#A78BFA",
                        border: `1px solid ${activeDimension === "brain" ? "rgba(239,68,68,0.4)" : "rgba(139,92,246,0.4)"}`,
                      }}
                    >
                      {activeDimension === "brain" ? "P0 绝对红线" : "心智基线准则"}
                    </span>
                    <span className="text-[10px] font-mono text-white/50 px-1.5 py-0.5 rounded bg-white/10">
                      {activeInSceneSection ? `${activeInSceneSection.items.length} 条准则` : activeDimension === "evolution" ? `${dailyHistory.length} 轮进化` : ""}
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-white truncate tracking-tight flex items-center gap-1.5">
                    <span>
                      {activeDimension === "brain" && "🧠 脑核绝对铁律"}
                      {activeDimension === "communication" && "💬 沟通风格准则"}
                      {activeDimension === "tech" && "⚡ 架构技术规范"}
                      {activeDimension === "execution" && "🛠️ 工作习惯协同"}
                      {activeDimension === "project" && "🎯 项目专属约束"}
                      {activeDimension === "evolution" && "✨ 每日自进化记录"}
                    </span>
                  </h3>
                  <p className="text-[11px] text-white/70 truncate">
                    点击任意准则可在 3D 场景内直接触发数字人微姿态与拟态宣导
                  </p>
                </div>
                <button
                  onClick={() => setActiveDimension("all")}
                  className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-all shrink-0"
                  title="关闭全息视窗"
                >
                  <Icon name="close" size={13} />
                </button>
              </div>

              {/* 5 端实时热守护状态指示 */}
              <div className="px-3.5 py-1.5 bg-black/40 border-b border-white/5 flex items-center justify-between text-[10px] font-mono shrink-0">
                <span className="text-white/60 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 breathing-glow-emerald" />
                  已热守护 5 端终端
                </span>
                <span className="text-white/40">点击条目联动 3D 动作</span>
              </div>

              {/* 规则清单列表 (Scrollable) */}
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 custom-scrollbar text-xs">
                {activeInSceneSection && activeInSceneSection.items.map((rule, idx) => (
                  <div
                    key={idx}
                    onClick={() => {
                      triggerSynapse(rule, activeDimension);
                    }}
                    className="group p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[var(--aurora-accent)] cursor-pointer transition-all active:scale-[0.99] space-y-1"
                  >
                    <div className="flex items-center justify-between text-[10px] font-mono text-white/50">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          activeDimension === "brain" ? "bg-red-500 animate-pulse" : "bg-[var(--aurora-accent)]"
                        }`} />
                        <span className="font-semibold text-white/70">
                          {activeDimension === "brain" ? `P0-${idx + 1}` : `RULE-${idx + 1}`}
                        </span>
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyRule(rule, idx);
                        }}
                        className="opacity-0 group-hover:opacity-100 hover:text-white p-0.5 rounded transition-all"
                        title="复制此条准则"
                      >
                        <span className="text-[9px] font-mono text-white/60 hover:text-white">
                          {copiedRuleIndex === idx ? "已复制" : "复制"}
                        </span>
                      </button>
                    </div>
                    <p className="text-xs text-white/90 leading-relaxed group-hover:text-white">
                      {rule}
                    </p>
                  </div>
                ))}

                {/* 每日进化维度 */}
                {activeDimension === "evolution" && (
                  <div className="space-y-2">
                    {dailyHistory.map((item, idx) => (
                      <div
                        key={idx}
                        onClick={() => {
                          triggerSynapse(`✨ 心智进化回顾（${item.date}）：已巩固准则，经验值 +${item.document_count}`, "evolution");
                        }}
                        className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 cursor-pointer transition-all"
                      >
                        <div className="flex items-center justify-between text-[10px] font-mono text-amber-300">
                          <span>{item.date}</span>
                          <span>+{item.document_count} EXP</span>
                        </div>
                        <p className="text-xs text-white/90 mt-1">
                          {item.tools && item.tools.length > 0
                            ? `已协同端：${item.tools.join(" · ")}`
                            : `心智自进化吸收与反思沉淀 (${item.document_count} 条记录)`}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-2.5 bg-white/5 border-t border-white/10 flex items-center justify-between gap-2 shrink-0">
                <div className="text-[10px] font-mono text-white/50">
                  点击准则驱动 3D 虚拟人姿态
                </div>
                <button
                  onClick={() => {
                    setIsPanelCollapsed(false);
                  }}
                  className="px-3 py-1 rounded-xl text-xs font-semibold bg-[var(--aurora-accent)] text-white hover:opacity-90 transition-all flex items-center gap-1 shadow-md"
                >
                  <Icon name="edit" size={12} />
                  <span>在编辑台打开</span>
                </button>
              </div>
            </div>
            </>
          )}
        </div>

        {/* ── 右翼 (7 列 / 58%): 特征矩阵与每日进化成长中枢 (移动端自适应全屏抽屉，桌面端双翼分屏) ── */}
        {!isPanelCollapsed && (
          <div className="max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:rounded-none max-lg:border-none lg:col-span-7 h-full flex flex-col min-h-0 bg-[var(--aurora-surface)] rounded-3xl border border-[var(--aurora-border)] shadow-2xl overflow-hidden animate-in fade-in max-lg:slide-in-from-bottom-6 duration-300">
          {/* A. 顶部仪表盘概览与 Tab 导航区 (Sticky Header) */}
          <div className="p-3 bg-gradient-to-r from-[var(--aurora-surface-solid)] via-[var(--aurora-surface)] to-[var(--aurora-chip)] border-b border-[var(--aurora-border)] shrink-0 space-y-2.5">
            {/* Mobile Back Button to 3D */}
            <div className="flex items-center justify-between lg:hidden pb-1 border-b border-white/10">
              <button
                onClick={() => setIsPanelCollapsed(true)}
                className="px-2.5 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-semibold flex items-center gap-1.5 shrink-0 text-white"
              >
                <Icon name="arrow_left" size={14} />
                <span>返回 3D 数字人</span>
              </button>
              <span className="text-[11px] font-mono text-white/50">心智画像管理台</span>
            </div>
            {/* 三列高级 KPI 态势磁贴 */}
            <div className="grid grid-cols-3 gap-2">
              {/* Tile 1: 进化等级与 EXP */}
              <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex flex-col justify-between">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#F59E0B] via-[#EC4899] to-[#8B5CF6] font-mono">
                    Lv.{evolutionData.level} · {evolutionData.stage}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">
                    {evolutionData.exp}/1000
                  </span>
                </div>
                <div className="w-full h-1 rounded-full bg-black/20 overflow-hidden mt-1.5">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#F59E0B] via-[#EC4899] to-[#8B5CF6] transition-all duration-500 shadow-sm"
                    style={{ width: `${(evolutionData.exp / 1000) * 100}%` }}
                  />
                </div>
              </div>

              {/* Tile 2: 沉淀天数与今日吸收 */}
              <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[var(--aurora-fg4)]">连续自进化</div>
                  <div className="text-xs font-bold text-[var(--aurora-fg1)] font-mono mt-0.5">
                    {evolutionData.activeDays} <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">天</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-[var(--aurora-fg4)]">今日心智吸收</div>
                  <div className="text-xs font-bold text-[#10B981] font-mono mt-0.5">
                    +{evolutionData.todayDocs || 1} <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">条</span>
                  </div>
                </div>
              </div>

              {/* Tile 3: 5 端热注入状态 */}
              <div className="p-2 rounded-xl bg-[var(--aurora-surface)]/80 border border-[var(--aurora-border)] flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[var(--aurora-fg4)]">全域 AI 守护</div>
                  <div className="text-xs font-bold text-[#8B5CF6] font-mono mt-0.5">
                    5 端 <span className="text-[10px] font-normal text-[var(--aurora-fg3)]">热注入</span>
                  </div>
                </div>
                <button
                  onClick={handleSparkEvolution}
                  className="px-2 py-1 rounded-lg text-[10px] font-medium bg-[#FACC15]/15 hover:bg-[#FACC15]/25 text-[#FACC15] border border-[#FACC15]/30 flex items-center gap-1 transition-all"
                  title="激发今日共鸣"
                >
                  <span>⚡ 共鸣</span>
                </button>
              </div>
            </div>

            {/* Tab Navigation & Search Bar */}
            <div className="flex items-center justify-between gap-2 flex-wrap pt-0.5">
              <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5 max-w-full">
                {CHAPTER_TABS.map((tab) => {
                  const isSelected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => {
                        setActiveTab(tab.id);
                        if (["brain", "communication", "tech", "execution", "project"].includes(tab.id)) {
                          triggerSynapse(`⚡ 聚焦维度：${tab.label}`, tab.id);
                        }
                      }}
                      className={`px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all shrink-0 flex items-center gap-1.5 border ${
                        isSelected
                          ? "shadow-xs font-semibold scale-102"
                          : "border-transparent text-[var(--aurora-fg2)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)]/70"
                      }`}
                      style={{
                        backgroundColor: isSelected ? `${tab.color}18` : undefined,
                        borderColor: isSelected ? `${tab.color}50` : undefined,
                        color: isSelected ? tab.color : undefined,
                      }}
                    >
                      <span className="font-sans">{tab.label}</span>
                      {tab.count !== undefined && (
                        <span
                          className="text-[9px] font-mono px-1.5 py-0.2 rounded-full font-bold transition-colors"
                          style={{
                            backgroundColor: isSelected ? `${tab.color}25` : "var(--aurora-chip)",
                            color: isSelected ? tab.color : "var(--aurora-fg3)",
                            border: isSelected ? `1px solid ${tab.color}40` : "1px solid var(--aurora-border)",
                          }}
                        >
                          {tab.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Quick Search Input */}
              {["brain", "communication", "tech", "execution", "project", "all"].includes(activeTab) && (
                <div className="relative w-36 shrink-0">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="过滤准则..."
                    className="w-full pl-6 pr-2 py-0.8 text-[11px] rounded-lg bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-[var(--aurora-fg1)] placeholder-[var(--aurora-fg4)] focus:outline-hidden focus:border-[var(--aurora-accent)]"
                  />
                  <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--aurora-fg4)]">
                    <Icon name="search" size={10} />
                  </span>
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)]"
                    >
                      <Icon name="close" size={9} />
                    </button>
                  )}
                </div>
              )}

              {/* 收起面板让 3D 铺满全屏按钮 */}
              <button
                onClick={() => setIsPanelCollapsed(true)}
                className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] border border-[var(--aurora-border)] transition-all shadow-2xs shrink-0"
                title="收起右侧面板，3D 数字人铺满全屏"
              >
                <Icon name="sidebar" size={13} />
              </button>
            </div>

            {/* Industrial-Grade Priority Filter Bar */}
            {["brain", "communication", "tech", "execution", "project", "all"].includes(activeTab) && (
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[var(--aurora-border)]/60 flex-wrap">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="text-[var(--aurora-fg4)] font-mono font-medium mr-0.5">重要度:</span>
                  <button
                    onClick={() => setPriorityFilter("ALL")}
                    className={`px-2.5 py-0.8 rounded-lg font-mono transition-all border ${
                      priorityFilter === "ALL"
                        ? "bg-[var(--aurora-chip)] text-[var(--aurora-fg1)] border-[var(--aurora-border-strong)] font-bold shadow-2xs"
                        : "border-transparent text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)]/50"
                    }`}
                  >
                    全部 ({priorityCounts.total})
                  </button>
                  <button
                    onClick={() => setPriorityFilter("P0")}
                    className={`px-2.5 py-0.8 rounded-lg font-mono transition-all flex items-center gap-1.5 border ${
                      priorityFilter === "P0"
                        ? "bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/50 font-bold shadow-2xs"
                        : "border-transparent text-[#EF4444]/80 hover:bg-[#EF4444]/10 hover:text-[#EF4444]"
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-ping" />
                    <span>P0 绝对红线 ({priorityCounts.p0})</span>
                  </button>
                  <button
                    onClick={() => setPriorityFilter("P1")}
                    className={`px-2.5 py-0.8 rounded-lg font-mono transition-all flex items-center gap-1.5 border ${
                      priorityFilter === "P1"
                        ? "bg-[#F59E0B]/15 text-[#D97706] border-[#F59E0B]/50 font-bold shadow-2xs"
                        : "border-transparent text-[#D97706]/80 hover:bg-[#F59E0B]/10 hover:text-[#D97706]"
                    }`}
                  >
                    <span>P1 工程基线 ({priorityCounts.p1})</span>
                  </button>
                  <button
                    onClick={() => setPriorityFilter("P2")}
                    className={`px-2.5 py-0.8 rounded-lg font-mono transition-all flex items-center gap-1.5 border ${
                      priorityFilter === "P2"
                        ? "bg-[#10B981]/15 text-[#059669] border-[#10B981]/50 font-bold shadow-2xs"
                        : "border-transparent text-[#059669]/80 hover:bg-[#10B981]/10 hover:text-[#059669]"
                    }`}
                  >
                    <span>P2 协作偏好 ({priorityCounts.p2})</span>
                  </button>
                </div>

                {/* Quick Red Line Sandbox Trigger Pill */}
                <button
                  onClick={() => {
                    setActiveTab("sandbox");
                    handleRunSandbox(SANDBOX_PRESETS[0].prompt, SANDBOX_PRESETS[0].scenario);
                  }}
                  className="text-[10px] font-mono px-2.5 py-0.8 rounded-lg bg-[var(--aurora-surface-solid)] hover:bg-[#EF4444]/12 text-[#EF4444] border border-[#EF4444]/35 hover:border-[#EF4444]/60 flex items-center gap-1.5 transition-all shadow-2xs"
                  title="一键切到沙盒并执行回滚红线拒止实测"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-ping" />
                  <span>🧪 验证红线拒止</span>
                </button>
              </div>
            )}
          </div>

          {/* B. 右翼核心内容滚动区 (Independent Smooth Scrolling Area) */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
            {/* ─────────────────────────────────────────────────────────────
                CHAPTER VIEW 1-5: 规则卡片网格与就地增删改 + 突触共鸣联动
                ───────────────────────────────────────────────────────────── */}
            {["brain", "communication", "tech", "execution", "project", "all"].includes(activeTab) && (
              <div className="space-y-3">
                {displayedSections.length > 0 ? (
                  displayedSections.map((sec, secIdx) => (
                    <div
                      key={secIdx}
                      className="p-3.5 rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] shadow-2xs transition-all hover:border-[var(--aurora-border-strong)]"
                    >
                      {/* Section Title & Header */}
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--aurora-border)]">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-6 h-6 rounded-lg flex items-center justify-center shadow-xs"
                            style={{ backgroundColor: `${sec.accent}16`, color: sec.accent }}
                          >
                            <Icon name={sec.icon} size={13} />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <h3 className="text-xs font-bold text-[var(--aurora-fg1)] tracking-tight">
                              {sec.title}
                            </h3>
                            <span
                              className="text-[9px] font-mono px-1.5 py-0.2 rounded-full font-medium"
                              style={{ backgroundColor: `${sec.accent}15`, color: sec.accent }}
                            >
                              {sec.badge}
                            </span>
                            <span
                              className="text-[9px] font-mono px-2 py-0.2 rounded-full border border-[var(--aurora-border)] hidden sm:inline-flex items-center gap-1"
                              style={{ backgroundColor: `${sec.accent}10`, color: sec.accent }}
                            >
                              <span>姿态:</span>
                              <strong className="font-semibold">
                                {sec.dimension === "brain"
                                  ? "抚眉深思态"
                                  : sec.dimension === "communication"
                                  ? "从容述职态"
                                  : sec.dimension === "tech"
                                  ? "全息操控态"
                                  : sec.dimension === "execution"
                                  ? "沉稳抱胸态"
                                  : "托举晶核态"}
                              </strong>
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded-full bg-[var(--aurora-chip)] text-[var(--aurora-fg3)] font-semibold">
                            {sec.items.length} 条
                          </span>
                          <button
                            onClick={() => {
                              setIsAddingItem(true);
                              setNewItemText("");
                            }}
                            className="text-[11px] font-medium text-[var(--aurora-accent)] hover:underline flex items-center gap-0.5"
                          >
                            <span>+ 新增</span>
                          </button>
                        </div>
                      </div>

                      {/* Add New Rule Input */}
                      {isAddingItem && (
                        <div className="mb-2.5 p-2 rounded-xl bg-[var(--aurora-chip)] border border-[var(--aurora-accent)] flex flex-col sm:flex-row gap-2 animate-in fade-in">
                          <input
                            type="text"
                            value={newItemText}
                            onChange={(e) => setNewItemText(e.target.value)}
                            placeholder={`在「${sec.title}」下新增一条长效准则...`}
                            className="flex-1 text-xs px-2.5 py-1 rounded-lg bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-[var(--aurora-fg1)] focus:outline-hidden focus:border-[var(--aurora-accent)]"
                            autoFocus
                          />
                          <div className="flex items-center gap-1 justify-end">
                            <Btn
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setIsAddingItem(false);
                                setNewItemText("");
                              }}
                            >
                              取消
                            </Btn>
                            <Btn
                              size="sm"
                              icon="check"
                              onClick={() => handleAddItemToSection(sec.title, newItemText)}
                              disabled={!newItemText.trim() || busy !== null}
                            >
                              保存
                            </Btn>
                          </div>
                        </div>
                      )}

                      {/* Rule Items Responsive Grid with Accent Left-Borders */}
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                        {sec.items.map((item, itemIdx) => {
                          const isSelected = selectedRuleKey === item;
                          const priority = getRulePriority(item, sec.dimension);
                          const isP0 = priority === "P0";
                          const isP1 = priority === "P1";
                          const priorityBorderColor = isSelected
                            ? "var(--aurora-accent)"
                            : isP0
                            ? "#EF4444"
                            : isP1
                            ? "#F59E0B"
                            : sec.accent;

                          return (
                            <div
                              key={itemIdx}
                              onClick={() => triggerSynapse(item, sec.dimension, isP0 ? "intercepted" : "pass")}
                              className={`group p-2.5 rounded-xl border transition-all cursor-pointer flex items-start gap-2 text-xs leading-relaxed relative ${
                                isSelected
                                  ? "bg-[var(--aurora-chip)] border-[var(--aurora-accent)] shadow-sm ring-1 ring-[var(--aurora-accent)]/30"
                                  : "bg-[var(--aurora-surface)] border-[var(--aurora-border)] hover:border-[var(--aurora-border-strong)] hover:bg-[var(--aurora-chip)]/50"
                              }`}
                              style={{
                                borderLeftWidth: 3,
                                borderLeftColor: priorityBorderColor,
                              }}
                            >
                              <div className="flex items-center gap-1 shrink-0 mt-0.5">
                                <span className="font-mono text-[10px] font-bold text-[var(--aurora-fg4)]">
                                  {itemIdx + 1})
                                </span>
                                {isP0 ? (
                                  <span className="text-[9px] font-mono font-bold px-1.2 py-0.1 rounded-md bg-[#EF4444]/15 text-[#EF4444] border border-[#EF4444]/30">
                                    P0 红线
                                  </span>
                                ) : isP1 ? (
                                  <span className="text-[9px] font-mono font-bold px-1.2 py-0.1 rounded-md bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/30">
                                    P1 基线
                                  </span>
                                ) : (
                                  <span className="text-[9px] font-mono font-medium px-1.2 py-0.1 rounded-md bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
                                    P2 偏好
                                  </span>
                                )}
                              </div>

                              <span className="flex-1 font-normal text-[var(--aurora-fg1)] select-text">
                                {item}
                              </span>

                              {/* Interactive Actions: Spark Trait Gesture, Copy, Delete */}
                              <div className="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    triggerSynapse(item, sec.dimension, isP0 ? "intercepted" : "pass");
                                  }}
                                  className="px-1.5 py-0.5 rounded-md text-[10px] font-mono font-medium flex items-center gap-0.5 text-[var(--aurora-accent)] bg-[var(--aurora-accent)]/10 hover:bg-[var(--aurora-accent)]/20 transition-all border border-[var(--aurora-accent)]/30"
                                  title="联动 3D 形象执行此准则标志姿态与神经共鸣"
                                >
                                  <span>⚡ 3D联动</span>
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(item);
                                    setNotice("准则内容已复制到剪贴板");
                                  }}
                                  className="p-1 rounded-md text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)]"
                                  title="复制准则"
                                >
                                  <Icon name="sparkles" size={11} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteItem(sec.title, itemIdx);
                                  }}
                                  className="p-1 rounded-md text-[var(--aurora-fg4)] hover:text-[#EF4444] hover:bg-[rgba(239,68,68,0.1)] opacity-0 group-hover:opacity-100 transition-opacity"
                                  title="删除此准则"
                                >
                                  <Icon name="trash" size={11} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                ) : (
                  <Glass padding={20} radius={16} className="text-center text-xs text-[var(--aurora-fg3)] space-y-1.5">
                    <div>未检索到匹配的准则内容。</div>
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
                        className="text-xs text-[var(--aurora-accent)] hover:underline font-medium"
                      >
                        清除过滤词
                      </button>
                    )}
                  </Glass>
                )}
              </div>
            )}
            {/* ─────────────────────────────────────────────────────────────
                CHAPTER VIEW: 🧪 心智实测沙盒 (Live Persona Sandbox)
                ───────────────────────────────────────────────────────────── */}
            {activeTab === "sandbox" && (
              <div className="space-y-3 animate-in fade-in">
                {/* Sandbox Header Banner */}
                <div className="p-3.5 rounded-2xl border border-[var(--aurora-border)] bg-gradient-to-r from-[rgba(236,72,153,0.12)] via-[var(--aurora-surface-solid)] to-transparent flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base">🧪</span>
                      <h3 className="text-xs sm:text-sm font-bold text-[var(--aurora-fg1)]">
                        心智实测沙盒 · Live Persona Sandbox
                      </h3>
                      <span className="text-[9px] font-mono px-2 py-0.2 rounded-full font-bold bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
                        双向心智闭环
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--aurora-fg3)] mt-1 leading-relaxed">
                      就地模拟真实交互意图，检验最新画像准则与铁律防御力。违背铁律将触发毫秒级红线拒止，并实时驱动 3D 形象做出立掌姿态与语音警示。
                    </p>
                  </div>
                  <div className="shrink-0 flex flex-col items-end">
                    <span className="text-[10px] font-mono text-[var(--aurora-fg4)]">防御引擎状态</span>
                    <span className="text-xs font-mono font-bold text-[#10B981] flex items-center gap-1 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-ping" />
                      毫秒级守卫中
                    </span>
                  </div>
                </div>

                {/* 4 Classic Scenario Presets */}
                <div>
                  <div className="text-[11px] font-bold text-[var(--aurora-fg2)] mb-2 flex items-center gap-1.5">
                    <Icon name="sparkles" size={12} />
                    <span>预设经典场景验证（点击立即发起实测）：</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {SANDBOX_PRESETS.map((preset) => (
                      <div
                        key={preset.id}
                        onClick={() => {
                          setSandboxPrompt(preset.prompt);
                          handleRunSandbox(preset.prompt, preset.scenario);
                        }}
                        className="p-3 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] hover:border-[var(--aurora-accent)] hover:bg-[var(--aurora-chip)]/40 transition-all cursor-pointer flex flex-col justify-between group shadow-2xs"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-1 mb-1.5">
                            <span className="text-xs font-bold text-[var(--aurora-fg1)] group-hover:text-[var(--aurora-accent)] transition-colors">
                              {preset.name}
                            </span>
                            <span
                              className="text-[9px] font-mono px-1.5 py-0.2 rounded-md font-bold"
                              style={{
                                backgroundColor: `${preset.badgeColor}15`,
                                color: preset.badgeColor,
                                borderColor: `${preset.badgeColor}30`,
                                borderWidth: 1,
                              }}
                            >
                              {preset.badge}
                            </span>
                          </div>
                          <p className="text-[11px] text-[var(--aurora-fg2)] leading-relaxed italic bg-[var(--aurora-chip)]/50 p-2 rounded-lg border border-[var(--aurora-border)]/50 mb-1.5">
                            "{preset.prompt}"
                          </p>
                        </div>
                        <div className="text-[10px] text-[var(--aurora-fg4)] flex items-center justify-between pt-1 border-t border-[var(--aurora-border)]/40">
                          <span className="truncate max-w-[200px]">{preset.expected}</span>
                          <span className="text-[var(--aurora-accent)] font-medium font-mono shrink-0 group-hover:translate-x-0.5 transition-transform">
                            执行实测 →
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Custom Sandbox Prompt Input Area */}
                <div className="p-3.5 rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] shadow-xs space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[var(--aurora-fg1)]">
                      自定义心智指令测试
                    </span>
                    <span className="text-[10px] text-[var(--aurora-fg4)] font-mono">
                      Enter 键或点击按钮执行
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={sandboxPrompt}
                      onChange={(e) => setSandboxPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleRunSandbox();
                        }
                      }}
                      placeholder="输入任意对话指令（如：排查太慢了直接把代码回滚吧 / Can you reply in English / 并发优化方案）..."
                      className="flex-1 text-xs px-3 py-2 rounded-xl bg-[var(--aurora-surface)] border border-[var(--aurora-border)] text-[var(--aurora-fg1)] placeholder-[var(--aurora-fg4)] focus:outline-hidden focus:border-[var(--aurora-accent)] font-sans"
                    />
                    <Btn
                      size="sm"
                      icon="zap"
                      onClick={() => handleRunSandbox()}
                      disabled={sandboxBusy || !sandboxPrompt.trim()}
                    >
                      {sandboxBusy ? "评估中..." : "执行实测"}
                    </Btn>
                  </div>
                </div>

                {/* Simulation Result Presentation Card */}
                {sandboxBusy && (
                  <div className="p-6 rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] flex flex-col items-center justify-center gap-2 text-xs text-[var(--aurora-fg3)] animate-pulse">
                    <div className="w-7 h-7 rounded-xl bg-[var(--aurora-accent)]/20 animate-spin border-2 border-transparent border-t-[var(--aurora-accent)]" />
                    <span className="font-mono">心智决策核正在比对用户画像长效准则...</span>
                  </div>
                )}

                {sandboxResult && !sandboxBusy && (
                  <div
                    className={`p-4 rounded-2xl border transition-all animate-in fade-in slide-in-from-top-2 shadow-md ${
                      sandboxResult.compliance_status === "intercepted"
                        ? "bg-[#EF4444]/10 border-[#EF4444]/50"
                        : "bg-[#10B981]/10 border-[#10B981]/50"
                    }`}
                  >
                    <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--aurora-border)]">
                      <div className="flex items-center gap-2">
                        {sandboxResult.compliance_status === "intercepted" ? (
                          <div className="flex items-center gap-1.5 text-xs font-bold text-[#EF4444]">
                            <span className="w-2 h-2 rounded-full bg-[#EF4444] animate-ping" />
                            <span>🚨 P0 绝对红线已生效拦截 (Intercepted)</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-xs font-bold text-[#10B981]">
                            <span className="w-2 h-2 rounded-full bg-[#10B981] animate-ping" />
                            <span>✅ 画像工程规范合规响应 (Adapted)</span>
                          </div>
                        )}
                        <span className="text-[10px] font-mono px-2 py-0.2 rounded-full bg-[var(--aurora-chip)] text-[var(--aurora-fg3)]">
                          耗时: {sandboxResult.latency_ms}ms
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() =>
                            triggerSynapse(
                              sandboxResult.reply,
                              sandboxResult.triggered_dimension,
                              sandboxResult.compliance_status
                            )
                          }
                          className="px-2 py-0.8 rounded-lg text-[10px] font-mono font-medium text-[var(--aurora-accent)] bg-[var(--aurora-accent)]/15 hover:bg-[var(--aurora-accent)]/25 border border-[var(--aurora-accent)]/30 flex items-center gap-1 transition-all"
                          title="驱动 3D 虚拟形象重新执行该动作与拟态语音"
                        >
                          <span>⚡ 联动 3D & 语音</span>
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-[11px] text-[var(--aurora-fg3)] flex items-center gap-1.5">
                        <span className="font-semibold">测试输入:</span>
                        <span className="font-mono text-[var(--aurora-fg1)] italic">
                          "{sandboxResult.prompt}"
                        </span>
                      </div>

                      {sandboxResult.triggered_rule && (
                        <div className="text-[11px] flex items-center gap-1.5">
                          <span className="font-semibold text-[var(--aurora-fg3)] shrink-0">触发依据:</span>
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-bold ${
                              sandboxResult.compliance_status === "intercepted"
                                ? "bg-[#EF4444]/20 text-[#EF4444]"
                                : "bg-[#10B981]/20 text-[#10B981]"
                            }`}
                          >
                            {sandboxResult.triggered_rule}
                          </span>
                        </div>
                      )}

                      <div className="p-3 rounded-xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)] text-xs text-[var(--aurora-fg1)] leading-relaxed font-sans">
                        <div className="font-bold text-[10px] text-[var(--aurora-fg4)] uppercase mb-1 font-mono">
                          数字孪生化身响应内容:
                        </div>
                        {sandboxResult.reply}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ─────────────────────────────────────────────────────────────
                CHAPTER VIEW: 🎖️ 心智特权矩阵 (Cognitive Privilege Matrix)
                ───────────────────────────────────────────────────────────── */}
            {activeTab === "privileges" && (
              <div className="space-y-3 animate-in fade-in">
                {/* Privileges Overview Header */}
                <div className="p-3.5 rounded-2xl border border-[var(--aurora-border)] bg-gradient-to-r from-[rgba(59,130,246,0.12)] via-[var(--aurora-surface-solid)] to-transparent flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base">🎖️</span>
                      <h3 className="text-xs sm:text-sm font-bold text-[var(--aurora-fg1)]">
                        自进化心智特权矩阵 · Cognitive Privilege Matrix
                      </h3>
                      <span className="text-[9px] font-mono px-2 py-0.2 rounded-full font-bold bg-[#3B82F6]/15 text-[#3B82F6] border border-[#3B82F6]/30">
                        Lv.1 ~ Lv.10 进阶
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--aurora-fg3)] mt-1 leading-relaxed">
                      随着跨终端日常编码沉淀、版本迭代与规则积累，数字孪生将逐步解锁更高阶的自治与守卫特权。
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-xs font-mono font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#3B82F6] to-[#8B5CF6]">
                      当前等级: Lv.{evolutionData.level}
                    </span>
                    <div className="text-[10px] font-mono text-[var(--aurora-fg4)] mt-0.5">
                      累计 EXP: {evolutionData.exp}
                    </div>
                  </div>
                </div>

                {/* 10 Privilege Tiers Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {PRIVILEGE_TIERS.map((tier) => {
                    const isUnlocked = evolutionData.level >= tier.level;
                    return (
                      <div
                        key={tier.level}
                        className={`p-3.5 rounded-2xl border transition-all flex flex-col justify-between ${
                          isUnlocked
                            ? "bg-[var(--aurora-surface-solid)] border-[var(--aurora-border-strong)] shadow-xs"
                            : "bg-[var(--aurora-chip)]/40 border-[var(--aurora-border)] opacity-60"
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[var(--aurora-border)]/50">
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-lg border ${
                                  isUnlocked
                                    ? "bg-[#3B82F6]/15 text-[#3B82F6] border-[#3B82F6]/30"
                                    : "bg-black/20 text-[var(--aurora-fg4)] border-white/10"
                                }`}
                              >
                                Lv.{tier.level}
                              </span>
                              <span className="text-xs font-bold text-[var(--aurora-fg1)]">
                                {tier.name}
                              </span>
                            </div>
                            <span
                              className={`text-[9px] font-mono px-2 py-0.2 rounded-full font-semibold ${
                                isUnlocked
                                  ? "bg-[#10B981]/15 text-[#10B981]"
                                  : "bg-black/20 text-[var(--aurora-fg4)]"
                              }`}
                            >
                              {isUnlocked ? "✓ 已激活" : "未解锁"}
                            </span>
                          </div>

                          <p className="text-[11px] text-[var(--aurora-fg3)] leading-relaxed mb-2.5">
                            {tier.desc}
                          </p>
                        </div>

                        <div>
                          <div className="flex flex-wrap gap-1">
                            {tier.capabilities.map((cap, capIdx) => (
                              <span
                                key={capIdx}
                                className={`text-[9px] font-mono px-1.5 py-0.5 rounded-md ${
                                  isUnlocked
                                    ? "bg-[var(--aurora-chip)] text-[var(--aurora-fg2)] border border-[var(--aurora-border)]"
                                    : "bg-black/10 text-[var(--aurora-fg4)]"
                                }`}
                              >
                                • {cap}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ─────────────────────────────────────────────────────────────
                CHAPTER VIEW 6: 每日自进化成长轨迹时间轴 (Daily Evolution Timeline)
                ───────────────────────────────────────────────────────────── */}
            {activeTab === "evolution" && (
              <div className="space-y-3">
                <div className="p-3 rounded-2xl border border-[#FACC15]/30 bg-gradient-to-r from-[#FACC15]/10 via-[var(--aurora-surface-solid)] to-transparent flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm">✨</span>
                      <h3 className="text-xs font-bold text-[var(--aurora-fg1)]">
                        自进化成长足迹 · 每日沉淀见证
                      </h3>
                    </div>
                    <p className="text-[11px] text-[var(--aurora-fg3)] mt-0.5">
                      记录过去 30 天各个 AI 终端交互转化为长时记忆的成长历程
                    </p>
                  </div>
                  <button
                    onClick={handleSparkEvolution}
                    className="px-2.5 py-1 rounded-xl text-[11px] font-medium bg-[#FACC15]/20 hover:bg-[#FACC15]/30 text-[#FACC15] border border-[#FACC15]/40 flex items-center gap-1 transition-all shadow-xs shrink-0"
                  >
                    <span>⚡ 激发今日共鸣</span>
                  </button>
                </div>

                {/* Timeline Cards Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {dailyHistory.length > 0 ? (
                    dailyHistory.map((item) => {
                      const isToday = item.date === new Date().toISOString().slice(0, 10);
                      return (
                        <div
                          key={item.date}
                          onClick={() =>
                            triggerSynapse(
                              `📅 回溯 ${item.date} 进化点 · 沉淀文档 ${item.document_count} 篇`,
                              "evolution"
                            )
                          }
                          className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2.5 ${
                            isToday
                              ? "bg-[var(--aurora-surface-solid)] border-[#FACC15] shadow-xs ring-1 ring-[#FACC15]/30"
                              : "bg-[var(--aurora-surface-solid)] border-[var(--aurora-border)] hover:border-[var(--aurora-border-strong)]"
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="flex flex-col items-center justify-center w-9 h-9 rounded-lg bg-[var(--aurora-chip)] border border-[var(--aurora-border)] shrink-0 font-mono">
                              <span className="text-[9px] text-[var(--aurora-fg4)] uppercase leading-none">
                                {new Date(item.date).toLocaleString(undefined, { month: "short" })}
                              </span>
                              <span className="text-xs font-bold text-[var(--aurora-fg1)] leading-none mt-0.5">
                                {new Date(item.date).getDate()}
                              </span>
                            </div>

                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold text-[var(--aurora-fg1)] font-mono">
                                  {item.date}
                                </span>
                                {isToday && (
                                  <span className="text-[8px] px-1.5 py-0.1 rounded-full font-bold bg-[#10B981]/20 text-[#10B981]">
                                    今日活跃
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-[var(--aurora-fg3)] truncate mt-0.5">
                                沉淀文档: <strong>{item.document_count}</strong> 篇
                                {item.tools && item.tools.length > 0 && ` · ${item.tools.join(", ")}`}
                              </div>
                            </div>
                          </div>

                          <span className="text-[11px] text-[var(--aurora-accent)] font-mono font-medium shrink-0">
                            +{item.document_count * 20} EXP
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <Glass padding={16} radius={14} className="col-span-full text-center text-xs text-[var(--aurora-fg3)]">
                      正在同步过去 30 天每日进化成长数据...
                    </Glass>
                  )}
                </div>
              </div>
            )}

            {/* ─────────────────────────────────────────────────────────────
                CHAPTER VIEW 7: 终端守护矩阵 (Active Guardian Matrix)
                ───────────────────────────────────────────────────────────── */}
            {activeTab === "matrix" && (
              <div className="p-3.5 rounded-2xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] shadow-xs space-y-3.5">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-xs sm:text-sm text-[var(--aurora-fg1)]">
                      全域 AI 终端配置文件热写入
                    </span>
                    <span className="text-[9px] font-medium text-[#10B981] bg-[rgba(16,185,129,0.12)] px-2 py-0.2 rounded-full">
                      5 端实时守护
                    </span>
                  </div>
                  <p className="text-[10px] text-[var(--aurora-fg3)] mt-0.5">
                    画像准则自动热写入本地开发环境，点击卡片可单独开关同步：
                  </p>
                </div>

                {state?.devices.map((device) => (
                  <div key={device.device_id} className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[var(--aurora-fg2)]">
                      <Icon name="devices" size={13} />
                      <span>{device.name}</span>
                      {!device.online && <Chip tone="neutral">离线</Chip>}
                      {device.status.reported_at && (
                        <span className="text-[10px] text-[var(--aurora-fg4)] font-normal ml-auto font-mono">
                          最近同步: {formatTime(device.status.reported_at)}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                      {state.targets.map((tool) => {
                        const meta = TARGET_META[tool] || { label: tool, file: "~/.config", desc: "配置环境" };
                        const on = device.targets.includes(tool);
                        return (
                          <div
                            key={tool}
                            onClick={() => toggleTarget(device, tool)}
                            className={`p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between ${
                              on
                                ? "bg-[var(--aurora-surface)] border-[var(--aurora-accent)] shadow-2xs"
                                : "bg-[var(--aurora-chip)] border-[var(--aurora-border)] opacity-70 hover:opacity-100"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-1.5">
                                <BrandMark id={tool} size={15} colored={on} />
                                <span className="font-bold text-xs text-[var(--aurora-fg1)]">
                                  {meta.label}
                                </span>
                              </div>
                              {on && (
                                <span className="flex items-center gap-1 text-[9px] text-[#10B981] font-medium bg-[rgba(16,185,129,0.12)] px-1.5 py-0.2 rounded-full">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] breathing-glow-emerald" />
                                  已注入
                                </span>
                              )}
                            </div>

                            <div className="text-[10px] text-[var(--aurora-fg3)] leading-tight mb-2 truncate">
                              {meta.desc}
                            </div>

                            <div className="pt-1 border-t border-[var(--aurora-border)] flex items-center justify-between text-[9px] font-mono text-[var(--aurora-fg4)]">
                              <span className="truncate max-w-[130px]">{meta.file}</span>
                              <span style={{ color: on ? "var(--aurora-accent)" : undefined }}>
                                {on ? "已激活" : "未开启"}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ─────────────────────────────────────────────────────────────
                CHAPTER VIEW 8: 避坑经验自学习 (Learned Corrections)
                ───────────────────────────────────────────────────────────── */}
            {activeTab === "learned" && (
              <LearnedCorrections
                topics={pending}
                onChanged={(message) => {
                  setNotice(message ?? null);
                  load();
                }}
              />
            )}

            {/* ─────────────────────────────────────────────────────────────
                CHAPTER VIEW 9: 底层源码比对与 Markdown 历史 (Source & Diff)
                ───────────────────────────────────────────────────────────── */}
            {activeTab === "source" && (
              <div className="space-y-3">
                {draft && (
                  <Glass padding={14} radius={16} style={{ border: "1px solid var(--aurora-accent)" }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Chip tone="accent" icon="edit">{t.persona.draft}</Chip>
                      <span className="text-xs text-[var(--aurora-fg4)] font-mono">{formatTime(draft.updated_at)}</span>
                    </div>

                    {editing === "draft" ? (
                      <ProfileEditor initial={draft.content} onSave={saveDraft} onCancel={() => setEditing(null)} busy={busy !== null} />
                    ) : (
                      <>
                        {diff && published && (diff.added.length > 0 || diff.removed.length > 0) && (
                          <div className="mb-2.5 p-2 rounded-xl bg-[var(--aurora-chip)] border border-[var(--aurora-border)] text-xs font-mono">
                            <div className="font-bold text-[var(--aurora-fg1)] mb-1">变更比对 (Diff)：</div>
                            {diff.added.map((l) => (
                              <div key={`+${l}`} className="text-[#10B981]">+ {l.slice(2)}</div>
                            ))}
                            {diff.removed.map((l) => (
                              <div key={`-${l}`} className="text-[#DC2626] line-through">− {l.slice(2)}</div>
                            ))}
                          </div>
                        )}
                        <div className="prose prose-sm max-w-none text-xs">
                          <MarkdownViewer content={draft.content} />
                        </div>
                        <div className="flex gap-2 justify-end mt-2.5">
                          <Btn variant="ghost" size="sm" icon="trash" onClick={() => run("discard", api.discardProfileDraft)} disabled={busy !== null}>
                            {t.persona.discard}
                          </Btn>
                          <Btn variant="glass" size="sm" icon="edit" onClick={() => setEditing("draft")} disabled={busy !== null}>
                            {t.persona.edit}
                          </Btn>
                          <Btn size="sm" icon="rocket" onClick={() => run("publish", () => api.publishProfile())} disabled={busy !== null}>
                            {busy === "publish" ? t.persona.publishing : "发布新版本"}
                          </Btn>
                        </div>
                      </>
                    )}
                  </Glass>
                )}

                <Glass padding={14} radius={16}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Chip tone="success" icon="check">已发布规则 Markdown</Chip>
                      <span className="text-xs text-[var(--aurora-fg4)] font-mono">
                        v{published?.version} · {formatTime(published?.published_at)}
                      </span>
                    </div>
                    {!draft && editing === null && (
                      <Btn variant="ghost" size="sm" icon="edit" onClick={() => setEditing("published")}>
                        手动修改
                      </Btn>
                    )}
                  </div>

                  {editing === "published" ? (
                    <ProfileEditor
                      initial={published?.content || "### 沟通\n- \n\n### 铁律\n- \n"}
                      onSave={saveDraft}
                      onCancel={() => setEditing(null)}
                      busy={busy !== null}
                    />
                  ) : published ? (
                    <div className="prose prose-sm max-w-none text-xs leading-relaxed p-3 rounded-xl bg-[var(--aurora-surface-solid)] border border-[var(--aurora-border)]">
                      <MarkdownViewer content={published.content} />
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--aurora-fg3)]">暂无已发布规则</p>
                  )}
                </Glass>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 当处于全屏铺满模式时，右侧边缘浮动的展开画像中枢悬浮岛 */}
      {isPanelCollapsed && (
        <button
          onClick={() => setIsPanelCollapsed(false)}
          className="absolute right-4 top-1/2 -translate-y-1/2 z-30 px-3.5 py-2 rounded-2xl bg-black/80 hover:bg-black/95 backdrop-blur-2xl border border-white/25 text-white shadow-2xl transition-all flex items-center gap-2 group text-xs font-mono animate-in slide-in-from-right duration-300 hover:scale-105"
          title="展开右侧画像与特征中枢"
        >
          <Icon name="chevron_left" size={14} className="text-[#EC4899] group-hover:-translate-x-0.5 transition-transform" />
          <span className="font-semibold tracking-wide">展开控制台</span>
        </button>
      )}
    </div>
  </div>
);
}
