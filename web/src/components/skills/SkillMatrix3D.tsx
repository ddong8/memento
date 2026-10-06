"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import * as THREE from "three";
import { Icon } from "@/components/aurora/Icon";

export interface SkillItem {
  id?: string;
  slug?: string;
  title?: string;
  description?: string;
  status?: string;
  version?: number;
  body?: string;
  results?: Record<string, unknown>;
}

interface SkillMatrix3DProps {
  skills: SkillItem[];
  selectedSlug?: string | null;
  onSelectSkill?: (skill: SkillItem | null) => void;
  isPanelCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onToggleFullscreen?: () => void;
  isPaused?: boolean;
  className?: string;
}

const TERMINAL_TARGETS = [
  { id: "claude_code", label: "Claude Code", color: 0xd97706, colorHex: "#D97706" },
  { id: "antigravity", label: "Antigravity", color: 0x3b82f6, colorHex: "#3B82F6" },
  { id: "codex", label: "Codex", color: 0x10b981, colorHex: "#10B981" },
  { id: "openclaw", label: "OpenClaw", color: 0x8b5cf6, colorHex: "#8B5CF6" },
  { id: "hermes", label: "Hermes", color: 0xec4899, colorHex: "#EC4899" },
];

/** Create crisp 3D text billboard sprite */
function createSkillTextSprite(title: string, version: number, isPublished: boolean): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(2, 2);
    ctx.clearRect(0, 0, 256, 64);
    // Background pill
    ctx.fillStyle = isPublished ? "rgba(16, 185, 129, 0.2)" : "rgba(245, 158, 11, 0.2)";
    ctx.beginPath();
    ctx.roundRect(8, 10, 240, 44, 22);
    ctx.fill();
    ctx.strokeStyle = isPublished ? "#10B981" : "#F59E0B";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text content
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 18px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const displayTitle = title.length > 11 ? title.slice(0, 10) + "…" : title;
    ctx.fillText(`${displayTitle} v${version}`, 128, 32);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(1.5, 0.38, 1);
  return sprite;
}

