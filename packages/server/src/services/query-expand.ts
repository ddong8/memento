// Search query expansion & action synonym terms (guidance_service.terms_for + mind_resonance_service.expand_query_for_search).
import { segment } from "./tokenize";

const ACTION_SYNONYMS: Record<string, readonly string[]> = {
  deploy: ["部署", "上线", "发布", "k8s", "kubectl", "fleet", "pod"],
  release: ["发版", "发布", "版本", "tag", "release"],
  migration: ["迁移", "数据库", "表", "schema", "migration"],
  db: ["数据库", "表", "postgres", "sql"],
  build: ["构建", "编译", "打包", "build", "镜像"],
  push: ["推送", "提交", "push", "git"],
  commit: ["提交", "commit", "git"],
  git: ["git", "提交", "分支"],
  test: ["测试", "test"],
  config: ["配置", "config", "设置"],
  update: ["更新", "升级", "update"],
  delete: ["删除", "清理", "rm"],
  backup: ["备份", "backup"],
  data: ["数据", "表", "标注"],
  refactor: ["重构", "refactor"],
  install: ["安装", "依赖", "install"],
};

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
    keywords: ["自进化", "心领神会", "懂我", "记忆", "画像", "dreaming", "mcp", "profile", "agentic"],
    mindset: "持续沉淀长期规则、技能与避坑经验，打破工具孤岛，交付前充分自测。",
    target_project: null,
    anchors: ["心领神会", "常驻画像", "自进化", "避坑"],
    search_query_extras: "心领神会 常驻画像 自进化",
    defense_rules: [
      "1) 深入调查根因并彻底解决，交付前完成本地类型检查与自测确认。",
      "2) 回答简洁直接，先给结论再给依据。",
    ],
    device_affinity: null,
  },
  {
    id: "data_pipeline",
    name: "数据采集、清洗与资产治理",
    keywords: ["抓取", "爬虫", "爬取", "数据源", "数据清洗", "etl", "标注", "数据集", "资产登记"],
    mindset: "先校验输入与字段完整性，修改前备份原始数据，记录可溯源的数据来源与口径。",
    target_project: null,
    anchors: ["数据清洗", "字段对齐", "去重", "备份", "资产登记"],
    search_query_extras: "数据清洗 备份 溯源",
    defense_rules: [
      "1) 批量处理数据前先备份原表或导出副本，操作优先打标记而非硬删除。",
      "2) 明确去重键与统计口径，先校验内容类型再进入转换流水线。",
    ],
    device_affinity: "linux",
  },
  {
    id: "ui_performance",
    name: "前端交互性能与视觉体验",
    keywords: ["前端", "tab", "切换", "卡顿", "渲染", "ui", "aurora", "延迟", "流畅", "动画", "保活", "适配"],
    mindset: "保持交互零延迟与流畅渲染，兼顾桌面端与移动端响应式适配，避免阻塞主线程。",
    target_project: null,
    anchors: ["交互零延迟", "响应式适配", "缓存", "流式输出"],
    search_query_extras: "零延迟 保活 页面流畅",
    defense_rules: [
      "1) 交互零延迟、避免卡顿与主线程阻塞，重视前端渲染性能。",
      "2) 界面克制精致，确保移动端与窄屏下无横向溢出。",
    ],
    device_affinity: "mac",
  },
  {
    id: "devops_release",
    name: "发布交付与无故障上线",
    keywords: ["发布", "部署", "k8s", "pod", "release", "tag", "更新", "发版", "构建", "docker", "fleet", "gitops", "kubectl", "流水线", "上线", "镜像"],
    mindset: "发版前先查历史踩坑与 CI 状态，确认所有副本滚动生效并做线上接口验收。",
    target_project: null,
    anchors: ["CI", "release", "tag", "部署", "回滚预案"],
    search_query_extras: "发布 流水线 部署 验证",
    defense_rules: [
      "1) 发版前必查历史踩坑与构建流水线状态，确认所有目标副本更新就绪。",
      "2) 改动涉及发布元数据时，严格核对版本号、产物校验与上线接口返回。",
    ],
    device_affinity: "linux",
  },
  {
    id: "data_safety",
    name: "数据资产安全与审计",
    keywords: ["删除", "解绑", "设备", "machine", "归档", "purge", "清理数据", "备份"],
    mindset: "修改前先备份原表数据；倾向打标记归档而非物理硬删除，确保可审计可恢复。",
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

export function termsFor(...texts: (string | null | undefined)[]): string[] {
  const raw: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const word of text.toLowerCase().split(/[\s_\-/,，;；]+/)) {
      if (word) {
        raw.push(word);
        const syns = ACTION_SYNONYMS[word];
        if (syns) raw.push(...syns);
      }
    }
    for (const tok of segment(text)) raw.push(tok.toLowerCase());
  }
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const r of raw) {
    const t = r.trim();
    if (t.length < 2 && !/[\u4e00-\u9fff]/.test(t)) continue;
    if (!seenSet.has(t)) {
      seenSet.add(t);
      seen.push(t);
      if (seen.length >= 40) break;
    }
  }
  return seen;
}

export function detectScenario(terms: string[], text = "", scenarios: DomainScenario[] = DEFAULT_DOMAIN_SCENARIOS): DomainScenario | null {
  const low = `${text} ${terms.join(" ")}`.toLowerCase();
  let best: DomainScenario | null = null;
  let bestScore = 0;
  for (const sc of scenarios) {
    let score = 0;
    for (const kw of sc.keywords) {
      if (low.includes(kw.toLowerCase())) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = sc;
    }
  }
  return bestScore >= 2 ? best : null;
}

export function expandQueryForSearch(query: string, targetProject?: string | null): string {
  if (!query || query.trim().length > 30) return query;
  const terms = termsFor(null, targetProject, query);
  const scen = detectScenario(terms, `${query} ${targetProject ?? ""}`);
  if (scen?.anchors?.length) {
    const cleanQ = query.trim();
    const low = cleanQ.toLowerCase();
    const extras = scen.anchors.filter((a) => !low.includes(a.toLowerCase())).slice(0, 3);
    if (extras.length) return `${cleanQ} ${extras.join(" ")}`;
  }
  return query;
}
