"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FiZoomIn,
  FiZoomOut,
  FiRotateCw,
  FiDownload,
  FiX,
  FiChevronLeft,
  FiChevronRight,
  FiMaximize2,
} from "react-icons/fi";
import { resolveMediaUrl, safeDecodePath, getFilenameFromUrl } from "./MediaPreview";
import { showInAppToast } from "@/lib/native-notify";

export interface ImageViewerItem {
  src: string;
  alt?: string;
  title?: string;
}

export interface ImageViewerModalProps {
  images: Array<ImageViewerItem | string>;
  initialIndex?: number;
  isOpen: boolean;
  onClose: () => void;
}

export function ImageViewerModal({
  images,
  initialIndex = 0,
  isOpen,
  onClose,
}: ImageViewerModalProps) {
  const [mounted, setMounted] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // Dragging and touch tracking
  const dragStartRef = useRef<{ x: number; y: number; startPanX: number; startPanY: number }>({
    x: 0,
    y: 0,
    startPanX: 0,
    startPanY: 0,
  });
  const touchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
    dist: number;
    initialZoom: number;
  }>({ x: 0, y: 0, time: 0, dist: 0, initialZoom: 1 });
  const lastTapRef = useRef<number>(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync index when initialIndex changes or modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.max(0, Math.min(initialIndex, images.length - 1)));
      setZoom(1);
      setRotation(0);
      setPan({ x: 0, y: 0 });
    }
  }, [isOpen, initialIndex, images.length]);

  // Lock body scroll when modal is active
  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  // Normalize image objects
  const normalizedList = useMemo(() => {
    return images.map((item) => {
      if (typeof item === "string") {
        const resolved = resolveMediaUrl(item);
        const name = getFilenameFromUrl(item);
        return {
          src: resolved.playUrl || item,
          downloadUrl: resolved.downloadUrl || resolved.playUrl || item,
          title: name,
          alt: name,
        };
      }
      const resolved = resolveMediaUrl(item.src);
      const name = item.title || item.alt || getFilenameFromUrl(item.src);
      return {
        src: resolved.playUrl || item.src,
        downloadUrl: resolved.downloadUrl || resolved.playUrl || item.src,
        title: name,
        alt: item.alt || name,
      };
    });
  }, [images]);

  const currentItem = normalizedList[currentIndex] || normalizedList[0];

  const resetTransform = useCallback(() => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  }, []);

  const handlePrev = useCallback(() => {
    if (normalizedList.length <= 1) return;
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : normalizedList.length - 1));
    resetTransform();
  }, [normalizedList.length, resetTransform]);

  const handleNext = useCallback(() => {
    if (normalizedList.length <= 1) return;
    setCurrentIndex((prev) => (prev < normalizedList.length - 1 ? prev + 1 : 0));
    resetTransform();
  }, [normalizedList.length, resetTransform]);

  // Keyboard controls
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft") {
        handlePrev();
      } else if (e.key === "ArrowRight") {
        handleNext();
      } else if (e.key === "+" || e.key === "=") {
        setZoom((z) => Math.min(5, Number((z + 0.25).toFixed(2))));
      } else if (e.key === "-" || e.key === "_") {
        setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
      } else if (e.key === "0" || e.key.toLowerCase() === "r") {
        resetTransform();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, handlePrev, handleNext, resetTransform]);

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const delta = -e.deltaY;
    setZoom((prev) => {
      const step = delta > 0 ? 0.2 : -0.2;
      const next = Math.max(0.5, Math.min(5, Number((prev + step).toFixed(2))));
      return next;
    });
  };

  // Mouse drag to pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only primary button
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({
      x: dragStartRef.current.startPanX + dx,
      y: dragStartRef.current.startPanY + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Double click / tap toggle zoom
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (zoom > 1) {
      resetTransform();
    } else {
      setZoom(2.2);
    }
  };

  // Touch handlers for mobile pinch-to-zoom & swipe
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch start
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      touchStartRef.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        time: Date.now(),
        dist,
        initialZoom: zoom,
      };
    } else if (e.touches.length === 1) {
      const touch = e.touches[0];
      const now = Date.now();
      const timeDelta = now - lastTapRef.current;
      if (timeDelta < 300) {
        // Double tap!
        if (zoom > 1) {
          resetTransform();
        } else {
          setZoom(2.2);
        }
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;

      dragStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
      };
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: now,
        dist: 0,
        initialZoom: zoom,
      };
      setIsDragging(true);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinching
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (touchStartRef.current.dist > 0) {
        const scale = dist / touchStartRef.current.dist;
        const nextZoom = Math.max(0.6, Math.min(5, touchStartRef.current.initialZoom * scale));
        setZoom(Number(nextZoom.toFixed(2)));
      }
    } else if (e.touches.length === 1 && isDragging) {
      const touch = e.touches[0];
      const dx = touch.clientX - dragStartRef.current.x;
      const dy = touch.clientY - dragStartRef.current.y;
      if (zoom > 1) {
        setPan({
          x: dragStartRef.current.startPanX + dx,
          y: dragStartRef.current.startPanY + dy,
        });
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isDragging && e.changedTouches.length === 1 && zoom === 1) {
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dt = Date.now() - touchStartRef.current.time;
      // Quick swipe gesture to switch images
      if (dt < 400 && Math.abs(dx) > 50 && normalizedList.length > 1) {
        if (dx > 0) {
          handlePrev();
        } else {
          handleNext();
        }
      }
    }
    setIsDragging(false);
  };

  // Safe file download handler
  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentItem) return;
    try {
      const filename = currentItem.title || "image.png";
      const res = await fetch(currentItem.downloadUrl || currentItem.src);
      if (!res.ok) throw new Error("Network response error");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      showInAppToast("已下载原图", filename);
    } catch {
      // Fallback: direct download link opening
      window.open(currentItem.downloadUrl || currentItem.src, "_blank");
    }
  };

  if (!mounted || !isOpen || normalizedList.length === 0 || !currentItem) {
    return null;
  }

  const modalContent = (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/92 backdrop-blur-2xl select-none animate-in fade-in duration-200"
      onClick={onClose}
      onWheel={handleWheel}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Top Floating Control Bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute top-3 sm:top-5 inset-x-3 sm:inset-x-6 flex items-center justify-between z-20 pointer-events-auto"
      >
        {/* Left: Title & Index Badge */}
        <div className="flex items-center gap-2.5 max-w-[60%] sm:max-w-md bg-white/10 hover:bg-white/15 backdrop-blur-xl border border-white/15 px-3 py-1.5 rounded-2xl shadow-lg transition-colors">
          {normalizedList.length > 1 && (
            <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-full bg-[var(--aurora-accent)] text-white shrink-0 shadow-xs">
              {currentIndex + 1} / {normalizedList.length}
            </span>
          )}
          <span
            className="text-xs sm:text-sm font-medium text-white/95 truncate tracking-wide"
            title={currentItem.title}
          >
            {currentItem.title}
          </span>
        </div>

        {/* Right: Actions (Zoom In, Zoom Out, 1:1 Reset, Rotate, Download, Close) */}
        <div className="flex items-center gap-1 sm:gap-1.5 bg-black/50 backdrop-blur-xl border border-white/15 p-1 sm:p-1.5 rounded-2xl shadow-2xl">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(5, Number((z + 0.25).toFixed(2))))}
            className="p-1.5 sm:p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/15 transition-all active:scale-95"
            title="放大 (+)"
          >
            <FiZoomIn className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            className="p-1.5 sm:p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/15 transition-all active:scale-95"
            title="缩小 (-)"
          >
            <FiZoomOut className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
          </button>
          <button
            type="button"
            onClick={resetTransform}
            className="p-1.5 sm:p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/15 transition-all active:scale-95"
            title="1:1 原图复位 (0 / R)"
          >
            <FiMaximize2 className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
          </button>
          <button
            type="button"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="p-1.5 sm:p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/15 transition-all active:scale-95"
            title="顺时针旋转 90°"
          >
            <FiRotateCw className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="p-1.5 sm:p-2 rounded-xl text-white/80 hover:text-white hover:bg-white/15 transition-all active:scale-95"
            title="下载原图"
          >
            <FiDownload className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
          </button>
          <div className="w-px h-4 bg-white/20 mx-0.5" />
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 sm:p-2 rounded-xl text-white/90 hover:text-white hover:bg-red-500/80 transition-all active:scale-95"
            title="关闭 (Esc)"
          >
            <FiX className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
          </button>
        </div>
      </div>

      {/* Left Navigation Arrow */}
      {normalizedList.length > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handlePrev();
          }}
          className="absolute left-2 sm:left-6 z-20 p-2 sm:p-3 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 text-white/90 hover:text-white backdrop-blur-xl transition-all active:scale-90 shadow-xl"
          title="上一张 (←)"
        >
          <FiChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />
        </button>
      )}

      {/* Right Navigation Arrow */}
      {normalizedList.length > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleNext();
          }}
          className="absolute right-2 sm:right-6 z-20 p-2 sm:p-3 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 text-white/90 hover:text-white backdrop-blur-xl transition-all active:scale-90 shadow-xl"
          title="下一张 (→)"
        >
          <FiChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />
        </button>
      )}

      {/* Center Image Container */}
      <div
        className="relative w-full h-full flex items-center justify-center overflow-hidden p-4 sm:p-12"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "zoom-out",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={currentItem.src}
          src={currentItem.src}
          alt={currentItem.alt || currentItem.title}
          draggable={false}
          onDoubleClick={handleDoubleClick}
          onClick={(e) => {
            // If zoomed in, don't trigger background close when clicking on the image
            e.stopPropagation();
          }}
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
            transition: isDragging ? "none" : "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
            maxHeight: "88vh",
            maxWidth: "90vw",
          }}
          className="object-contain rounded-xl shadow-2xl select-none will-change-transform"
        />
      </div>

      {/* Bottom Thumbnail Strip (Only when multiple images exist) */}
      {normalizedList.length > 1 && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-4 inset-x-0 flex justify-center z-20 pointer-events-none"
        >
          <div className="flex items-center gap-2 max-w-[92vw] overflow-x-auto py-1.5 px-3 rounded-2xl bg-black/60 backdrop-blur-xl border border-white/15 shadow-2xl pointer-events-auto scrollbar-none">
            {normalizedList.map((item, idx) => {
              const isActive = idx === currentIndex;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setCurrentIndex(idx);
                    resetTransform();
                  }}
                  className={`relative w-11 h-11 sm:w-13 sm:h-13 rounded-xl overflow-hidden border-2 transition-all shrink-0 ${
                    isActive
                      ? "border-[var(--aurora-accent)] ring-2 ring-[var(--aurora-accent)]/50 scale-105 opacity-100"
                      : "border-transparent opacity-50 hover:opacity-85 hover:border-white/30"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.src}
                    alt={`Thumbnail ${idx + 1}`}
                    className="w-full h-full object-cover"
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(modalContent, document.body);
}
