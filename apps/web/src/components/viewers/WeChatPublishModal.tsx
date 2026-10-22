"use client";

import { memo, useEffect, useState } from "react";
import { FiX, FiCheck, FiSend, FiAlertCircle, FiImage, FiExternalLink } from "react-icons/fi";

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
      const convertRes = await fetch(`${WX_API_BASE}/api/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-xl bg-[var(--aurora-surface-solid,#0f172a)] border border-[var(--aurora-border-strong)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--aurora-border)] flex items-center justify-between bg-[var(--aurora-chip)]/40 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/15 text-emerald-400 font-bold text-sm">
              微
            </span>
            <div>
              <h3 className="text-sm font-semibold text-[var(--aurora-fg1)]">推送到微信公众号草稿箱</h3>
              <p className="text-[11px] text-[var(--aurora-fg3)]">直连官方草稿 API · 自动转存正文图片防盗链</p>
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

        {/* Body Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 text-left text-xs">
          {successMediaId ? (
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
            <span className="truncate">{stepStatus || (successMediaId ? "已完成" : "准备就绪")}</span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {successMediaId ? (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-medium text-xs transition-colors cursor-pointer shadow-sm"
              >
                完成返回工作台
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  className="px-3.5 py-1.5 rounded-lg border border-[var(--aurora-border)] text-[var(--aurora-fg2)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] font-medium text-xs transition-colors cursor-pointer disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-all shadow-md active:scale-95 cursor-pointer disabled:opacity-50"
                >
                  <FiSend className="w-3.5 h-3.5" />
                  <span>{loading ? "正在推送..." : "确认推送到草稿箱"}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