export default function SkillMatrix3D({
  skills,
  selectedSlug,
  onSelectSkill,
  isPanelCollapsed,
  onToggleCollapse,
  onToggleFullscreen,
  isPaused = false,
  className = "",
}: SkillMatrix3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredSkill, setHoveredSkill] = useState<SkillItem | null>(null);
  const [isRotating, setIsRotating] = useState(true);
  const [injectedTerminal, setInjectedTerminal] = useState<string | null>(null);

  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const onSelectSkillRef = useRef(onSelectSkill);
  onSelectSkillRef.current = onSelectSkill;

  const selectedSlugRef = useRef(selectedSlug);
  selectedSlugRef.current = selectedSlug;

  const resetCameraRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 460;

    // Detect mobile device for performance optimization
    const isMobile =
      typeof window !== "undefined" &&
      (window.innerWidth < 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent));

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060814, 0.04);

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 100);
    camera.position.set(0, 5.0, 11.0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // 2. Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const centerPointLight = new THREE.PointLight(0x8b5cf6, 3, 20);
    centerPointLight.position.set(0, 2, 0);
    scene.add(centerPointLight);

    const blueDirLight = new THREE.DirectionalLight(0x38bdf8, 1.2);
    blueDirLight.position.set(4, 10, 6);
    scene.add(blueDirLight);

    // 3. Central Holographic Platform Floor Grid
    const gridHelper = new THREE.GridHelper(12, 24, 0x8b5cf6, 0x1e293b);
    gridHelper.position.y = -0.05;
    scene.add(gridHelper);

    // Glowing Concentric Platform Rings
    const ringGeo = new THREE.RingGeometry(3.8, 3.86, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x8b5cf6,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
    });
    const platformRing = new THREE.Mesh(ringGeo, ringMat);
    platformRing.rotation.x = Math.PI / 2;
    scene.add(platformRing);

    // 4. 5 Terminal Energy Altars (环状 5 智能体底座)
    const terminalAltarGroup = new THREE.Group();
    scene.add(terminalAltarGroup);

    const altarPositions: THREE.Vector3[] = [];
    TERMINAL_TARGETS.forEach((target, idx) => {
      const angle = (idx / TERMINAL_TARGETS.length) * Math.PI * 2;
      const radius = 4.2;
      const pos = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      altarPositions.push(pos);

      // Altar Cylinder Base
      const altarGeo = new THREE.CylinderGeometry(0.55, 0.65, 0.25, 24);
      const altarMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.4,
        metalness: 0.8,
      });
      const altarMesh = new THREE.Mesh(altarGeo, altarMat);
      altarMesh.position.copy(pos);

      // Glowing Rim on Altar
      const rimGeo = new THREE.TorusGeometry(0.56, 0.03, 16, 32);
      const rimMat = new THREE.MeshBasicMaterial({ color: target.color });
      const rimMesh = new THREE.Mesh(rimGeo, rimMat);
      rimMesh.rotation.x = Math.PI / 2;
      rimMesh.position.y = 0.13;
      altarMesh.add(rimMesh);

      terminalAltarGroup.add(altarMesh);
    });

    // 5. Build 3D Skill Polyhedral Cores Matrix
    const skillRoot = new THREE.Group();
    scene.add(skillRoot);

    const skillMeshMap = new Map<string, THREE.Mesh>();
    const skillMeshList: THREE.Mesh[] = [];
    const skillList = skills.length > 0 ? skills : [
      { slug: "auto-update", title: "三位一体发版校验", version: 2, status: "published" },
      { slug: "code-review", title: "代码规范自检", version: 1, status: "published" },
      { slug: "health-monitor", title: "容器集群健康侦测", version: 1, status: "published" },
      { slug: "rag-sync", title: "跨会话上下文同步", version: 1, status: "draft" },
    ];

    const M = skillList.length;
    skillList.forEach((skill, idx) => {
      const angle = (idx / M) * Math.PI * 2;
      const radius = 2.2;
      const yOffset = 1.4 + Math.sin(idx * 1.5) * 0.4;
      const pos = new THREE.Vector3(Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius);

      const isPub = skill.status === "published";
      const coreColor = isPub ? 0x10b981 : 0xf59e0b;

      // Unique polyhedral geometries for skill cores
      let geo: THREE.BufferGeometry;
      if (idx % 3 === 0) {
        geo = new THREE.OctahedronGeometry(0.42);
      } else if (idx % 3 === 1) {
        geo = new THREE.DodecahedronGeometry(0.38);
      } else {
        geo = new THREE.IcosahedronGeometry(0.36);
      }

      const mat = new THREE.MeshStandardMaterial({
        color: coreColor,
        emissive: coreColor,
        emissiveIntensity: 0.55,
        roughness: 0.25,
        metalness: 0.75,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.userData = { skill, initialY: yOffset };

      // Sprite Label
      const sprite = createSkillTextSprite(
        skill.title || skill.slug || "未命名技能",
        skill.version || 1,
        isPub
      );
      sprite.position.set(0, 0.55, 0);
      mesh.add(sprite);

      skillRoot.add(mesh);
      skillMeshList.push(mesh);
      if (skill.slug) {
        skillMeshMap.set(skill.slug, mesh);
      }
    });

    // 6. Injection Energy Beams Line System
    const beamGeo = new THREE.BufferGeometry();
    const beamPositions = new Float32Array(TERMINAL_TARGETS.length * 6);
    beamGeo.setAttribute("position", new THREE.BufferAttribute(beamPositions, 3));
    const beamMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0,
      linewidth: 2,
    });
    const beamLines = new THREE.LineSegments(beamGeo, beamMat);
    scene.add(beamLines);

    // 7. Interactive Controls & Responsive Spherical Camera
    // 微俯视舞台视角（俯角约 22°），呈现极具纵深与科技层次感的立体星阵全景
    const DEFAULT_PHI = (68 * Math.PI) / 180;
    const DEFAULT_TARGET_Y = 0.95;

    const getOptimalRadius = (w: number, h: number) => {
      const aspect = w / h;
      // 默认全景半径：11.8（黄金折中尺寸，绝不显小，又具备充足周边留白）
      const baseRadius = 11.8;
      if (aspect >= 1.25) {
        return baseRadius;
      }
      // 竖屏与窄屏自适应：确保 5 端环形基座及中心技能多面体 100% 完整容纳且不贴边
      const fovRad = (44 * Math.PI) / 360;
      const requiredRadius = (5.1 * 1.28) / (Math.tan(fovRad) * Math.max(aspect, 0.32));
      return Math.max(baseRadius, Math.min(34, requiredRadius));
    };

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let isMouseActive = false;
    let prevMousePos = { x: 0, y: 0 };
    let userHasManuallyZoomed = false;
    let spherical = { radius: getOptimalRadius(width, height), theta: 0, phi: DEFAULT_PHI };
    let targetCameraTarget = new THREE.Vector3(0, DEFAULT_TARGET_Y, 0);
    const currentCameraTarget = new THREE.Vector3(0, DEFAULT_TARGET_Y, 0);

    const updateCameraFromSpherical = () => {
      camera.position.x =
        currentCameraTarget.x +
        spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
      camera.position.y =
        currentCameraTarget.y + spherical.radius * Math.cos(spherical.phi);
      camera.position.z =
        currentCameraTarget.z +
        spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
      camera.lookAt(currentCameraTarget);
    };

    updateCameraFromSpherical();

    // 绑定重置视角回调，供顶部按钮触发
    resetCameraRef.current = () => {
      userHasManuallyZoomed = false;
      targetCameraTarget.set(0, DEFAULT_TARGET_Y, 0);
      spherical.radius = getOptimalRadius(container.clientWidth || width, container.clientHeight || height);
      spherical.theta = 0;
      spherical.phi = DEFAULT_PHI;
      updateCameraFromSpherical();
    };

    container.style.touchAction = "none";

    let pointerDownPos = { x: 0, y: 0 };
    let initialPinchDist = 0;
    let initialPinchRadius = 0;

    const handlePointerDown = (e: MouseEvent) => {
      isDragging = true;
      prevMousePos = { x: e.clientX, y: e.clientY };
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const handlePointerUp = () => {
      isDragging = false;
    };

    const handlePointerMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      isMouseActive = true;

      if (isDragging) {
        const dx = e.clientX - prevMousePos.x;
        const dy = e.clientY - prevMousePos.y;
        prevMousePos = { x: e.clientX, y: e.clientY };

        spherical.theta -= dx * 0.007;
        spherical.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, spherical.phi - dy * 0.007));
        updateCameraFromSpherical();
      }
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      userHasManuallyZoomed = true;
      spherical.radius = Math.max(6, Math.min(42, spherical.radius + e.deltaY * 0.015));
      updateCameraFromSpherical();
    };

    const handleClick = (e: MouseEvent) => {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist > 6) return; // 过滤拖拽旋转操作

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(skillMeshList, false);

      if (intersects.length > 0) {
        const hit = intersects[0].object as THREE.Mesh;
        const skill = hit.userData.skill as SkillItem;
        if (skill && onSelectSkillRef.current) {
          onSelectSkillRef.current(skill);
          targetCameraTarget.set(hit.position.x, hit.position.y, hit.position.z);
          spherical.radius = 8.6;
        }
      }
    };

    // Touch Event Handlers for Mobile Devices
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDragging = true;
        const touch = e.touches[0];
        prevMousePos = { x: touch.clientX, y: touch.clientY };
        pointerDownPos = { x: touch.clientX, y: touch.clientY };

        const rect = container.getBoundingClientRect();
        mouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
      } else if (e.touches.length === 2) {
        isDragging = false;
        initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        initialPinchRadius = spherical.radius;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1 && isDragging) {
        const touch = e.touches[0];
        const dx = touch.clientX - prevMousePos.x;
        const dy = touch.clientY - prevMousePos.y;
        prevMousePos = { x: touch.clientX, y: touch.clientY };

        spherical.theta -= dx * 0.008;
        spherical.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, spherical.phi - dy * 0.008));
        updateCameraFromSpherical();

        const rect = container.getBoundingClientRect();
        mouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
      } else if (e.touches.length === 2 && initialPinchDist > 0) {
        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = initialPinchDist / (currentDist || 1);
        userHasManuallyZoomed = true;
        spherical.radius = Math.max(6, Math.min(42, initialPinchRadius * factor));
        updateCameraFromSpherical();
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        isDragging = false;
        initialPinchDist = 0;
        if (e.changedTouches.length === 1) {
          const touch = e.changedTouches[0];
          const dist = Math.hypot(touch.clientX - pointerDownPos.x, touch.clientY - pointerDownPos.y);
          if (dist < 8) {
            const rect = container.getBoundingClientRect();
            mouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObjects(skillMeshList, false);
            if (intersects.length > 0) {
              const hit = intersects[0].object as THREE.Mesh;
              const skill = hit.userData.skill as SkillItem;
              if (skill && onSelectSkillRef.current) {
                onSelectSkillRef.current(skill);
                targetCameraTarget.set(hit.position.x, hit.position.y, hit.position.z);
                spherical.radius = 8.6;
              }
            }
          }
        }
      } else if (e.touches.length === 1) {
        isDragging = true;
        const touch = e.touches[0];
        prevMousePos = { x: touch.clientX, y: touch.clientY };
      }
    };

    const handleDblClick = () => {
      if (onSelectSkillRef.current) {
        onSelectSkillRef.current(null);
      }
      resetCameraRef.current?.();
    };

    container.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("mouseup", handlePointerUp);
    container.addEventListener("mousemove", handlePointerMove);
    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("click", handleClick);
    container.addEventListener("dblclick", handleDblClick);
    container.addEventListener("touchstart", handleTouchStart, { passive: false });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd, { passive: false });

    // 8. Render Animation Loop (with Battery-Friendly Pause on Inactivity / Background / Offscreen)
    let animId = 0;
    const clock = new THREE.Clock();
    let isPageVisible = !document.hidden;
    let isElementIntersecting = true;

    const handleVisibilityChange = () => {
      isPageVisible = !document.hidden;
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    let intersectionObserver: IntersectionObserver | null = null;
    if (typeof window !== "undefined" && "IntersectionObserver" in window) {
      intersectionObserver = new IntersectionObserver(
        ([entry]) => {
          isElementIntersecting = entry.isIntersecting;
        },
        { threshold: 0.05 }
      );
      intersectionObserver.observe(container);
    }

    const animate = () => {
      animId = requestAnimationFrame(animate);

      // Stop GPU work when tab is in background, offscreen, or parent page asks to pause
      if (!isPageVisible || !isElementIntersecting || isPausedRef.current) return;

      const elapsed = clock.getElapsedTime();

      // Camera lerp
      currentCameraTarget.lerp(targetCameraTarget, 0.05);
      updateCameraFromSpherical();

      // Slow Scene Rotation
      if (isRotating && !isDragging) {
        skillRoot.rotation.y += 0.002;
        platformRing.rotation.z += 0.005;
      }

      // Skill Cores Floating & Self-Spin
      skillMeshMap.forEach((mesh, slug) => {
        mesh.rotation.x += 0.015;
        mesh.rotation.y += 0.02;
        mesh.position.y = mesh.userData.initialY + Math.sin(elapsed * 2 + mesh.position.x) * 0.08;

        const isSelected = selectedSlugRef.current === slug;
        const mat = mesh.material as THREE.MeshStandardMaterial;

        if (isSelected) {
          mesh.scale.setScalar(1.3 + Math.sin(elapsed * 5) * 0.1);
          mat.emissiveIntensity = 1.3;

          // Update Laser Beams to 5 Terminals
          const posAttr = beamGeo.getAttribute("position") as THREE.BufferAttribute;
          altarPositions.forEach((altarPos, aIdx) => {
            posAttr.setXYZ(aIdx * 2, mesh.position.x, mesh.position.y, mesh.position.z);
            posAttr.setXYZ(aIdx * 2 + 1, altarPos.x, altarPos.y + 0.2, altarPos.z);
          });
          posAttr.needsUpdate = true;
          beamMat.opacity = 0.65 + Math.sin(elapsed * 8) * 0.25;
        } else {
          mesh.scale.setScalar(1.0);
          mat.emissiveIntensity = 0.55;
        }
      });

      if (!selectedSlugRef.current) {
        beamMat.opacity = 0;
      }

      // Hover Raycasting (Desktop only & only on active mouse movement, saving mobile GPU)
      if (!isMobile && isMouseActive) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(skillMeshList, false);

        if (intersects.length > 0) {
          const hit = intersects[0].object as THREE.Mesh;
          const skill = hit.userData.skill as SkillItem;
          setHoveredSkill(skill);
          document.body.style.cursor = "pointer";
        } else {
          setHoveredSkill(null);
          document.body.style.cursor = "default";
        }
        isMouseActive = false;
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      if (!userHasManuallyZoomed && !selectedSlugRef.current) {
        spherical.radius = getOptimalRadius(newW, newH);
        updateCameraFromSpherical();
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(newW, newH);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      container.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("mouseup", handlePointerUp);
      container.removeEventListener("mousemove", handlePointerMove);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("click", handleClick);
      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      document.body.style.cursor = "default";
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      // Deep dispose geometries and materials to prevent WebGL memory leak
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) {
          (obj as THREE.Mesh).geometry.dispose();
        }
        if ((obj as THREE.Mesh).material) {
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) {
            mat.forEach((m) => m.dispose());
          } else {
            mat.dispose();
          }
        }
      });
      renderer.dispose();
    };
  }, [skills, isRotating]);

  return (
    <div
      className={`relative w-full h-full min-h-[340px] sm:min-h-[460px] rounded-3xl overflow-hidden select-none border border-[var(--aurora-border)] bg-[radial-gradient(ellipse_at_50%_0%,#181a32_0%,#090a16_60%,#04050a_100%)] shadow-2xl flex flex-col justify-between ${className}`}
    >
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} className="absolute inset-0 cursor-grab active:cursor-grabbing z-0 touch-none" />

      {/* Top Floating Holographic HUD: Unified Single-Row Controls & Metrics */}
      <div className="relative z-10 p-2 sm:p-3.5 flex items-center justify-between pointer-events-none gap-1 sm:gap-2 flex-nowrap overflow-hidden">
        {/* Left: Skill Matrix Badge & 5-End Link Indicator */}
        <div className="flex items-center gap-1 sm:gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 bg-black/65 backdrop-blur-xl px-2 sm:px-3 py-1 sm:py-1.5 rounded-full border border-white/10 shadow-lg pointer-events-auto shrink-0">
            <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-[#F59E0B] animate-pulse" />
            <span className="text-[11px] sm:text-xs font-bold text-white font-mono tracking-wide">
              <span className="sm:hidden">⚡ </span>
              <span className="hidden sm:inline">3D 科技树 · </span>
              {skills.length}
            </span>
          </div>

          <div className="flex items-center gap-1 bg-black/60 backdrop-blur-md px-2 py-0.5 sm:py-1 rounded-full border border-white/10 text-[9px] sm:text-[10px] font-mono text-white/80 pointer-events-auto shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] breathing-glow-emerald" />
            <span className="hidden sm:inline">5/5 端基座实时能量注入</span>
            <span className="sm:hidden">5端热注</span>
          </div>
        </div>

        {/* Right: Unified Action Controls (Never overlapping) */}
        <div className="flex items-center gap-1 sm:gap-1.5 pointer-events-auto shrink-0">
          <button
            onClick={() => setIsRotating((v) => !v)}
            className={`px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-mono font-medium transition-all backdrop-blur-md border flex items-center gap-1 ${
              isRotating
                ? "bg-[#3B82F6]/30 text-[#93C5FD] border-[#3B82F6]/50 shadow-xs"
                : "bg-black/50 text-white/70 border-white/10 hover:text-white"
            }`}
            title="切换科技树自转"
          >
            <span className="text-xs">🔄</span>
            <span className="hidden sm:inline">{isRotating ? "自转中" : "已暂停"}</span>
          </button>

          <button
            onClick={() => {
              if (onSelectSkillRef.current) {
                onSelectSkillRef.current(null);
              }
              resetCameraRef.current?.();
            }}
            className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-mono font-medium backdrop-blur-md border bg-black/50 text-white/70 border-white/10 hover:text-white flex items-center gap-1"
            title="重置技能对焦"
          >
            <span className="text-xs">🎯</span>
            <span className="hidden sm:inline">重置对焦</span>
          </button>

          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-mono font-semibold bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 text-white flex items-center gap-1 shadow-md transition-all active:scale-95"
              title={isPanelCollapsed ? "打开管理面板" : "让 3D 科技树铺满整屏"}
            >
              <span className="text-xs">{isPanelCollapsed ? "⧉" : "⛶"}</span>
              <span className="hidden sm:inline">{isPanelCollapsed ? "侧边面板" : "铺满整屏"}</span>
            </button>
          )}

          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-1 sm:p-1.5 rounded-xl text-white/80 bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 hover:text-white shadow-md transition-all"
              title="显示器物理全屏"
            >
              <Icon name="command" size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Hover Inspection Capsule */}
      {hoveredSkill && (
        <div className="relative z-20 self-center pointer-events-none px-4 mb-2 animate-in fade-in zoom-in-95 duration-150">
          <div className="backdrop-blur-xl px-4 py-2 rounded-2xl border border-[var(--aurora-accent)] bg-black/85 text-white shadow-[0_0_25px_rgba(59,130,246,0.4)] flex items-center gap-2.5 max-w-[420px]">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 animate-ping ${
                hoveredSkill.status === "published" ? "bg-[#10B981]" : "bg-[#F59E0B]"
              }`}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold truncate">
                  {hoveredSkill.title || hoveredSkill.slug}
                </span>
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.2 rounded-md font-bold ${
                    hoveredSkill.status === "published"
                      ? "bg-[#10B981]/25 text-[#10B981]"
                      : "bg-[#F59E0B]/25 text-[#F59E0B]"
                  }`}
                >
                  v{hoveredSkill.version || 1} · {hoveredSkill.status === "published" ? "生产可用" : "草稿孵化"}
                </span>
              </div>
              {hoveredSkill.description && (
                <p className="text-[10px] text-white/70 truncate mt-0.5 max-w-[280px]">
                  {hoveredSkill.description}
                </p>
              )}
            </div>
            <span className="text-[9px] font-mono text-[#38BDF8] ml-auto shrink-0 hidden sm:inline">
              点击注入 5 端 →
            </span>
          </div>
        </div>
      )}

      {/* Bottom Floating Terminals & Legend Dock */}
      <div className="relative z-10 pb-3 px-3 flex justify-center pointer-events-auto">
        <div className="bg-black/65 backdrop-blur-xl border border-white/10 rounded-2xl p-1.5 shadow-2xl flex items-center gap-2 overflow-x-auto scrollbar-none text-[10px] font-mono">
          <span className="text-white/40 px-1">全息基座:</span>
          {TERMINAL_TARGETS.map((t) => (
            <div
              key={t.id}
              className="px-2 py-0.8 rounded-lg flex items-center gap-1.5 bg-white/5 border border-white/10 text-white/85"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: t.colorHex }} />
              <span>{t.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
