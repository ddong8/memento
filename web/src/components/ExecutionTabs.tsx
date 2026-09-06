"use client";

import { useState } from "react";
import { Icon } from "./aurora/Icon";
import ExecutionCard, { ToolCallItem } from "./ExecutionCard";
import { useI18n } from "@/lib/i18n";

export interface ExecutionTabsProps {
  calls: ToolCallItem[];
}

function getDeviceIcon(name: string, isSystem = false): Parameters<typeof Icon>[0]["name"] {
  if (isSystem) return "layers";
  const lower = name.toLowerCase();
  if (lower.includes("mac") || lower.includes("apple") || lower.includes("darwin")) return "apple";
  if (lower.includes("win") || lower.includes("pc")) return "windows";
  if (lower.includes("linux") || lower.includes("ubuntu") || lower.includes("debian")) return "linux";
  return "devices";
}

function isCallRunning(call: ToolCallItem): boolean {
  return (
    !call.result ||
    call.result.status === "running" ||
    call.result.status === "queued" ||
    call.result.status === "still_running"
  );
}

function isCallFailed(call: ToolCallItem): boolean {
  if (isCallRunning(call)) return false;
  const command = (call.args?.command as string) || (call.args?.prompt as string) || "";
  const isMatchFilter = Boolean(command && /(grep|findstr|lsof|pgrep|which)\b/i.test(command));
  const isExit1NoMatch = Boolean(
    call.result?.exit_code === 1 && isMatchFilter && (!call.result.stderr || call.result.stderr.trim().length === 0)
  );
  return Boolean(
    !isExit1NoMatch &&
    (call.result?.status === "failed" ||
      (call.result && typeof call.result.exit_code === "number" && call.result.exit_code !== 0))
  );
}

function isCallSuccess(call: ToolCallItem): boolean {
  if (isCallRunning(call)) return false;
  const command = (call.args?.command as string) || (call.args?.prompt as string) || "";
  const isMatchFilter = Boolean(command && /(grep|findstr|lsof|pgrep|which)\b/i.test(command));
  const isExit1NoMatch = Boolean(
    call.result?.exit_code === 1 && isMatchFilter && (!call.result.stderr || call.result.stderr.trim().length === 0)
  );
  return Boolean(
    call.result?.status === "succeeded" ||
    isExit1NoMatch ||
    (Boolean(call.result) && call.result?.exit_code === 0 && !call.result?.error)
  );
}

function getCallKey(call: ToolCallItem): string {
  if (call.name === "list_devices") {
    return "__list_devices__";
  }
  const name = call.result?.device_name || call.device_name;
  if (name) return name.toLowerCase().trim();
  return ((call.result?.device_id || call.args?.device_id || "device") as string).toLowerCase().trim();
}

function getCallLabel(call: ToolCallItem, defaultLabel: string, discoveryLabel: string): string {
  if (call.name === "list_devices") {
    return discoveryLabel;
  }
  return call.result?.device_name || call.device_name || (call.args?.device_id as string) || defaultLabel;
}

