import type { Turn } from "@/lib/ask/turns";

export interface ExportMarkdownOptions {
  title: string;
  executionMode: string;
  selectedDevice?: string | null;
  exportedAt?: string;
}

/** Build a clean Markdown report from conversation turns for download or sharing. */
export function buildConversationMarkdown(turns: readonly Turn[], opts: ExportMarkdownOptions): string {
  const lines: string[] = [
    `# ${opts.title}`,
    `> 导出时间: ${opts.exportedAt || new Date().toLocaleString()} | 模式: ${opts.executionMode} | 设备: ${opts.selectedDevice || "auto"} | 总轮次: ${turns.length}`,
    "",
    "---",
    "",
  ];

  turns.forEach((t, i) => {
    if (t.role === "user") {
      lines.push(`### 用户提问 #${Math.floor(i / 2) + 1}`);
      lines.push("");
      lines.push(t.content || "");
      if (t.images && t.images.length > 0) {
        lines.push(`\n*(包含 ${t.images.length} 张图片附件)*`);
      }
      lines.push("");
    } else {
      const modelLabel = t.model
        ? ` [${t.model}]`
        : t.execution_mode && t.execution_mode !== "ai"
          ? ` [${t.execution_mode}]`
          : "";
      const durLabel = t.duration_ms ? ` (${(t.duration_ms / 1000).toFixed(1)}s)` : "";
      lines.push(`### AI 执事回复 #${Math.floor(i / 2) + 1}${modelLabel}${durLabel}`);
      lines.push("");
      if (t.thinking && t.thinking.trim()) {
        lines.push(`<details><summary>思考过程 (${t.thinking.trim().length} 字)</summary>\n`);
        lines.push(t.thinking.trim());
        lines.push("\n</details>\n");
      }
      if (t.toolCalls && t.toolCalls.length > 0) {
        lines.push("#### 设备执行记录");
        t.toolCalls.forEach((call, cidx) => {
          const cmd = (call.args?.command as string) || (call.args?.prompt as string) || call.name;
          lines.push(`- **步骤 ${cidx + 1}**: \`${call.name}\` (${call.device_name || "auto"})`);
          if (cmd) {
            lines.push("  ```bash");
            lines.push(`  ${cmd}`);
            lines.push("  ```");
          }
          if (call.result?.stdout) {
            lines.push("  <details><summary>点击查看终端输出</summary>\n");
            lines.push("  ```text");
            lines.push(call.result.stdout.slice(0, 4000));
            lines.push("  ```\n  </details>");
          }
        });
        lines.push("");
      }
      lines.push("#### 总结与分析");
      lines.push("");
      lines.push(t.content || "任务执行完成。");
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  });

  return lines.join("\n");
}

/** Trigger browser file download of a conversation Markdown export. */
export function downloadConversationMarkdown(turns: readonly Turn[], opts: ExportMarkdownOptions): void {
  const mdContent = buildConversationMarkdown(turns, opts);
  const dateStr = new Date().toISOString().slice(0, 10);
  const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const cleanFileName = opts.title.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 40) || "memento-export";
  a.download = `${cleanFileName}-${dateStr}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
