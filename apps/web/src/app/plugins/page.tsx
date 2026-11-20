"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  usePlugins,
  type PluginFieldSpec,
  type PluginItem,
  type PluginTestResult,
} from "@/lib/plugins-context";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Chip, Glass, TopBar } from "@/components/aurora/primitives";

type FilterKey = "all" | "installed" | "创作生产" | "内容分发";

export default function PluginsPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-5xl mx-auto py-16 text-center text-sm text-[var(--aurora-fg3)]">
          正在加载插件市场...
        </div>
      }
    >
      <PluginsContent />
    </Suspense>
  );
}

function statusMeta(plugin: PluginItem): { label: string; color: string; bg: string; border: string } {
  if (plugin.ready) {
    return {
      label: "已启用",
      color: "#059669",
      bg: "rgba(5, 150, 105, 0.12)",
      border: "rgba(5, 150, 105, 0.28)",
    };
  }
  if (plugin.installed && !plugin.enabled) {
    return {
      label: "已停用",
      color: "var(--aurora-fg3)",
      bg: "var(--aurora-chip)",
      border: "var(--aurora-border)",
    };
  }
  if (plugin.installed && !plugin.configured) {
    return {
      label: "待配置",
      color: "#D97706",
      bg: "rgba(217, 119, 6, 0.12)",
      border: "rgba(217, 119, 6, 0.30)",
    };
  }
  return {
    label: "未安装",
    color: "var(--aurora-fg3)",
    bg: "var(--aurora-chip)",
    border: "var(--aurora-border)",
  };
}

function buildInitialForm(plugin: PluginItem): Record<string, string | boolean> {
  const form: Record<string, string | boolean> = {};
  for (const f of plugin.fields) {
    if (f.type === "boolean") {
      form[f.key] = Boolean(plugin.config?.[f.key]);
    } else if (f.type === "secret") {
      form[f.key] = "";
    } else {
      form[f.key] = typeof plugin.config?.[f.key] === "string" ? (plugin.config[f.key] as string) : "";
    }
  }
  return form;
}

