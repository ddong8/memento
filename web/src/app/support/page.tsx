import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "技术支持与用户帮助 (Support & Help) - Memento",
  description: "Memento 客户支持、使用指南与常见问题解答",
};

const FAQS = [
  {
    q: "什么是 Memento？它如何工作？",
    a: "Memento 是您的全天候个人数字记忆执事与第二大脑。它通过端到端知识图谱与向量语义索引，跨设备帮您沉淀日常经验、工作规范、待办备忘与核心原则，让 AI 在与您的每一次对话中越用越懂您。",
  },
  {
    q: "我的数据存储在哪里？是否安全？",
    a: "您的所有数据默认存储在您授权的受保护数据库中，支持完全私有化部署（部署在个人 NAS 或私有云上）。我们采用端到端传输加密，绝不将您的私有记忆用于任何公共模型的通用预训练，也绝不向第三方分享或销售数据。",
  },
  {
    q: "如何配置我自己的大模型（LLM）？",
    a: "进入应用后，点击右上角【个人设置】->【大模型配置】，您可以自由选择并填入兼容 OpenAI 接口标准的 API 端点（如 Claude、DeepSeek、OpenAI、月之暗面 Kimi、字节豆包或本地部署模型），填入您的专属 API Key 即可立即启用。",
  },
  {
    q: "如何在 iOS / Android 移动端与桌面端多设备同步？",
    a: "只需使用相同账户在各端登录，系统即可基于实时 WebSocket 与云端数据网关自动实现双向实时同步。您在手机上的语音吩咐或桌面端的任务沉淀都会实时更新至统一记忆图谱中。",
  },
  {
    q: "如何彻底删除我的账户与所有个人数据？",
    a: "在【个人设置】->【账号安全】标签页滑动至底部，点击【注销账号】按钮并按提示确认。确认后，服务器将立即永久从物理数据库抹除您的全部账户信息、会话、记忆实体与任务数据，该操作不可逆。",
  },
  {
    q: "遇到系统问题或 Bug，如何获取帮助？",
    a: "您可以通过发送邮件至 support@ihasy.com 联系我们的技术团队，附上您的设备型号、操作系统版本及问题截图，我们会在 24 小时内为您排查并答复。",
  },
];

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-[var(--aurora-bg,#0B0B12)] text-[var(--aurora-fg,#E5E7EB)] px-6 py-12 md:py-20 flex flex-col justify-between">
      <div className="max-w-3xl mx-auto w-full">
        {/* Header */}
        <div className="mb-10 pb-6 border-b border-[var(--aurora-border,rgba(255,255,255,0.08))] flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                用户帮助与技术支持中心
              </span>
              <span className="text-xs text-[var(--aurora-fg4,#9CA3AF)]">7×24小时在线支持</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-cyan-400 via-teal-300 to-indigo-300 bg-clip-text text-transparent">
              Memento 支持中心 (Support)
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/privacy"
              className="text-xs px-3 py-1.5 rounded-xl border border-[var(--aurora-border,rgba(255,255,255,0.1))] hover:bg-white/5 transition text-[var(--aurora-fg2,#D1D5DB)]"
            >
              隐私政策
            </Link>
            <Link
              href="/"
              className="text-xs px-3 py-1.5 rounded-xl bg-purple-600/30 border border-purple-500/30 hover:bg-purple-600/40 transition text-purple-200"
            >
              进入工作台
            </Link>
          </div>
        </div>

        {/* Contact Banner */}
        <div className="mb-10 p-6 rounded-2xl bg-gradient-to-r from-purple-900/20 via-indigo-900/20 to-blue-900/20 border border-purple-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="text-lg font-bold text-white mb-1">需要一对一人工技术支持？</div>
            <div className="text-xs text-[var(--aurora-fg3,#9CA3AF)]">我们的工程师团队将全天候响应您的技术咨询与功能反馈</div>
          </div>
          <a
            href="mailto:support@ihasy.com"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-xl bg-purple-600 text-white font-medium text-sm hover:bg-purple-500 transition shadow-lg shadow-purple-900/30"
          >
            联系官方邮箱：support@ihasy.com
          </a>
        </div>

        {/* FAQs */}
        <div className="space-y-6">
          <h2 className="text-xl font-bold text-white mb-4">常见问题解答 (FAQ)</h2>
          <div className="space-y-4">
            {FAQS.map((faq, idx) => (
              <div
                key={idx}
                className="p-5 rounded-2xl bg-[var(--aurora-card,rgba(255,255,255,0.03))] border border-[var(--aurora-border,rgba(255,255,255,0.06))] hover:border-purple-500/30 transition"
              >
                <div className="font-semibold text-white text-base mb-2 flex items-center gap-2">
                  <span className="text-purple-400 font-bold">Q{idx + 1}.</span>
                  {faq.q}
                </div>
                <div className="text-sm text-[var(--aurora-fg2,#D1D5DB)] leading-relaxed pl-6">
                  {faq.a}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto w-full mt-16 pt-6 border-t border-[var(--aurora-border,rgba(255,255,255,0.06))] flex items-center justify-between text-xs text-[var(--aurora-fg4,#6B7280)]">
        <div>&copy; {new Date().getFullYear()} Memento Inc. 技术支持与服务保障</div>
        <div className="flex gap-4">
          <Link href="/privacy" className="hover:underline">隐私政策</Link>
          <Link href="/" className="hover:underline">主页</Link>
        </div>
      </div>
    </div>
  );
}
