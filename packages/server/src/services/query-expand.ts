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