function PluginsContent() {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight") || "";

  const {
    plugins,
    serverCapabilities,
    loading,
    refreshPlugins,
    installPlugin,
    savePluginConfig,
    testPlugin,
    uninstallPlugin,
  } = usePlugins();

  const [filter, setFilter] = useState<FilterKey>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<Record<string, string | boolean>>({});
  const [enabledDraft, setEnabledDraft] = useState<boolean>(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<PluginTestResult | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const editingPlugin = useMemo(
    () => plugins.find((p) => p.id === editingId) || null,
    [plugins, editingId]
  );

  const openConfig = (plugin: PluginItem) => {
    setEditingId(plugin.id);
    setFormState(buildInitialForm(plugin));
    setEnabledDraft(plugin.installed ? plugin.enabled : true);
    setTestResult(null);
    setNotice(null);
  };

  useEffect(() => {
    if (!highlightId || plugins.length === 0) return;
    const found = plugins.find((p) => p.id === highlightId);
    if (found && editingId !== found.id) {
      openConfig(found);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, plugins.length]);

  const filteredPlugins = useMemo(() => {
    if (filter === "all") return plugins;
    if (filter === "installed") return plugins.filter((p) => p.installed);
    return plugins.filter((p) => p.category === filter);
  }, [plugins, filter]);

  const installedCount = useMemo(() => plugins.filter((p) => p.installed).length, [plugins]);
  const readyCount = useMemo(() => plugins.filter((p) => p.ready).length, [plugins]);

  const buildPayloadConfig = (plugin: PluginItem): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of plugin.fields) {
      const val = formState[f.key];
      if (f.type === "secret") {
        if (typeof val === "string" && val.trim()) {
          out[f.key] = val.trim();
        }
      } else {
        out[f.key] = val;
      }
    }
    return out;
  };

  const handleQuickInstall = async (plugin: PluginItem) => {
    setBusyId(plugin.id);
    setNotice(null);
    try {
      const res = await installPlugin(plugin.id);
      const updated = res.plugins.find((p) => p.id === plugin.id);
      if (updated) {
        openConfig(updated);
        if (updated.ready) {
          setNotice({ kind: "ok", text: `已安装并启用「${plugin.name}」，入口已即时生效。` });
        } else {
          setNotice({ kind: "ok", text: `已安装「${plugin.name}」，请填写服务地址并保存配置以启用。` });
        }
      }
    } catch (e: unknown) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "安装失败" });
    } finally {
      setBusyId(null);
    }
  };

  const handleSave = async () => {
    if (!editingPlugin) return;
    setBusyId(editingPlugin.id);
    setNotice(null);
    try {
      const cfg = buildPayloadConfig(editingPlugin);
      const res = editingPlugin.installed
        ? await savePluginConfig(editingPlugin.id, { config: cfg, enabled: enabledDraft })
        : await installPlugin(editingPlugin.id, cfg, enabledDraft);
      const updated = res.plugins.find((p) => p.id === editingPlugin.id);
      if (updated) {
        setFormState(buildInitialForm(updated));
        setEnabledDraft(updated.enabled);
        setNotice({
          kind: "ok",
          text: updated.ready
            ? `「${updated.name}」配置已保存并启用，相关功能入口已解锁。`
            : `「${updated.name}」配置已保存（当前状态：${statusMeta(updated).label}）。`,
        });
      }
    } catch (e: unknown) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "保存配置失败" });
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = async () => {
    if (!editingPlugin) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testPlugin(editingPlugin.id, buildPayloadConfig(editingPlugin));
      setTestResult(res);
    } catch (e: unknown) {
      setTestResult({
        ok: false,
        latency_ms: 0,
        message: e instanceof Error ? e.message : "连接测试失败",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleUninstall = async (plugin: PluginItem) => {
    setBusyId(plugin.id);
    setNotice(null);
    try {
      await uninstallPlugin(plugin.id);
      if (editingId === plugin.id) {
        setEditingId(null);
      }
      setNotice({ kind: "ok", text: `已卸载「${plugin.name}」，对应入口已从侧边栏与工作台移除。` });
    } catch (e: unknown) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "卸载失败" });
    } finally {
      setBusyId(null);
    }
  };

  const isFieldVisible = (plugin: PluginItem, field: PluginFieldSpec): boolean => {
    if (field.server_capability && !serverCapabilities[field.server_capability]) {
      return false;
    }
    if (plugin.id === "studio" && field.key !== "use_server_default" && formState.use_server_default === true) {
      return false;
    }
    return true;
  };

  return (
    <div className="max-w-5xl mx-auto pb-24 sm:pb-16">
      <TopBar
        title="插件市场"
        subtitle="按需安装并配置扩展服务；未安装的插件不会占用导航与工作台入口，确保自部署环境清爽独立"
        right={
          <Btn
            variant="glass"
            size="sm"
            icon="refresh"
            onClick={() => void refreshPlugins()}
            disabled={loading}
          >
            刷新状态
          </Btn>
        }
      />

      {/* Filter & Summary Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div
          className="inline-flex items-center gap-1 p-1 rounded-xl overflow-x-auto max-w-full"
          style={{
            background: "var(--aurora-surface)",
            border: "1px solid var(--aurora-border)",
          }}
        >
          {(
            [
              { id: "all", label: `全部插件 (${plugins.length})` },
              { id: "installed", label: `已安装 (${installedCount})` },
              { id: "创作生产", label: "创作生产" },
              { id: "内容分发", label: "内容分发" },
            ] as { id: FilterKey; label: string }[]
          ).map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer"
                style={{
                  background: active ? "var(--aurora-accent)" : "transparent",
                  color: active ? "#FFFFFF" : "var(--aurora-fg2)",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--aurora-fg3)]">
          <Chip tone={readyCount > 0 ? "accent" : "neutral"}>已启用 {readyCount} 项</Chip>
        </div>
      </div>

      {notice && (
        <div
          className="mb-5 px-4 py-3 rounded-xl text-xs sm:text-sm flex items-center justify-between gap-3"
          style={{
            background: notice.kind === "ok" ? "rgba(5, 150, 105, 0.10)" : "rgba(220, 38, 38, 0.10)",
            border: `1px solid ${notice.kind === "ok" ? "rgba(5, 150, 105, 0.28)" : "rgba(220, 38, 38, 0.28)"}`,
            color: notice.kind === "ok" ? "#059669" : "#DC2626",
          }}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-current opacity-70 hover:opacity-100 cursor-pointer shrink-0"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* Plugin Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredPlugins.map((plugin) => {
          const st = statusMeta(plugin);
          const isEditing = editingId === plugin.id;
          const iconName = (plugin.icon as Parameters<typeof Icon>[0]["name"]) || "box";
          return (
            <Glass
              key={plugin.id}
              className="p-5 flex flex-col justify-between gap-4 transition-colors"
              style={{
                borderColor: isEditing ? "var(--aurora-accent)" : undefined,
              }}
            >
              <div>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                      style={{
                        background: "var(--aurora-accent-soft)",
                        color: "var(--aurora-accent)",
                        border: "1px solid var(--aurora-border)",
                      }}
                    >
                      <Icon name={iconName} size={20} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-[15px] font-semibold text-[var(--aurora-fg1)] truncate">
                          {plugin.name}
                        </h3>
                        <span className="text-[11px] font-mono text-[var(--aurora-fg4)]">
                          v{plugin.version}
                        </span>
                      </div>
                      <span className="text-[11.5px] text-[var(--aurora-fg3)]">
                        {plugin.category}
                      </span>
                    </div>
                  </div>

                  <span
                    className="text-[11px] font-medium px-2.5 py-0.5 rounded-full shrink-0"
                    style={{
                      color: st.color,
                      background: st.bg,
                      border: `1px solid ${st.border}`,
                    }}
                  >
                    {st.label}
                  </span>
                </div>

                <p className="text-[13px] leading-relaxed text-[var(--aurora-fg2)] mb-3">
                  {plugin.summary}
                </p>

                <ul className="space-y-1.5 text-[12px] text-[var(--aurora-fg3)]">
                  {plugin.highlights.map((hl, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span
                        className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: "var(--aurora-accent)" }}
                      />
                      <span>{hl}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pt-3 border-t border-[var(--aurora-border)] flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  {!plugin.installed ? (
                    <Btn
                      size="sm"
                      icon="plus"
                      disabled={busyId === plugin.id}
                      onClick={() => void handleQuickInstall(plugin)}
                    >
                      {busyId === plugin.id ? "安装中..." : "安装插件"}
                    </Btn>
                  ) : (
                    <>
                      <Btn
                        size="sm"
                        variant={isEditing ? "primary" : "glass"}
                        icon="settings"
                        onClick={() => openConfig(plugin)}
                      >
                        {plugin.configured ? "管理配置" : "立即配置"}
                      </Btn>
                      {plugin.ready && plugin.entry_route && (
                        <Link href={plugin.entry_route} style={{ textDecoration: "none" }}>
                          <Btn size="sm" variant="primary" icon="arrow_right">
                            打开使用
                          </Btn>
                        </Link>
                      )}
                    </>
                  )}
                </div>

                {plugin.installed && (
                  <button
                    type="button"
                    disabled={busyId === plugin.id}
                    onClick={() => void handleUninstall(plugin)}
                    className="text-xs px-2.5 py-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                  >
                    卸载
                  </button>
                )}
              </div>
            </Glass>
          );
        })}
      </div>

      {/* Inline Configuration Panel */}
      {editingPlugin && (
        <Glass className="mt-6 p-5 sm:p-6" style={{ borderColor: "var(--aurora-accent)" }}>
          <div className="flex items-start justify-between gap-3 pb-4 mb-5 border-b border-[var(--aurora-border)]">
            <div>
              <h2 className="text-base font-semibold text-[var(--aurora-fg1)]">
                配置插件 · {editingPlugin.name}
              </h2>
              <p className="text-xs text-[var(--aurora-fg3)] mt-1">
                所有凭据与令牌均在服务端使用 Fernet 加密存储，不会明文返回或同步给其他用户。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] cursor-pointer"
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="space-y-4">
            {/* Enable toggle */}
            <label className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] cursor-pointer">
              <div>
                <div className="text-sm font-medium text-[var(--aurora-fg1)]">启用该插件</div>
                <div className="text-xs text-[var(--aurora-fg3)] mt-0.5">
                  停用后保留配置不丢失，但会暂时隐藏侧边栏与工作台入口。
                </div>
              </div>
              <input
                type="checkbox"
                checked={enabledDraft}
                onChange={(e) => setEnabledDraft(e.target.checked)}
                className="w-4 h-4 accent-[var(--aurora-accent)] cursor-pointer"
              />
            </label>

            {editingPlugin.fields.map((field) => {
              if (!isFieldVisible(editingPlugin, field)) return null;
              if (field.type === "boolean") {
                return (
                  <label
                    key={field.key}
                    className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-[var(--aurora-border)] bg-[var(--aurora-surface-solid)] cursor-pointer"
                  >
                    <div>
                      <div className="text-sm font-medium text-[var(--aurora-fg1)]">{field.label}</div>
                      {field.help && (
                        <div className="text-xs text-[var(--aurora-fg3)] mt-0.5">{field.help}</div>
                      )}
                    </div>
                    <input
                      type="checkbox"
                      checked={Boolean(formState[field.key])}
                      onChange={(e) =>
                        setFormState((prev) => ({ ...prev, [field.key]: e.target.checked }))
                      }
                      className="mt-1 w-4 h-4 accent-[var(--aurora-accent)] cursor-pointer shrink-0"
                    />
                  </label>
                );
              }

              const hasSavedSecret =
                field.type === "secret" && Boolean(editingPlugin.config?.[`has_${field.key}`]);
              const maskedSecret =
                field.type === "secret" && typeof editingPlugin.config?.[`${field.key}_masked`] === "string"
                  ? (editingPlugin.config[`${field.key}_masked`] as string)
                  : "";

              return (
                <div key={field.key} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-[var(--aurora-fg1)]">
                      {field.label}
                      {field.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    {hasSavedSecret && (
                      <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                        已加密保存 ({maskedSecret})
                      </span>
                    )}
                  </div>
                  <input
                    type={field.type === "secret" ? "password" : "text"}
                    value={typeof formState[field.key] === "string" ? (formState[field.key] as string) : ""}
                    onChange={(e) =>
                      setFormState((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={
                      hasSavedSecret
                        ? "留空保持现有加密密钥不变，输入新值将覆盖"
                        : field.placeholder || ""
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl text-sm border border-[var(--aurora-border-strong)] bg-[var(--aurora-surface-solid)] text-[var(--aurora-fg1)] outline-none focus:border-[var(--aurora-accent)]"
                  />
                  {field.help && (
                    <p className="text-[11.5px] text-[var(--aurora-fg3)]">{field.help}</p>
                  )}
                </div>
              );
            })}

            {testResult && (
              <div
                className="px-3.5 py-2.5 rounded-xl text-xs flex items-center gap-2"
                style={{
                  background: testResult.ok ? "rgba(5, 150, 105, 0.10)" : "rgba(220, 38, 38, 0.10)",
                  border: `1px solid ${testResult.ok ? "rgba(5, 150, 105, 0.28)" : "rgba(220, 38, 38, 0.28)"}`,
                  color: testResult.ok ? "#059669" : "#DC2626",
                }}
              >
                <Icon name={testResult.ok ? "check" : "alert"} size={14} />
                <span>{testResult.message}</span>
              </div>
            )}

            <div className="pt-3 border-t border-[var(--aurora-border)] flex items-center justify-between gap-3 flex-wrap">
              <Btn
                variant="glass"
                size="sm"
                icon="activity"
                disabled={testing || busyId === editingPlugin.id}
                onClick={() => void handleTest()}
              >
                {testing ? "测试中..." : "测试连接"}
              </Btn>

              <div className="flex items-center gap-2">
                <Btn variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                  取消
                </Btn>
                <Btn
                  size="sm"
                  icon="check"
                  disabled={busyId === editingPlugin.id}
                  onClick={() => void handleSave()}
                >
                  {busyId === editingPlugin.id ? "保存中..." : "保存配置"}
                </Btn>
              </div>
            </div>
          </div>
        </Glass>
      )}
    </div>
  );
}
