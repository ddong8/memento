import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/aurora/Icon";
import { TopBar } from "@/components/aurora/primitives";
import { PublicPageFrame } from "@/components/layout/PublicPageFrame";

export const metadata: Metadata = {
  title: "隐私政策 - Memento",
  description: "Memento 隐私政策：收集哪些信息、怎么保护、你有哪些权利",
};

const SUPPORT_EMAIL = "support@ihasy.com";

function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="aurora-card p-5 sm:p-6">
      <h2
        className="flex items-baseline gap-2.5 text-[15px] font-semibold"
        style={{ color: "var(--aurora-fg1)" }}
      >
        <span
          className="tabular-nums text-[13px] font-medium"
          style={{ color: "var(--aurora-accent)" }}
        >
          {String(n).padStart(2, "0")}
        </span>
        {title}
      </h2>
      <div
        className="mt-3 space-y-3 text-[13.5px] leading-7"
        style={{ color: "var(--aurora-fg2)" }}
      >
        {children}
      </div>
    </section>
  );
}

function Item({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="rounded-xl p-3.5"
      style={{ background: "var(--aurora-chip)" }}
    >
      <div
        className="text-[13px] font-medium"
        style={{ color: "var(--aurora-fg1)" }}
      >
        {title}
      </div>
      <div
        className="mt-1 text-[12.5px] leading-6"
        style={{ color: "var(--aurora-fg3)" }}
      >
        {children}
      </div>
    </div>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5">
          <span
            className="mt-[11px] h-1 w-1 shrink-0 rounded-full"
            style={{ background: "var(--aurora-fg4)" }}
          />
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ul>
  );
}

const strong = (s: string) => (
  <span style={{ color: "var(--aurora-fg1)", fontWeight: 500 }}>{s}</span>
);

export default function PrivacyPolicyPage() {
  return (
    <PublicPageFrame>
      <div className="mx-auto w-full max-w-3xl pb-12">
        <TopBar
          title="隐私政策"
          subtitle="生效日期：2026 年 10 月"
          right={
            <Link
              href="/support"
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 py-1.5 text-[13px] font-medium transition-colors"
              style={{
                color: "var(--aurora-fg2)",
                border: "1px solid var(--aurora-border)",
                background: "var(--aurora-surface-solid)",
              }}
            >
              <Icon name="message" size={13} />
              帮助与支持
            </Link>
          }
        />

        <div className="space-y-4">
          <Section n={1} title="数据归你所有">
            <p>Memento 是你的个人记忆与 AI 执事。我们坚持三条原则：</p>
            <Bullets
              items={[
                <>你的记忆、会话、设备信息和作息数据完全属于你本人；</>,
                <>
                  {strong("不向任何第三方或广告商出售、出租或共享")}
                  你的个人信息；
                </>,
                <>未经你明确同意，你的数据不会用于训练任何公共模型。</>,
              ]}
            />
          </Section>

          <Section n={2} title="我们处理哪些信息">
            <p>
              为提供长期记忆、智能体调度和多设备同步，在你授权的前提下会处理以下信息：
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <Item title="账号信息">
                注册时的用户名、邮箱或单点登录凭据，用于登录鉴权和多设备同步。
              </Item>
              <Item title="记忆与会话">
                你记录的笔记、待办、规则和历史问答，用于建立检索索引和知识图谱。
              </Item>
              <Item title="设备状态">
                你绑定的电脑的机器名和在线状态，用于执行你发起的远程任务。
              </Item>
              <Item title="大模型配置">
                你在个人设置里填写的 API 地址和
                Key，加密保存，只用于你自己的问答。
              </Item>
            </div>
          </Section>

          <Section n={3} title="手机端的系统权限">
            <p>
              在 iOS / Android 应用里，只有你用到对应功能时才会向系统申请权限：
            </p>
            <Bullets
              items={[
                <>
                  {strong("麦克风与语音识别：")}
                  仅在语音输入时使用，转成文字后立即释放，不在后台录音。
                </>,
                <>
                  {strong("照片与相机：")}
                  仅在上传头像或生成卡通形象时，让你从相册选择或拍照，不读取未选中的照片。
                </>,
                <>
                  {strong("通知：")}
                  在定时提醒或你关注的长任务完成时，推送进展和每日摘要。
                </>,
              ]}
            />
          </Section>

          <Section n={4} title="存储与安全">
            <p>
              客户端与服务端之间全程通过 HTTPS
              加密传输；密码只保存加盐散列（bcrypt），API Key
              加密存储。你也可以把整套服务私有化部署到自己的 NAS
              或云服务器上，数据完全不经过第三方。
            </p>
          </Section>

          <Section n={5} title="你的权利：导出与注销">
            <p>
              依照《个人信息保护法》、GDPR、CCPA 以及 App Store
              审核准则，你对自己的数据有完全的控制权：
            </p>
            <Bullets
              items={[
                <>
                  {strong("导出数据：")}
                  在「个人设置」→「账号安全」里一键导出全部记忆、会话和待办。
                </>,
                <>
                  {strong("注销账号：")}
                  在同一页底部发起注销，确认后立即永久删除账号以及全部会话、记忆、模型配置和设备绑定，无法恢复。
                </>,
              ]}
            />
          </Section>

          <Section n={6} title="联系我们">
            <p>对本政策有任何疑问、建议或投诉，可以通过以下方式联系我们：</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="inline-flex items-center gap-1.5 hover:underline"
                style={{ color: "var(--aurora-accent)" }}
              >
                <Icon name="external_link" size={13} />
                {SUPPORT_EMAIL}
              </a>
              <Link
                href="/support"
                className="inline-flex items-center gap-1.5 hover:underline"
                style={{ color: "var(--aurora-accent)" }}
              >
                <Icon name="message" size={13} />
                帮助与支持
              </Link>
            </div>
          </Section>
        </div>

        <footer
          className="mt-10 text-center text-xs"
          style={{ color: "var(--aurora-fg4)" }}
        >
          © {new Date().getFullYear()} Memento
        </footer>
      </div>
    </PublicPageFrame>
  );
}
