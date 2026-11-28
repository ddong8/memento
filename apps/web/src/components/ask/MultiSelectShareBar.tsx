"use client";

import { memo } from "react";
import { Btn } from "@/components/aurora/primitives";

export interface MultiSelectShareBarProps {
  isZh: boolean;
  selectedCount: number;
  totalCount: number;
  onToggleSelectAll: () => void;
  onShareSelected: () => void;
  onCancel: () => void;
}

export const MultiSelectShareBar = memo(function MultiSelectShareBar({
  isZh,
  selectedCount,
  totalCount,
  onToggleSelectAll,
  onShareSelected,
  onCancel,
}: MultiSelectShareBarProps) {
  const allSelected = selectedCount === totalCount && totalCount > 0;

  return (
    <div className="shrink-0 px-3 sm:px-6 py-2.5 bg-[var(--aurora-surface-solid)]/95 backdrop-blur-md border-t border-[var(--aurora-accent)]/30 shadow-2xl flex items-center justify-between gap-3 z-30 flex-wrap">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-[var(--aurora-fg1)] flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[var(--aurora-accent)]" />
          <span>
            {isZh ? `已选择 ${selectedCount} 条消息` : `${selectedCount} messages selected`}
          </span>
        </span>
        <button
          type="button"
          onClick={onToggleSelectAll}
          className="text-xs text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] underline cursor-pointer"
        >
          {allSelected
            ? isZh
              ? "取消全选"
              : "Deselect all"
            : isZh
              ? "全选"
              : "Select all"}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Btn
          variant="primary"
          size="sm"
          icon="share"
          disabled={selectedCount === 0}
          onClick={onShareSelected}
        >
          {isZh ? "分享所选问答 ↗" : "Share selected ↗"}
        </Btn>
        <Btn variant="glass" size="sm" onClick={onCancel}>
          {isZh ? "退出多选" : "Cancel"}
        </Btn>
      </div>
    </div>
  );
});
