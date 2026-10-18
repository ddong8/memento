export interface AvatarPreset {
  id: string;
  gender: "male" | "female" | "agent";
  name: string;
  title: string;
  style: string;
  themeColor: string;
  outfitColor: string;
  features: string[];
  description: string;
  badge: string;
  svgPath: string; // 专属矢量插画路径或内嵌渲染标识
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  // ── 男款形象 (Male) ──
  {
    id: "geek_male",
    gender: "male",
    name: "极客全栈架构师",
    title: "Senior Geek Architect",
    style: "geek",
    themeColor: "#8B5CF6",
    outfitColor: "#4F46E5",
    features: ["黑框眼镜", "连帽卫衣", "代码全息环"],
    description: "崇尚代码即诗篇，沉着冷静的终极解决者。专注于高并发与极致性能。",
    badge: "全栈哲学",
    svgPath: "geek_male",
  },
  {
    id: "cyber_male",
    gender: "male",
    name: "赛博霓虹黑客",
    title: "Cyber Security Specialist",
    style: "cyberpunk",
    themeColor: "#06B6D4",
    outfitColor: "#0891B2",
    features: ["战术目镜", "赛博机能装", "电光神经环"],
    description: "穿梭于数字矩阵边缘，敏锐感知每一丝系统异常与安全红线。",
    badge: "红线守卫",
    svgPath: "cyber_male",
  },
  {
    id: "elite_male",
    gender: "male",
    name: "卓越工程领袖",
    title: "Engineering Director",
    style: "elite",
    themeColor: "#F59E0B",
    outfitColor: "#D97706",
    features: ["干练短发", "极简质感工装", "黄金决策环"],
    description: "兼具宏观商业视野与微观工程把控，直面问题，决断清晰有力。",
    badge: "商业可用",
    svgPath: "elite_male",
  },
  {
    id: "vitality_male",
    gender: "male",
    name: "元气极客探索者",
    title: "Creative Technologist",
    style: "vitality",
    themeColor: "#F97316",
    outfitColor: "#EA580C",
    features: ["活力挑染", "轻量运动夹克", "星芒炽热环"],
    description: "拥有无限好奇心与自进化动力，永远保持第一性原理与创新渴望。",
    badge: "持续进化",
    svgPath: "vitality_male",
  },

  // ── 女款形象 (Female) ──
  {
    id: "geek_female",
    gender: "female",
    name: "算法极客姬",
    title: "Algorithm Specialist",
    style: "geek",
    themeColor: "#A855F7",
    outfitColor: "#7C3AED",
    features: ["知性平光镜", "深色连帽衫", "紫罗兰算力环"],
    description: "深入底层数据结构与智能算法，逻辑严谨，崇尚一次做对到位。",
    badge: "算法底蕴",
    svgPath: "geek_female",
  },
  {
    id: "cyber_female",
    gender: "female",
    name: "赛博暗影特工",
    title: "Cyberpunk Operative",
    style: "cyberpunk",
    themeColor: "#EC4899",
    outfitColor: "#DB2777",
    features: ["电光粉挑染", "高领机能风衣", "全域感知环"],
    description: "敏捷果断的未来战士，擅长多工具协同与全自动化流水线部署。",
    badge: "全域感知",
    svgPath: "cyber_female",
  },
  {
    id: "elite_female",
    gender: "female",
    name: "卓越决策总监",
    title: "Chief Product Architect",
    style: "elite",
    themeColor: "#10B981",
    outfitColor: "#059669",
    features: ["干练及肩短发", "科技商务西装", "极光秩序环"],
    description: "关注精致高级感与商业可用性，兼顾极致用户体验与系统鲁棒性。",
    badge: "精致严谨",
    svgPath: "elite_female",
  },
  {
    id: "vitality_female",
    gender: "female",
    name: "元气灵动极客少女",
    title: "Fullstack Innovator",
    style: "vitality",
    themeColor: "#F43F5E",
    outfitColor: "#E11D48",
    features: ["光感猫耳耳机", "未来运动风", "律动星云环"],
    description: "灵感泉涌，快速原型交付大师，带来愉悦而充满力量的协作节奏。",
    badge: "灵感共鸣",
    svgPath: "vitality_female",
  },

  // ── 智能体形象 (Agent / Silicon) ──
  {
    id: "ai_sentinel",
    gender: "agent",
    name: "超导脑核哨兵",
    title: "Cognitive Sentinel AI",
    style: "ai_sentinel",
    themeColor: "#EF4444",
    outfitColor: "#18181B",
    features: ["超导浮空装甲", "猩红防御光眼", "全息守卫力场"],
    description: "24/7 全时运转的硅基绝对铁卫，坚决拦截违背基线的不可靠操作。",
    badge: "绝对铁卫",
    svgPath: "ai_sentinel",
  },
  {
    id: "ai_synthesizer",
    gender: "agent",
    name: "高维量子超体",
    title: "Quantum Cognitive Core",
    style: "ai_synthesizer",
    themeColor: "#FACC15",
    outfitColor: "#172554",
    features: ["高维星云核心", "多维自进化", "耀世光子环"],
    description: "无限记忆的汇聚枢纽，跨会话融会贯通，越使用越懂你的心智伴侣。",
    badge: "量子超体",
    svgPath: "ai_synthesizer",
  },
];

export function getPresetsByGender(gender: "male" | "female" | "agent"): AvatarPreset[] {
  return AVATAR_PRESETS.filter((p) => p.gender === gender);
}

export function getPresetById(id: string): AvatarPreset {
  const found = AVATAR_PRESETS.find((p) => p.id === id);
  return found || AVATAR_PRESETS[0];
}
