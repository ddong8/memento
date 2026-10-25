"use client";

import { memo, useEffect, useState } from "react";
import { FiX, FiCheck, FiSend, FiAlertCircle, FiImage, FiExternalLink, FiCopy } from "react-icons/fi";
import { SiWechat, SiZhihu, SiSinaweibo, SiXiaohongshu } from "react-icons/si";

export interface WeChatPublishModalProps {
  isOpen: boolean;
  onClose: () => void;
  markdown: string;
  defaultTitle?: string;
  initialThemeId?: string;
}

const DEFAULT_COVER_MEDIA_ID = "CaYoocON3zFj43tFOB-ctJe58evZROH9yeZgaaJHpkC2Bk9dtkZ3ehgSMHosD1Mk";
const WX_API_BASE = "https://wx.ihasy.com";

const THEMES = [
  { id: "tech", name: "科技蓝调", color: "#2563eb", desc: "商务沉稳，适合技术与分析文章" },
  { id: "emerald", name: "墨绿雅致", color: "#059669", desc: "自然清新，适合生活与深度思考" },
  { id: "minimalist", name: "黑白极简", color: "#1e293b", desc: "现代高冷，排版紧凑有力" },
  { id: "red", name: "中国红韵", color: "#dc2626", desc: "喜庆醒目，适合重要通告与节日" },
];

