import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/aurora/Icon";
import { TopBar } from "@/components/aurora/primitives";
import { PublicPageFrame } from "@/components/layout/PublicPageFrame";

export const metadata: Metadata = {
  title: "帮助与支持 - Memento",
  description: "Memento 使用指南、常见问题与联系方式",
};

const SUPPORT_EMAIL = "support@ihasy.com";

const FAQS: { q: string; a: string }[] = [
  {
    q: "Memento 是什么，怎么工作？",
    a: "Memento 把你在各台设备、各个 AI 编程工具里的对话和笔记采集下来，整理成长期记忆、个人画像和技能，再在你提问时注入给智能体，让它越用越懂你。",
  },
  {
    q: "我的数据存在哪里，安全吗？",
    a: "数据存在你自己授权的服务端数据库里，可以私有化部署到自己的 NAS 或云服务器。客户端与服务端之间全程 HTTPS 加密传输，密码只存加盐散列。你的数据不会用于训练任何公共模型，也不会提供或出售给第三方。",
  },
  {
    q: "怎么配置自己的大模型？",
    a: "点左下角头像进入「个人设置」，打开「大模型配置」，填入兼容 OpenAI 接口的地址和 API Key（Claude、DeepSeek、OpenAI、Kimi、豆包或本地模型都可以），保存后立即生效。",
  },
  {
    q: "手机和电脑之间怎么同步？",
    a: "各端用同一个账号登录即可，数据经服务端实时同步：手机上发起的任务、电脑上产生的记忆，其他设备几秒内就能看到。",
  },
  {
    q: "怎么导出数据或注销账号？",
    a: "在「个人设置」→「账号安全」里可以一键导出全部数据；页面底部的「注销账号」会永久删除账号以及全部记忆、会话、设备绑定和模型配置，无法恢复。",
  },
  {
    q: "遇到问题怎么联系你们？",
    a: `发邮件到 ${SUPPORT_EMAIL}，附上设备型号、系统版本和问题截图，我们会在 24 小时内回复。`,
  },
];

const linkBtn =
  "inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[13px] font-medium transition-colors whitespace-nowrap";

export default function SupportPage() {
  return (
    <PublicPageFrame>
      <div className="mx-auto w-full max-w-3xl pb-12">
        <TopBar
          title="帮助与支持"
          subtitle="常见问题与联系方式"
          right={
            <div className="flex items-center gap-2">
              <Link
                href="/privacy"
                className={linkBtn}
                style={{
                  color: "var(--aurora-fg2)",
                  border: "1px solid var(--aurora-border)",
                  background: "var(--aurora-surface-solid)",
                }}
              >
                <Icon name="lock" size={13} />
                隐私政策
              </Link>
            </div>
          }
        />

        {/* Contact */}
        <section className="aurora-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{
                background: "var(--aurora-accent-soft)",
                color: "var(--aurora-accent)",
              }}
            >
              <Icon name="message" size={18} />
            </div>
            <div className="min-w-0">
              <div
                className="text-[15px] font-semibold"
                style={{ color: "var(--aurora-fg1)" }}
              >
                遇到问题，直接发邮件
              </div>
              <div
                className="mt-1 text-[13px] leading-relaxed"
                style={{ color: "var(--aurora-fg3)" }}
              >
                附上设备型号、系统版本和截图，24 小时内回复。
              </div>
            </div>
          </div>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className={`${linkBtn} justify-center self-start sm:self-auto`}
            style={{ background: "var(--aurora-primary-grad)", color: "#fff" }}
          >
            <Icon name="external_link" size={13} />
            {SUPPORT_EMAIL}
          </a>
        </section>

        {/* FAQ */}
        <h2
          className="mb-3 mt-8 text-[13px] font-semibold tracking-wide"
          style={{ color: "var(--aurora-fg3)" }}
        >
          常见问题
        </h2>
        <section className="aurora-card overflow-hidden">
          {FAQS.map((faq, idx) => (
            <details
              key={faq.q}
              open={idx === 0}
              className="group"
              style={
                idx > 0
                  ? { borderTop: "1px solid var(--aurora-border)" }
                  : undefined
              }
            >
              <summary
                className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-[14px] font-medium [&::-webkit-details-marker]:hidden"
                style={{ color: "var(--aurora-fg1)" }}
              >
                <span className="min-w-0">{faq.q}</span>
                <Icon
                  name="chevron_down"
                  size={14}
                  className="shrink-0 transition-transform group-open:rotate-180"
                  style={{ color: "var(--aurora-fg4)" }}
                />
              </summary>
              <div
                className="px-5 pb-4 text-[13.5px] leading-7"
                style={{ color: "var(--aurora-fg2)" }}
              >
                {faq.a}
              </div>
            </details>
          ))}
        </section>

        <footer
          className="mt-10 flex flex-wrap items-center justify-between gap-2 text-xs"
          style={{ color: "var(--aurora-fg4)" }}
        >
          <span>© {new Date().getFullYear()} Memento</span>
          <Link href="/privacy" className="hover:underline">
            隐私政策
          </Link>
        </footer>
      </div>
    </PublicPageFrame>
  );
}