export default function ExecutionTabs({ calls }: ExecutionTabsProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<string>("all");

  if (!calls || calls.length === 0) return null;

  const defaultLabel = t.ask.unknownDevice || "设备";
  const discoveryLabel = t.ask.deviceDiscovery || "设备发现";

  // Group calls by unique device key
  const groupMap = new Map<string, { key: string; name: string; isSystem: boolean; calls: ToolCallItem[] }>();

  for (const call of calls) {
    const key = getCallKey(call);
    const name = getCallLabel(call, defaultLabel, discoveryLabel);
    const isSystem = call.name === "list_devices";
    if (!groupMap.has(key)) {
      groupMap.set(key, { key, name, isSystem, calls: [] });
    }
    const group = groupMap.get(key)!;
    if (call.result?.device_name && group.name !== call.result.device_name) {
      group.name = call.result.device_name;
    }
    group.calls.push(call);
  }

  const groups = Array.from(groupMap.values());

  // If only 1 device/group, render directly without extra tab overhead
  if (groups.length <= 1) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {calls.map((call, idx) => (
          <ExecutionCard key={call.id || idx} call={call} />
        ))}
      </div>
    );
  }

  const allTab = {
    key: "all",
    name: t.ask.allDevices || "全部",
    icon: "layers" as const,
    count: calls.length,
    isRunning: calls.some(isCallRunning),
    isFailed: calls.some(isCallFailed),
    isSuccess: calls.every(isCallSuccess),
  };

  const deviceTabs = groups.map((g) => ({
    key: g.key,
    name: g.name,
    icon: getDeviceIcon(g.name, g.isSystem),
    count: g.calls.length,
    isRunning: g.calls.some(isCallRunning),
    isFailed: g.calls.some(isCallFailed),
    isSuccess: g.calls.every(isCallSuccess),
  }));

  const tabs = [allTab, ...deviceTabs];
  const selectedTab = tabs.some((tb) => tb.key === activeTab) ? activeTab : "all";

  return (
    <div style={{ margin: "10px 0" }}>
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px",
          background: "rgba(15, 23, 42, 0.55)",
          backdropFilter: "blur(12px)",
          borderRadius: 12,
          border: "1px solid var(--aurora-border, rgba(255, 255, 255, 0.08))",
          marginBottom: 10,
          overflowX: "auto",
          scrollbarWidth: "none",
        }}
      >
        {tabs.map((tb) => {
          const isActive = selectedTab === tb.key;
          return (
            <button
              key={tb.key}
              type="button"
              onClick={() => setActiveTab(tb.key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: isActive ? 600 : 500,
                borderRadius: 8,
                border: "1px solid",
                borderColor: isActive ? "rgba(56, 189, 248, 0.4)" : "transparent",
                background: isActive ? "rgba(56, 189, 248, 0.16)" : "transparent",
                color: isActive ? "var(--aurora-accent, #38bdf8)" : "var(--aurora-fg3, #94a3b8)",
                cursor: "pointer",
                transition: "all 0.15s ease",
                whiteSpace: "nowrap",
                userSelect: "none",
              }}
            >
              <Icon
                name={tb.icon}
                size={13}
                style={{
                  color: isActive ? "var(--aurora-accent, #38bdf8)" : "inherit",
                }}
              />
              <span>{tb.name}</span>
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 9999,
                  background: isActive
                    ? "rgba(56, 189, 248, 0.25)"
                    : "rgba(255, 255, 255, 0.08)",
                  color: isActive
                    ? "var(--aurora-accent, #38bdf8)"
                    : "var(--aurora-fg4, #64748b)",
                  fontWeight: 600,
                }}
              >
                {tb.count}
              </span>

              {/* Status indicator badge */}
              {tb.isRunning ? (
                <span
                  title={t.ask.statusStreaming || "运行中"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 12,
                    height: 12,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#38bdf8",
                      boxShadow: "0 0 8px #38bdf8",
                      animation: "pulse 1.2s infinite",
                    }}
                  />
                </span>
              ) : tb.isFailed ? (
                <span
                  title={t.ask.statusFailed || "失败"}
                  style={{
                    color: "#ef4444",
                    fontSize: 11,
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </span>
              ) : tb.isSuccess ? (
                <span
                  title={t.ask.statusSucceeded || "完成"}
                  style={{
                    color: "#10b981",
                    fontSize: 11,
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Execution cards container */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {calls.map((call, idx) => {
          const callKey = getCallKey(call);
          const isVisible = selectedTab === "all" || callKey === selectedTab;
          return (
            <div
              key={call.id || idx}
              style={{
                display: isVisible ? "block" : "none",
              }}
            >
              <ExecutionCard call={call} isVisible={isVisible} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { ExecutionTabs };