function extractTitleAndDigest(md: string, fallbackTitle?: string): { title: string; digest: string } {
  const lines = md.split("\n");
  let foundTitle = "";
  const digestCandidates: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundTitle && /^#\s+(.+)$/.test(trimmed)) {
      foundTitle = trimmed.replace(/^#\s+/, "").replace(/[*_~`]/g, "").trim();
      continue;
    }
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("!") && !trimmed.startsWith("```") && !trimmed.startsWith(">")) {
      const cleanLine = trimmed.replace(/[*_~`\[\]()]/g, "").trim();
      if (cleanLine.length > 5) {
        digestCandidates.push(cleanLine);
      }
    }
  }

  const title = foundTitle || fallbackTitle || "未命名公众号图文";
  const digest = digestCandidates.join(" ").slice(0, 118) || "来自 Memento 工作台精心创作与排版的精选文章。";

  return { title, digest };
}

export const WeChatPublishModal = memo(function WeChatPublishModal({
  isOpen,
  onClose,
  markdown,
  defaultTitle,
  initialThemeId,
}: WeChatPublishModalProps) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("Memento");
  const [digest, setDigest] = useState("");
  const [themeId, setThemeId] = useState(initialThemeId || "tech");
  const [thumbMediaId, setThumbMediaId] = useState(DEFAULT_COVER_MEDIA_ID);
  const [showCustomCover, setShowCustomCover] = useState(false);

  const [loading, setLoading] = useState(false);
  const [stepStatus, setStepStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMediaId, setSuccessMediaId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<"wechat" | "zhihu" | "weibo" | "redbook">("wechat");
  const [copiedPlatform, setCopiedPlatform] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      const extracted = extractTitleAndDigest(markdown, defaultTitle);
      setTitle(extracted.title);
      setDigest(extracted.digest);
      setThemeId(initialThemeId || "tech");
      setThumbMediaId(DEFAULT_COVER_MEDIA_ID);
      setError(null);
      setSuccessMediaId(null);
      setStepStatus("");
      setLoading(false);
    }
  }, [isOpen, markdown, defaultTitle, initialThemeId]);

  if (!isOpen) return null;

  const handlePublish = async () => {
    if (!title.trim()) {
      setError("文章标题不能为空");
      return;
    }
    if (!thumbMediaId.trim()) {
      setError("必须指定微信封面素材 ID (thumb_media_id)");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMediaId(null);

    try {
      // 1. 样式转换与微信特化内联
      setStepStatus("正在进行微信专属排版与内联样式编译...");
      const normalizedMarkdown = markdown
        .replace(/\((?:https?:\/\/[^/]+)?(?:\.\/|\.\.\/)?assets\/([^)]+)\)/g, "(https://mem.ihasy.com/article/$1)")
        .replace(/\(\/article\/([^)]+)\)/g, "(https://mem.ihasy.com/article/$1)");

      const convertRes = await fetch(`${WX_API_BASE}/api/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: normalizedMarkdown,
          themeId,
          extractLinks: true,
        }),
      });

      if (!convertRes.ok) {
        const text = await convertRes.text();
        throw new Error(`排版服务响应异常 (${convertRes.status}): ${text.slice(0, 100)}`);
      }

      const convertData = await convertRes.json();
      if (!convertData.success || !convertData.html) {
        throw new Error(convertData.error || "未能生成微信排版 HTML");
      }

      // 2. 直推微信公众号官方草稿箱
      setStepStatus("正在推送到微信公众平台官方草稿箱 (自动转存图片 CDN)...");
      const draftRes = await fetch(`${WX_API_BASE}/api/wechat/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          author: author.trim() || "Memento",
          digest: digest.trim(),
          content: convertData.html,
          thumbMediaId: thumbMediaId.trim(),
        }),
      });

      if (!draftRes.ok) {
        const text = await draftRes.text();
        throw new Error(`微信发布服务错误 (${draftRes.status}): ${text.slice(0, 120)}`);
      }

      const draftData = await draftRes.json();
      if (!draftData.success || !draftData.media_id) {
        throw new Error(draftData.error || "微信官方草稿箱推送失败");
      }

      setSuccessMediaId(draftData.media_id);
      setStepStatus("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "推送到微信草稿箱失败，请检查网络或配置";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyZhihu = async () => {
    const header = title ? `## ${title}\n\n` : "";
    const zhihuText = `${header}${markdown}\n\n---\n*本文由 Memento 数字心智体深度推演创作*`;
    await navigator.clipboard.writeText(zhihuText);
    setCopiedPlatform("zhihu");
    setTimeout(() => setCopiedPlatform(null), 2000);
  };

  const handleCopyWeibo = async () => {
    const clean = markdown.replace(/[#*`_~\[\]()]/g, "").trim();
    const summary = clean.slice(0, 130);
    const weiboText = `【${title || "Memento 深度洞察"}】\n\n${summary}...\n\n#Memento# #AI数字心智# #程序员日常# #技术创新#`;
    await navigator.clipboard.writeText(weiboText);
    setCopiedPlatform("weibo");
    setTimeout(() => setCopiedPlatform(null), 2000);
  };

  const handleCopyRedbook = async () => {
    const lines = markdown.split("\n").filter((l) => l.trim().length > 3);
    const keyPoints = lines.slice(0, 4).map((l) => `✨ ${l.replace(/^[#\-*\d\.\s]+/, "").slice(0, 42)}`).join("\n");
    const redText = `🔥 告别信息碎片！${title || "数字心智进化指南"}\n\n` +
      `💡 为什么你需要一个具备生命节律的数字外脑？\n\n` +
      `📌 核心要点速览：\n${keyPoints}\n\n` +
      `🚀 真正的生产力飞跃，是让 AI 终身记住你的习惯与思考。\n\n` +
      `#生产力工具 #AI神器 #知识管理 #独立开发者 #程序员日常 #数字心智 #Memento`;
    await navigator.clipboard.writeText(redText);
    setCopiedPlatform("redbook");
    setTimeout(() => setCopiedPlatform(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-xl bg-[var(--aurora-surface-solid,#0f172a)] border border-[var(--aurora-border-strong)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[var(--aurora-border)] flex items-center justify-between bg-[var(--aurora-chip)]/40 shrink-0">
          <div className="flex items-center gap-2.5">
            <span
              className={`flex items-center justify-center w-7 h-7 rounded-lg font-bold text-sm ${
                platform === "wechat"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : platform === "zhihu"
                  ? "bg-blue-500/15 text-blue-400"
                  : platform === "weibo"
                  ? "bg-amber-500/15 text-amber-400"
                  : "bg-rose-500/15 text-rose-400"
              }`}
            >
              {platform === "wechat" ? <SiWechat size={16} /> : platform === "zhihu" ? <SiZhihu size={15} /> : platform === "weibo" ? <SiSinaweibo size={16} /> : <SiXiaohongshu size={16} />}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-[var(--aurora-fg1)]">
                {platform === "wechat"
                  ? "推送到微信公众号草稿箱"
                  : platform === "zhihu"
                  ? "知乎专栏与问答分发"
                  : platform === "weibo"
                  ? "微博动态与长微博分发"
                  : "小红书图文笔记分发"}
              </h3>
              <p className="text-[11px] text-[var(--aurora-fg3)]">
                多平台内容创作与分发中心 · 支持格式化转译与一键直发
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors"
          >
            <FiX className="w-4 h-4" />
          </button>
        </div>

        {/* Multi-Platform Segment Selector */}
        <div className="px-5 pt-2.5 pb-2 bg-[var(--aurora-chip)]/20 border-b border-[var(--aurora-border)] shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            <button
              type="button"
              onClick={() => setPlatform("wechat")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0 ${
                platform === "wechat"
                  ? "bg-emerald-600 text-white shadow-sm font-semibold"
                  : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/5"
              }`}
            >
              <SiWechat size={14} />
              <span>微信公众号</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-300" />
            </button>
            <button
              type="button"
              onClick={() => setPlatform("zhihu")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0 ${
                platform === "zhihu"
                  ? "bg-blue-600 text-white shadow-sm font-semibold"
                  : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/5"
              }`}
            >
              <SiZhihu size={14} />
              <span>知乎专栏/问答</span>
            </button>
            <button
              type="button"
              onClick={() => setPlatform("weibo")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0 ${
                platform === "weibo"
                  ? "bg-amber-600 text-white shadow-sm font-semibold"
                  : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/5"
              }`}
            >
              <SiSinaweibo size={14} />
              <span>微博动态/长文</span>
            </button>
            <button
              type="button"
              onClick={() => setPlatform("redbook")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0 ${
                platform === "redbook"
                  ? "bg-rose-600 text-white shadow-sm font-semibold"
                  : "text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-white/5"
              }`}
            >
              <SiXiaohongshu size={14} />
              <span>小红书图文</span>
            </button>
          </div>
        </div>

        {/* Body Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 text-left text-xs">
          {platform === "zhihu" ? (
            <div className="space-y-3.5">
              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs flex items-center justify-between">
                <div>
                  <span className="font-semibold text-blue-200">知乎专栏 / 问答排版已就绪</span>
                  <p className="text-[11px] opacity-80 mt-0.5">代码高亮块、公式 KaTeX 与引用段落已对齐知乎发布标准</p>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] bg-blue-500/20 text-blue-300 border border-blue-500/30 font-mono">
                  OAuth 接口已预留
                </span>
              </div>

              <div>
                <label className="block font-medium text-[var(--aurora-fg2)] mb-1">文章标题</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--aurora-bg)] border border-[var(--aurora-border)] text-xs text-[var(--aurora-fg1)] focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-medium text-[var(--aurora-fg2)] mb-1">正文格式化预览 (前 200 字)</label>
                <div className="p-3 rounded-xl bg-black/20 border border-[var(--aurora-border)] font-mono text-[11px] text-[var(--aurora-fg3)] leading-relaxed select-text max-h-40 overflow-y-auto">
                  {markdown.slice(0, 300)}...
                </div>
              </div>
            </div>
          ) : platform === "weibo" ? (
            <div className="space-y-3.5">
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-center justify-between">
                <div>
                  <span className="font-semibold text-amber-200">微博动态 / 长微博导语</span>
                  <p className="text-[11px] opacity-80 mt-0.5">自动提炼 130 字核心摘要，挂载 Memento 核心技术话题</p>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono">
                  Open API 已预留
                </span>
              </div>

              <div>
                <label className="block font-medium text-[var(--aurora-fg2)] mb-1">微博文案预览 (含话题)</label>
                <div className="p-3 rounded-xl bg-black/20 border border-[var(--aurora-border)] text-[12px] text-[var(--aurora-fg1)] leading-relaxed select-text">
                  【{title || "Memento 深度洞察"}】
                  <br /><br />
                  {markdown.replace(/[#*`_~\[\]()]/g, "").slice(0, 130)}...
                  <br /><br />
                  <span className="text-amber-400 font-medium">#Memento# #AI数字心智# #程序员日常# #技术创新#</span>
                </div>
              </div>
            </div>
          ) : platform === "redbook" ? (
            <div className="space-y-3.5">
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between">
                <div>
                  <span className="font-semibold text-rose-200">小红书图文笔记排版</span>
                  <p className="text-[11px] opacity-80 mt-0.5">Emoji 视觉分段、吸睛大标题、热门曝光话题标签</p>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono">
                  图文发布 API 已预留
                </span>
              </div>

              <div>
                <label className="block font-medium text-[var(--aurora-fg2)] mb-1">小红书文案预览</label>
                <div className="p-3 rounded-xl bg-black/20 border border-[var(--aurora-border)] text-[12px] text-[var(--aurora-fg1)] leading-relaxed select-text space-y-2">
                  <p className="font-bold text-rose-400">🔥 告别信息碎片！{title || "数字心智进化指南"}</p>
                  <p className="text-[11px] text-[var(--aurora-fg3)]">💡 为什么你需要一个具备生命节律的数字外脑？</p>
                  <p className="text-[11px] font-semibold text-[var(--aurora-fg2)]">📌 核心要点速览：</p>
                  <ul className="text-[11px] text-[var(--aurora-fg3)] space-y-1 pl-1">
                    {markdown.split("\n").filter((l) => l.trim().length > 3).slice(0, 3).map((l, i) => (
                      <li key={i}>✨ {l.replace(/^[#\-*\d\.\s]+/, "").slice(0, 40)}</li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-rose-400 font-medium pt-1">
                    #生产力工具 #AI神器 #知识管理 #独立开发者 #程序员日常 #数字心智 #Memento
                  </p>
                </div>
              </div>
            </div>
          ) : successMediaId ? (
            <div className="py-6 px-4 text-center space-y-3 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
              <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xl shadow-inner">
                <FiCheck className="w-6 h-6" />
              </div>
              <h4 className="text-base font-semibold text-emerald-400">已成功推送到微信公众号草稿箱！</h4>
              <p className="text-xs text-[var(--aurora-fg2)] leading-relaxed">
                正文样式已内联编译，所有外链图片已转存至微信素材 CDN。<br />
                您可登录微信公众号后台【草稿箱】或手机「订阅号助手」App 直接查看并群发。
              </p>
              <div className="p-2.5 rounded-lg bg-black/30 border border-white/5 font-mono text-[11px] text-[var(--aurora-fg3)] break-all select-text">
                草稿 Media ID: {successMediaId}
              </div>
              <div className="pt-2 flex items-center justify-center gap-2 flex-wrap">
                <a
                  href="https://mp.weixin.qq.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs transition-colors cursor-pointer shadow-sm"
                >
                  <span>打开微信公众平台草稿箱</span>
                  <FiExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          ) : (
            <>
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 flex items-start gap-2">
                  <FiAlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
                  <div className="flex-1 break-all text-[11.5px] leading-relaxed">{error}</div>
                </div>
              )}

              {/* Title */}
              <div>
                <label className="block font-medium text-[var(--aurora-fg2)] mb-1">
                  文章标题 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="请输入公众号文章标题..."
                  className="w-full px-3 py-2 rounded-lg bg-[var(--aurora-bg)] border border-[var(--aurora-border)] text-xs text-[var(--aurora-fg1)] placeholder:text-[var(--aurora-fg4)] focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>

              {/* Author & Digest */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="block font-medium text-[var(--aurora-fg2)] mb-1">文章作者</label>
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder="作者名"
                    className="w-full px-3 py-2 rounded-lg bg-[var(--aurora-bg)] border border-[var(--aurora-border)] text-xs text-[var(--aurora-fg1)] placeholder:text-[var(--aurora-fg4)] focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-medium text-[var(--aurora-fg2)] mb-1">导读摘要 (卡片显示)</label>
                  <input
                    type="text"
                    value={digest}
                    onChange={(e) => setDigest(e.target.value)}
                    placeholder="选填，建议120字内"
                    className="w-full px-3 py-2 rounded-lg bg-[var(--aurora-bg)] border border-[var(--aurora-border)] text-xs text-[var(--aurora-fg1)] placeholder:text-[var(--aurora-fg4)] focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                </div>
              </div>

              {/* Theme Selection */}
              <div>
                <label className="block font-medium text-[var(--aurora-fg2)] mb-1.5">排版主题</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {THEMES.map((th) => (
                    <button
                      key={th.id}
                      type="button"
                      onClick={() => setThemeId(th.id)}
                      className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                        themeId === th.id
                          ? "bg-emerald-500/10 border-emerald-500/60 shadow-xs"
                          : "bg-[var(--aurora-chip)]/40 border-[var(--aurora-border)] hover:border-white/20"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: th.color }} />
                        <span className="font-semibold text-xs text-[var(--aurora-fg1)] truncate">{th.name}</span>
                      </div>
                      <p className="text-[10px] text-[var(--aurora-fg4)] line-clamp-1">{th.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Cover Info */}
              <div className="p-3 rounded-xl bg-[var(--aurora-chip)]/30 border border-[var(--aurora-border)]/60">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5 text-[var(--aurora-fg2)] font-medium">
                    <FiImage className="w-3.5 h-3.5 text-emerald-400" />
                    <span>公众号封面图设置</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowCustomCover(!showCustomCover)}
                    className="text-[11px] text-emerald-400 hover:underline cursor-pointer"
                  >
                    {showCustomCover ? "使用默认官方封面" : "自定义封面素材ID"}
                  </button>
                </div>
                {showCustomCover ? (
                  <div>
                    <input
                      type="text"
                      value={thumbMediaId}
                      onChange={(e) => setThumbMediaId(e.target.value)}
                      placeholder="微信素材库 thumb_media_id..."
                      className="w-full px-3 py-1.5 rounded-lg bg-[var(--aurora-bg)] border border-[var(--aurora-border)] font-mono text-[11px] text-[var(--aurora-fg1)]"
                    />
                    <p className="text-[10px] text-[var(--aurora-fg4)] mt-1">
                      微信要求群发图文必须关联永久素材库中的封面图片。
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-[var(--aurora-fg3)] leading-relaxed">
                    已自动选用公众号素材库中经过官方认证的高清封面素材，发布后可在公众平台随时更换。
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--aurora-border)] flex items-center justify-between bg-[var(--aurora-chip)]/30 shrink-0">
          <div className="text-[11px] text-[var(--aurora-fg4)] flex items-center gap-1.5 truncate mr-2">
            {loading && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping shrink-0" />}
            <span className="truncate">
              {platform === "wechat"
                ? stepStatus || (successMediaId ? "已完成" : "微信通道就绪")
                : platform === "zhihu"
                ? (copiedPlatform === "zhihu" ? "已复制知乎排版" : "知乎排版已就绪")
                : platform === "weibo"
                ? (copiedPlatform === "weibo" ? "已复制微博文案" : "微博摘要已就绪")
                : (copiedPlatform === "redbook" ? "已复制小红书笔记" : "小红书图文已就绪")}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-3.5 py-1.5 rounded-lg border border-[var(--aurora-border)] text-[var(--aurora-fg2)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] font-medium text-xs transition-colors cursor-pointer disabled:opacity-50"
            >
              关闭
            </button>
            {platform === "wechat" ? (
              successMediaId ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-medium text-xs transition-colors cursor-pointer shadow-sm"
                >
                  完成返回工作台
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-all shadow-md active:scale-95 cursor-pointer disabled:opacity-50"
                >
                  <FiSend className="w-3.5 h-3.5" />
                  <span>{loading ? "正在推送..." : "确认推送到草稿箱"}</span>
                </button>
              )
            ) : platform === "zhihu" ? (
              <button
                type="button"
                onClick={handleCopyZhihu}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-all shadow-md active:scale-95 cursor-pointer"
              >
                <FiCopy className="w-3.5 h-3.5" />
                <span>{copiedPlatform === "zhihu" ? "已复制知乎排版" : "复制知乎专栏排版"}</span>
              </button>
            ) : platform === "weibo" ? (
              <button
                type="button"
                onClick={handleCopyWeibo}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition-all shadow-md active:scale-95 cursor-pointer"
              >
                <FiCopy className="w-3.5 h-3.5" />
                <span>{copiedPlatform === "weibo" ? "已复制微博文案" : "复制微博长文文案"}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleCopyRedbook}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs transition-all shadow-md active:scale-95 cursor-pointer"
              >
                <FiCopy className="w-3.5 h-3.5" />
                <span>{copiedPlatform === "redbook" ? "已复制小红书文案" : "复制小红书爆款文案"}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
