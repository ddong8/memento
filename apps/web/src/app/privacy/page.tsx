import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "隐私政策 (Privacy Policy) - Memento",
  description: "Memento 隐私政策与个人数据主权保护声明",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[var(--aurora-bg,#0B0B12)] text-[var(--aurora-fg,#E5E7EB)] px-6 py-12 md:py-20 flex flex-col justify-between">
      <div className="max-w-3xl mx-auto w-full">
        {/* Header */}
        <div className="mb-10 pb-6 border-b border-[var(--aurora-border,rgba(255,255,255,0.08))] flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
                法律合规与隐私保护
              </span>
              <span className="text-xs text-[var(--aurora-fg4,#9CA3AF)]">生效日期：2026年10月</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-purple-400 via-indigo-300 to-pink-300 bg-clip-text text-transparent">
              Memento 隐私政策 (Privacy Policy)
            </h1>
          </div>
          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-xl border border-[var(--aurora-border,rgba(255,255,255,0.1))] hover:bg-white/5 transition text-[var(--aurora-fg2,#D1D5DB)]"
          >
            返回首页
          </Link>
        </div>

        {/* Content */}
        <div className="space-y-8 text-sm md:text-base leading-relaxed text-[var(--aurora-fg2,#D1D5DB)]">
          <section className="bg-[var(--aurora-card,rgba(255,255,255,0.03))] p-6 rounded-2xl border border-[var(--aurora-border,rgba(255,255,255,0.06))] shadow-sm">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-500"></span>
              1. 核心原则：数据主权归您所有
            </h2>
            <p className="mb-2">
              Memento 旨在成为您的<strong>专属第二大脑与个人智能执事</strong>。我们秉持“用户数据私有、加密自控、透明隔离”的最高隐私保护原则：
            </p>
            <ul className="list-disc list-inside space-y-1 text-sm text-[var(--aurora-fg3,#9CA3AF)]">
              <li>您的记忆、会话、设备上下文与生活作息数据完全属于您本人；</li>
              <li>我们<strong>绝不向任何第三方机构或广告商出售、出租或共享</strong>您的任何个人信息与记忆；</li>
              <li>未经您的显式许可，您的私有数据绝不会被用于任何通用基础大模型的公共预训练。</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
              2. 我们收集与处理的信息类型
            </h2>
            <p>为向您提供长期记忆沉淀、智能调度与跨端协同服务，Memento 在您授权的前提下可能处理以下信息：</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <div className="font-semibold text-white mb-1">账号与认证信息</div>
                <div className="text-xs text-[var(--aurora-fg4,#9CA3AF)]">
                  注册时提供的用户名、邮箱或受信任单点登录凭据，用于保障多设备数据加密同步与账户安全鉴权。
                </div>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <div className="font-semibold text-white mb-1">记忆与会话知识</div>
                <div className="text-xs text-[var(--aurora-fg4,#9CA3AF)]">
                  您在工作台与客户端主动记录的笔记、待办、长期规则与历史问答，经由您授权的端点进行向量索引与知识图谱构建。
                </div>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <div className="font-semibold text-white mb-1">终端设备与节点状态</div>
                <div className="text-xs text-[var(--aurora-fg4,#9CA3AF)]">
                  您主动绑定的终端工作机器的基础运行状态（机器名、连接健康度），用于协助执行您授权的远程调度任务。
                </div>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <div className="font-semibold text-white mb-1">自选大模型配置</div>
                <div className="text-xs text-[var(--aurora-fg4,#9CA3AF)]">
                  您在个人设置中自行填写的自定义 AI API Key 与端点，采用安全密文持久化，仅用于发起您的专属问答流。
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-pink-500"></span>
              3. 移动端设备系统权限使用说明
            </h2>
            <p>在 iOS / Android 移动端应用中，Memento 仅在您主动使用对应功能时向操作系统申请权限：</p>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="font-semibold text-white shrink-0">• 麦克风与语音识别 (Microphone & Speech)：</span>
                <span>仅在您使用“语音吩咐 / 实时听写”功能时调用，实时转录文本后即释放硬件占用，不后台静默窃听。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-semibold text-white shrink-0">• 照片与相机权限 (Photo Library & Camera)：</span>
                <span>仅在您选择“上传真实头像”或定制专属卡通数字孪生形象时，允许您从本地相册选取或拍照，不会扫描未选中的媒体。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-semibold text-white shrink-0">• 系统推送通知 (Push Notifications)：</span>
                <span>用于在设定时间或您关注的自动化长任务完成时，向您发送及时的任务进展与晨报晚思摘要。</span>
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-500"></span>
              4. 数据的存储、加密与安全保障
            </h2>
            <p>
              全部客户端与服务端交互均强制通过 TLS 1.3 / HTTPS 加密信道传输。密码使用行业级高强度散列算法（Bcrypt / Argon2）存储；关键 API 密钥采用强加密隔离。您亦可将 Memento 全套服务私有化部署在您专属的家庭 NAS 或私有云服务器中，达成物理级别的完全隔离。
            </p>
          </section>

          <section className="bg-red-500/[0.04] p-6 rounded-2xl border border-red-500/20">
            <h2 className="text-lg font-bold text-red-400 mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              5. 您的权利：数据导出与账户彻底注销
            </h2>
            <p className="mb-3 text-sm">
              符合国际通用隐私法规（GDPR、CCPA 及中国个人信息保护法 PIPL）以及 Apple App Store 审核准则，您拥有对其个人数据的完全控制权：
            </p>
            <ul className="list-disc list-inside space-y-1.5 text-sm text-[var(--aurora-fg3,#9CA3AF)]">
              <li><strong>数据导出</strong>：您可随时在“个人设置 -&gt; 数据管理”中，将全部记忆知识图谱、会话与待办一键导出为标准 JSON / Markdown 文件；</li>
              <li><strong>账号注销与数据清除</strong>：您可在客户端或网页端“个人设置 -&gt; 账号安全”中发起“注销账号”。确认后，系统将<strong>立即且永久从数据库中物理抹除您的账户、所有会话记录、记忆实体、模型密钥及设备绑定关系</strong>，不可逆回退。</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500"></span>
              6. 联系我们与技术支持
            </h2>
            <p>
              若您对本隐私政策有任何疑问、建议或合规申诉，欢迎通过以下渠道与我们取得联系：
            </p>
            <div className="text-sm bg-white/[0.02] p-4 rounded-xl border border-white/5">
              <div>电子邮箱：<span className="text-purple-400">support@ihasy.com</span></div>
              <div className="mt-1">技术支持页面：<Link href="/support" className="text-purple-400 hover:underline">https://mem.ihasy.com/support</Link></div>
            </div>
          </section>
        </div>
      </div>

      <div className="max-w-3xl mx-auto w-full mt-16 pt-6 border-t border-[var(--aurora-border,rgba(255,255,255,0.06))] text-center text-xs text-[var(--aurora-fg4,#6B7280)]">
        &copy; {new Date().getFullYear()} Memento Inc. All rights reserved. 保护您的长期数字记忆与数据隐私。
      </div>
    </div>
  );
}
