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

// 模块级 2D Canvas 纹理缓存池，避免技能列表刷新时重复绘制 Canvas 与上传 GPU 纹理
const skillTextTextureCache = new Map<string, THREE.CanvasTexture>();
const terminalLabelTextureCache = new Map<string, THREE.CanvasTexture>();

/** Create crisp 3D text billboard sprite for skill cores */
function createSkillTextSprite(title: string, version: number, isPublished: boolean): THREE.Sprite {
  const displayTitle = title.length > 10 ? title.slice(0, 9) + "…" : title;
  const cacheKey = `${displayTitle}|${version}|${isPublished ? 1 : 0}`;
  let texture = skillTextTextureCache.get(cacheKey);

  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 256, 64);

      // Rich dark glass pill with status accent
      const grad = ctx.createLinearGradient(8, 10, 248, 54);
      grad.addColorStop(0, "rgba(12, 17, 32, 0.9)");
      grad.addColorStop(1, "rgba(7, 10, 22, 0.94)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(8, 10, 240, 44, 22);
      ctx.fill();

      const accentHex = isPublished ? "#10B981" : "#F59E0B";
      ctx.strokeStyle = accentHex;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Status glowing dot
      ctx.fillStyle = accentHex;
      ctx.beginPath();
      ctx.arc(25, 32, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Text content
      ctx.fillStyle = "#F8FAFC";
      ctx.font =
        'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.fillText(`${displayTitle} · v${version}`, 134, 32);
    }

    texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    skillTextTextureCache.set(cacheKey, texture);
  }

  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(1.55, 0.39, 1);
  return sprite;
}

/** Create 3D floating nameplate sprite for the 5 terminal altars */
function createTerminalLabelSprite(label: string, colorHex: string): THREE.Sprite {
  const cacheKey = `${label}|${colorHex}`;
  let texture = terminalLabelTextureCache.get(cacheKey);

  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 192, 48);

      ctx.fillStyle = "rgba(8, 11, 24, 0.85)";
      ctx.beginPath();
      ctx.roundRect(10, 8, 172, 32, 16);
      ctx.fill();

      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      ctx.fillStyle = colorHex;
      ctx.beginPath();
      ctx.arc(24, 24, 3.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#E2E8F0";
      ctx.font =
        'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 102, 24);
    }

    texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    terminalLabelTextureCache.set(cacheKey, texture);
  }

  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(1.22, 0.31, 1);
  return sprite;
}

interface SkillSceneContext {
  skillRoot: THREE.Group;
  skillMeshMap: Map<string, THREE.Mesh>;
  skillShellMap: Map<string, THREE.Mesh>;
  skillMeshList: THREE.Mesh[];
  sharedGeos: {
    oct: THREE.OctahedronGeometry;
    dodec: THREE.DodecahedronGeometry;
    icosa: THREE.IcosahedronGeometry;
    cage: THREE.IcosahedronGeometry;
  };
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

  // 移动端展开管理抽屉遮挡 3D 舞台时，自动暂停背后不可见的 WebGL 渲染
  const effectivePaused =
    isPaused || (!isPanelCollapsed && typeof window !== "undefined" && window.innerWidth < 1024);

  const isPausedRef = useRef(effectivePaused);
  isPausedRef.current = effectivePaused;

  const isRotatingRef = useRef(isRotating);
  isRotatingRef.current = isRotating;

  const hoveredSlugRef = useRef<string | null>(null);

  const onSelectSkillRef = useRef(onSelectSkill);
  onSelectSkillRef.current = onSelectSkill;

  const selectedSlugRef = useRef(selectedSlug);
  selectedSlugRef.current = selectedSlug;

  const resetCameraRef = useRef<() => void>(() => {});
  const ensureLoopRunningRef = useRef<() => void>(() => {});
  const lastInteractionTimeRef = useRef<number>(Date.now());
  const sceneCtxRef = useRef<SkillSceneContext | null>(null);

  // 当从后台切换回当前路由或收起移动端抽屉（effectivePaused 变为 false）时，立即唤醒渲染循环
  useEffect(() => {
    if (!effectivePaused) {
      lastInteractionTimeRef.current = Date.now();
      ensureLoopRunningRef.current();
    }
  }, [effectivePaused, skills, selectedSlug, isRotating]);

  // 1. 仅在组件挂载时创建一次 WebGLRenderer 与基础星盘底座，绝不随 skills 数据变化销毁重建
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
    scene.fog = new THREE.FogExp2(0x060814, 0.036);

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 100);
    camera.position.set(0, 5.0, 11.0);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isMobile,
      alpha: true,
      powerPreference: isMobile ? "low-power" : "default",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // 2. Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.78);
    scene.add(ambientLight);

    const centerPointLight = new THREE.PointLight(0x8b5cf6, 3.8, 24);
    centerPointLight.position.set(0, 2.2, 0);
    scene.add(centerPointLight);

    const blueDirLight = new THREE.DirectionalLight(0x38bdf8, 1.35);
    blueDirLight.position.set(4, 10, 6);
    scene.add(blueDirLight);

    const warmRimLight = new THREE.DirectionalLight(0xf59e0b, 0.8);
    warmRimLight.position.set(-5, 6, -5);
    scene.add(warmRimLight);

    // 3. Radial Holographic Astrolabe Floor
    const astrolabeGroup = new THREE.Group();
    astrolabeGroup.position.y = -0.04;
    scene.add(astrolabeGroup);

    const baseDiscGeo = new THREE.CircleGeometry(4.8, 64);
    const baseDiscMat = new THREE.MeshBasicMaterial({
      color: 0x0b1024,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    });
    const baseDisc = new THREE.Mesh(baseDiscGeo, baseDiscMat);
    baseDisc.rotation.x = -Math.PI / 2;
    astrolabeGroup.add(baseDisc);

    const outerRingGeo = new THREE.RingGeometry(4.16, 4.24, 96);
    const outerRingMat = new THREE.MeshBasicMaterial({
      color: 0x8b5cf6,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
    });
    const platformRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    platformRing.rotation.x = Math.PI / 2;
    astrolabeGroup.add(platformRing);

    const midRingGeo = new THREE.RingGeometry(2.18, 2.23, 72);
    const midRingMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
    });
    const midRing = new THREE.Mesh(midRingGeo, midRingMat);
    midRing.rotation.x = Math.PI / 2;
    astrolabeGroup.add(midRing);

    const innerHubGeo = new THREE.RingGeometry(0.65, 0.78, 48);
    const innerHubMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    const innerHubRing = new THREE.Mesh(innerHubGeo, innerHubMat);
    innerHubRing.rotation.x = Math.PI / 2;
    astrolabeGroup.add(innerHubRing);

    // Ambient floating dust around the skill matrix
    const dustCount = isMobile ? 120 : 200;
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      const r = 1.0 + Math.random() * 5.2;
      const a = Math.random() * Math.PI * 2;
      dustPos[i * 3] = Math.cos(a) * r;
      dustPos[i * 3 + 1] = Math.random() * 3.6;
      dustPos[i * 3 + 2] = Math.sin(a) * r;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
    const dustMat = new THREE.PointsMaterial({
      color: 0x93c5fd,
      size: 0.08,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
    });
    const dustPoints = new THREE.Points(dustGeo, dustMat);
    scene.add(dustPoints);

    // 4. 5 Terminal Energy Altars
    const terminalAltarGroup = new THREE.Group();
    scene.add(terminalAltarGroup);

    const altarPositions: THREE.Vector3[] = [];
    const altarBeacons: THREE.Mesh[] = [];
    const altarPillars: THREE.MeshBasicMaterial[] = [];
    const railPoints: number[] = [];
    const railColors: number[] = [];

    const sharedAltarGeo = new THREE.CylinderGeometry(0.56, 0.68, 0.24, 32);
    const sharedRimGeo = new THREE.TorusGeometry(0.57, 0.028, 16, 48);
    const sharedPillarGeo = new THREE.CylinderGeometry(0.38, 0.5, 1.35, 24, 1, true);
    const sharedBeaconGeo = new THREE.OctahedronGeometry(0.18, 0);

    TERMINAL_TARGETS.forEach((target, idx) => {
      const angle = (idx / TERMINAL_TARGETS.length) * Math.PI * 2;
      const radius = 4.2;
      const pos = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      altarPositions.push(pos);

      railPoints.push(0, 0.01, 0, pos.x, 0.01, pos.z);
      const tc = new THREE.Color(target.color);
      railColors.push(0.55, 0.36, 0.96, tc.r, tc.g, tc.b);

      const altarMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.3,
        metalness: 0.85,
      });
      const altarMesh = new THREE.Mesh(sharedAltarGeo, altarMat);
      altarMesh.position.copy(pos);

      const rimMat = new THREE.MeshBasicMaterial({ color: target.color });
      const rimMesh = new THREE.Mesh(sharedRimGeo, rimMat);
      rimMesh.rotation.x = Math.PI / 2;
      rimMesh.position.y = 0.13;
      altarMesh.add(rimMesh);

      const pillarMat = new THREE.MeshBasicMaterial({
        color: target.color,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const pillarMesh = new THREE.Mesh(sharedPillarGeo, pillarMat);
      pillarMesh.position.y = 0.78;
      altarMesh.add(pillarMesh);
      altarPillars.push(pillarMat);

      const beaconMat = new THREE.MeshStandardMaterial({
        color: target.color,
        emissive: target.color,
        emissiveIntensity: 0.8,
        roughness: 0.2,
        metalness: 0.8,
      });
      const beaconMesh = new THREE.Mesh(sharedBeaconGeo, beaconMat);
      beaconMesh.position.y = 0.48;
      altarMesh.add(beaconMesh);
      altarBeacons.push(beaconMesh);

      const labelSprite = createTerminalLabelSprite(target.label, target.colorHex);
      labelSprite.position.set(0, 0.92, 0);
      altarMesh.add(labelSprite);

      terminalAltarGroup.add(altarMesh);
    });

    const railGeo = new THREE.BufferGeometry();
    railGeo.setAttribute("position", new THREE.Float32BufferAttribute(railPoints, 3));
    railGeo.setAttribute("color", new THREE.Float32BufferAttribute(railColors, 3));
    const railMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    const railLines = new THREE.LineSegments(railGeo, railMat);
    astrolabeGroup.add(railLines);

    // 5. Skill Polyhedral Cores Root Group & Shared Geometries
    const skillRoot = new THREE.Group();
    scene.add(skillRoot);

    const sharedGeos = {
      oct: new THREE.OctahedronGeometry(0.4),
      dodec: new THREE.DodecahedronGeometry(0.37),
      icosa: new THREE.IcosahedronGeometry(0.35),
      cage: new THREE.IcosahedronGeometry(0.5, 1),
    };

    const skillMeshMap = new Map<string, THREE.Mesh>();
    const skillShellMap = new Map<string, THREE.Mesh>();
    const skillMeshList: THREE.Mesh[] = [];

    sceneCtxRef.current = {
      skillRoot,
      skillMeshMap,
      skillShellMap,
      skillMeshList,
      sharedGeos,
    };

    // 6. Injection Energy Beams & Flowing Photon Stream to 5 Terminals
    const beamGeo = new THREE.BufferGeometry();
    const beamPositions = new Float32Array(TERMINAL_TARGETS.length * 6);
    beamGeo.setAttribute("position", new THREE.BufferAttribute(beamPositions, 3));
    const beamMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
    });
    const beamLines = new THREE.LineSegments(beamGeo, beamMat);
    scene.add(beamLines);

    const pulsesPerTerminal = 3;
    const streamParticleCount = TERMINAL_TARGETS.length * pulsesPerTerminal;
    const streamGeo = new THREE.BufferGeometry();
    const streamPositions = new Float32Array(streamParticleCount * 3);
    const streamColors = new Float32Array(streamParticleCount * 3);
    TERMINAL_TARGETS.forEach((t, tIdx) => {
      const c = new THREE.Color(t.color);
      for (let k = 0; k < pulsesPerTerminal; k++) {
        const idx = (tIdx * pulsesPerTerminal + k) * 3;
        streamColors[idx] = c.r;
        streamColors[idx + 1] = c.g;
        streamColors[idx + 2] = c.b;
      }
    });
    streamGeo.setAttribute("position", new THREE.BufferAttribute(streamPositions, 3));
    streamGeo.setAttribute("color", new THREE.BufferAttribute(streamColors, 3));
    const streamMat = new THREE.PointsMaterial({
      size: 0.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const streamPoints = new THREE.Points(streamGeo, streamMat);
    scene.add(streamPoints);

    // 7. Interactive Controls & Responsive Spherical Camera with Smooth Damping
    const DEFAULT_PHI = (68 * Math.PI) / 180;
    const DEFAULT_TARGET_Y = 0.95;

    const getOptimalRadius = (w: number, h: number) => {
      const aspect = w / h;
      const baseRadius = 11.8;
      if (aspect >= 1.25) {
        return baseRadius;
      }
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
    const initRadius = getOptimalRadius(width, height);
    const targetSpherical = { radius: initRadius, theta: 0, phi: DEFAULT_PHI };
    const currentSpherical = { radius: initRadius, theta: 0, phi: DEFAULT_PHI };
    const targetCameraTarget = new THREE.Vector3(0, DEFAULT_TARGET_Y, 0);
    const currentCameraTarget = new THREE.Vector3(0, DEFAULT_TARGET_Y, 0);

    const updateCameraFromSpherical = () => {
      camera.position.x =
        currentCameraTarget.x +
        currentSpherical.radius * Math.sin(currentSpherical.phi) * Math.sin(currentSpherical.theta);
      camera.position.y =
        currentCameraTarget.y + currentSpherical.radius * Math.cos(currentSpherical.phi);
      camera.position.z =
        currentCameraTarget.z +
        currentSpherical.radius * Math.sin(currentSpherical.phi) * Math.cos(currentSpherical.theta);
      camera.lookAt(currentCameraTarget);
    };

    updateCameraFromSpherical();

    resetCameraRef.current = () => {
      userHasManuallyZoomed = false;
      targetCameraTarget.set(0, DEFAULT_TARGET_Y, 0);
      targetSpherical.radius = getOptimalRadius(container.clientWidth || width, container.clientHeight || height);
      targetSpherical.theta = 0;
      targetSpherical.phi = DEFAULT_PHI;
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
      if (rect.width <= 0 || rect.height <= 0) return;
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      isMouseActive = true;

      if (isDragging) {
        const dx = e.clientX - prevMousePos.x;
        const dy = e.clientY - prevMousePos.y;
        prevMousePos = { x: e.clientX, y: e.clientY };

        targetSpherical.theta -= dx * 0.007;
        targetSpherical.phi = Math.max(0.12, Math.min(Math.PI / 2 - 0.05, targetSpherical.phi - dy * 0.007));
      }
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      userHasManuallyZoomed = true;
      targetSpherical.radius = Math.max(6, Math.min(42, targetSpherical.radius + e.deltaY * 0.015));
    };

    const handleClick = (e: MouseEvent) => {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist > 6) return;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(skillMeshList, false);

      if (intersects.length > 0) {
        const hit = intersects[0].object as THREE.Mesh;
        const skill = hit.userData.skill as SkillItem;
        if (skill && onSelectSkillRef.current) {
          onSelectSkillRef.current(skill);
          const worldPos = new THREE.Vector3();
          hit.getWorldPosition(worldPos);
          targetCameraTarget.copy(worldPos);
          targetSpherical.radius = 8.4;
        }
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      lastInteractionTimeRef.current = Date.now();
      ensureLoopRunningRef.current();
      if (e.touches.length === 1) {
        isDragging = true;
        const touch = e.touches[0];
        prevMousePos = { x: touch.clientX, y: touch.clientY };
        pointerDownPos = { x: touch.clientX, y: touch.clientY };

        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          mouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
          mouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
        }
      } else if (e.touches.length === 2) {
        isDragging = false;
        initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        initialPinchRadius = targetSpherical.radius;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      lastInteractionTimeRef.current = Date.now();
      if (e.touches.length === 1 && isDragging) {
        const touch = e.touches[0];
        const dx = touch.clientX - prevMousePos.x;
        const dy = touch.clientY - prevMousePos.y;
        prevMousePos = { x: touch.clientX, y: touch.clientY };

        targetSpherical.theta -= dx * 0.008;
        targetSpherical.phi = Math.max(0.12, Math.min(Math.PI / 2 - 0.05, targetSpherical.phi - dy * 0.008));

        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          mouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
          mouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
        }
      } else if (e.touches.length === 2 && initialPinchDist > 0) {
        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = initialPinchDist / (currentDist || 1);
        userHasManuallyZoomed = true;
        targetSpherical.radius = Math.max(6, Math.min(42, initialPinchRadius * factor));
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
            if (rect.width <= 0 || rect.height <= 0) return;
            mouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObjects(skillMeshList, false);
            if (intersects.length > 0) {
              const hit = intersects[0].object as THREE.Mesh;
              const skill = hit.userData.skill as SkillItem;
              if (skill && onSelectSkillRef.current) {
                onSelectSkillRef.current(skill);
                const worldPos = new THREE.Vector3();
                hit.getWorldPosition(worldPos);
                targetCameraTarget.copy(worldPos);
                targetSpherical.radius = 8.4;
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

    // 8. 零空转渲染循环：当页面隐藏或切走时彻底停止 requestAnimationFrame，切回时瞬时唤醒
    let animId = 0;
    let isLoopRunning = false;
    const clock = new THREE.Clock();
    let isPageVisible = !document.hidden;
    let isElementIntersecting = true;
    let lastFrameTime = 0;

    const tempWorldOrigin = new THREE.Vector3(0, 1.4, 0);

    const animate = (now?: number) => {
      if (!isPageVisible || !isElementIntersecting || isPausedRef.current) {
        isLoopRunning = false;
        animId = 0;
        return;
      }

      // 移动端无交互超过 20 秒时自动进入静默休眠，防止长时亮屏导致手机 GPU 持续发热；任意触摸即刻 0ms 唤醒
      if (isMobile && !isDragging && Date.now() - lastInteractionTimeRef.current > 20000) {
        isLoopRunning = false;
        animId = 0;
        return;
      }

      isLoopRunning = true;
      animId = requestAnimationFrame(animate);

      // 移动端非拖拽状态下限制为 ~30fps，显著降低 GPU 功耗
      const ts = now ?? performance.now();
      if (isMobile && !isDragging && ts - lastFrameTime < 32) {
        return;
      }
      lastFrameTime = ts;

      const elapsed = clock.getElapsedTime();

      currentCameraTarget.lerp(targetCameraTarget, 0.08);
      currentSpherical.theta = THREE.MathUtils.lerp(currentSpherical.theta, targetSpherical.theta, 0.14);
      currentSpherical.phi = THREE.MathUtils.lerp(currentSpherical.phi, targetSpherical.phi, 0.14);
      currentSpherical.radius = THREE.MathUtils.lerp(currentSpherical.radius, targetSpherical.radius, 0.12);
      updateCameraFromSpherical();

      if (isRotatingRef.current && !isDragging) {
        skillRoot.rotation.y += 0.0022;
        platformRing.rotation.z += 0.004;
        midRing.rotation.z -= 0.006;
        dustPoints.rotation.y += 0.0008;
      }

      const hasSelected = Boolean(selectedSlugRef.current);
      altarBeacons.forEach((beacon, idx) => {
        beacon.rotation.y = elapsed * 1.8 + idx;
        beacon.position.y = 0.48 + Math.sin(elapsed * 2.6 + idx) * 0.05;
      });
      altarPillars.forEach((pMat, idx) => {
        const basicMat = pMat as THREE.MeshBasicMaterial;
        basicMat.opacity = hasSelected
          ? 0.22 + Math.sin(elapsed * 5 + idx) * 0.08
          : 0.1 + Math.sin(elapsed * 2.2 + idx) * 0.03;
      });

      tempWorldOrigin.set(0, 1.4 + Math.sin(elapsed * 2) * 0.08, 0);

      skillMeshMap.forEach((mesh, slug) => {
        mesh.rotation.x += 0.012;
        mesh.rotation.y += 0.018;
        mesh.position.y = mesh.userData.initialY + Math.sin(elapsed * 2 + mesh.position.x) * 0.08;

        const cage = skillShellMap.get(slug);
        if (cage) {
          cage.rotation.x -= 0.022;
          cage.rotation.z += 0.018;
        }

        const isSelected = selectedSlugRef.current === slug;
        const isHovered = hoveredSlugRef.current === slug;
        const mat = mesh.material as THREE.MeshStandardMaterial;

        if (isSelected || isHovered) {
          mesh.scale.setScalar(1.32 + Math.sin(elapsed * 5) * 0.1);
          mat.emissiveIntensity = 1.35;
          mesh.getWorldPosition(tempWorldOrigin);
        } else {
          mesh.scale.setScalar(1.0);
          mat.emissiveIntensity = 0.58;
        }
      });

      const beamPosAttr = beamGeo.getAttribute("position") as THREE.BufferAttribute;
      const streamPosAttr = streamGeo.getAttribute("position") as THREE.BufferAttribute;
      const streamSpeed = hasSelected ? 0.85 : 0.38;

      altarPositions.forEach((altarPos, aIdx) => {
        beamPosAttr.setXYZ(aIdx * 2, tempWorldOrigin.x, tempWorldOrigin.y, tempWorldOrigin.z);
        beamPosAttr.setXYZ(aIdx * 2 + 1, altarPos.x, altarPos.y + 0.45, altarPos.z);

        for (let k = 0; k < pulsesPerTerminal; k++) {
          const pIdx = aIdx * pulsesPerTerminal + k;
          const t = (elapsed * streamSpeed + k / pulsesPerTerminal + aIdx * 0.15) % 1;
          const arcLift = Math.sin(t * Math.PI) * 0.35;
          streamPosAttr.setXYZ(
            pIdx,
            tempWorldOrigin.x + (altarPos.x - tempWorldOrigin.x) * t,
            tempWorldOrigin.y + (altarPos.y + 0.45 - tempWorldOrigin.y) * t + arcLift,
            tempWorldOrigin.z + (altarPos.z - tempWorldOrigin.z) * t
          );
        }
      });
      beamPosAttr.needsUpdate = true;
      streamPosAttr.needsUpdate = true;

      beamMat.opacity =
        selectedSlugRef.current || hoveredSlugRef.current
          ? 0.65 + Math.sin(elapsed * 8) * 0.22
          : 0.16;

      if (!isMobile && isMouseActive) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(skillMeshList, false);

        if (intersects.length > 0) {
          const hit = intersects[0].object as THREE.Mesh;
          const skill = hit.userData.skill as SkillItem;
          hoveredSlugRef.current = skill.slug || null;
          setHoveredSkill(skill);
          document.body.style.cursor = "pointer";
        } else {
          hoveredSlugRef.current = null;
          setHoveredSkill(null);
          document.body.style.cursor = "default";
        }
        isMouseActive = false;
      }

      renderer.render(scene, camera);
    };

    const ensureLoopRunning = () => {
      if (!isLoopRunning && isPageVisible && isElementIntersecting && !isPausedRef.current) {
        isLoopRunning = true;
        clock.getDelta();
        animId = requestAnimationFrame(animate);
      }
    };
    ensureLoopRunningRef.current = ensureLoopRunning;

    const handleVisibilityChange = () => {
      isPageVisible = !document.hidden;
      if (isPageVisible) {
        lastInteractionTimeRef.current = Date.now();
      }
      ensureLoopRunning();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    let intersectionObserver: IntersectionObserver | null = null;
    if (typeof window !== "undefined" && "IntersectionObserver" in window) {
      intersectionObserver = new IntersectionObserver(
        ([entry]) => {
          isElementIntersecting = entry.isIntersecting;
          ensureLoopRunning();
        },
        { threshold: 0.05 }
      );
      intersectionObserver.observe(container);
    }

    ensureLoopRunning();

    // 关键防护：当被 RouteKeepAlive 设为 display:none 时宽高为 0，绝不能调用 renderer.setSize(0, 0) 销毁帧缓冲！
    let lastW = width;
    let lastH = height;
    const handleResize = () => {
      if (!container) return;
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      if (newW <= 0 || newH <= 0 || (newW === lastW && newH === lastH)) return;
      lastW = newW;
      lastH = newH;
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      if (!userHasManuallyZoomed && !selectedSlugRef.current) {
        targetSpherical.radius = getOptimalRadius(newW, newH);
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
      renderer.setSize(newW, newH);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      if (animId) cancelAnimationFrame(animId);
      isLoopRunning = false;
      sceneCtxRef.current = null;
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
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) {
          (obj as THREE.Mesh).geometry.dispose();
        }
        const mat = (obj as THREE.Mesh | THREE.Sprite).material;
        if (mat) {
          if (Array.isArray(mat)) {
            mat.forEach((m) => m.dispose());
          } else {
            mat.dispose();
          }
        }
      });
      sharedGeos.oct.dispose();
      sharedGeos.dodec.dispose();
      sharedGeos.icosa.dispose();
      sharedGeos.cage.dispose();
      renderer.dispose();
    };
  }, []);

  // 2. 轻量级技能核数据同步：仅更新 skillRoot 内的多面体节点，不触碰 WebGLRenderer
  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    const { skillRoot, skillMeshMap, skillShellMap, skillMeshList, sharedGeos } = ctx;

    // 清理旧技能核材质（几何体与缓存贴图均共享复用）
    while (skillRoot.children.length > 0) {
      const child = skillRoot.children[0];
      skillRoot.remove(child);
      child.traverse((obj) => {
        const mat = (obj as THREE.Mesh | THREE.Sprite).material;
        if (mat) {
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
    }
    skillMeshMap.clear();
    skillShellMap.clear();
    skillMeshList.length = 0;

    const skillList =
      skills.length > 0
        ? skills
        : [
            { slug: "auto-update", title: "三位一体发版校验", version: 2, status: "published" },
            { slug: "code-review", title: "代码规范自检", version: 1, status: "published" },
            { slug: "health-monitor", title: "容器集群健康侦测", version: 1, status: "published" },
            { slug: "rag-sync", title: "跨会话上下文同步", version: 1, status: "draft" },
          ];

    const M = skillList.length;
    skillList.forEach((skill, idx) => {
      const angle = (idx / M) * Math.PI * 2;
      const radius = 2.2;
      const yOffset = 1.45 + Math.sin(idx * 1.5) * 0.38;
      const pos = new THREE.Vector3(Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius);

      const isPub = skill.status === "published";
      const coreColor = isPub ? 0x10b981 : 0xf59e0b;

      const geo =
        idx % 3 === 0 ? sharedGeos.oct : idx % 3 === 1 ? sharedGeos.dodec : sharedGeos.icosa;

      const mat = new THREE.MeshStandardMaterial({
        color: coreColor,
        emissive: coreColor,
        emissiveIntensity: 0.6,
        roughness: 0.22,
        metalness: 0.78,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.userData = { skill, initialY: yOffset };

      const cageMat = new THREE.MeshBasicMaterial({
        color: coreColor,
        wireframe: true,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
      });
      const cageMesh = new THREE.Mesh(sharedGeos.cage, cageMat);
      mesh.add(cageMesh);
      if (skill.slug) {
        skillShellMap.set(skill.slug, cageMesh);
      }

      const sprite = createSkillTextSprite(
        skill.title || skill.slug || "未命名技能",
        skill.version || 1,
        isPub
      );
      sprite.position.set(0, 0.62, 0);
      mesh.add(sprite);

      skillRoot.add(mesh);
      skillMeshList.push(mesh);
      if (skill.slug) {
        skillMeshMap.set(skill.slug, mesh);
      }
    });
  }, [skills]);

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
            <span className="text-[11px] sm:text-xs font-bold text-white tracking-wide">
              <span className="sm:hidden">⚡ </span>
              <span className="hidden sm:inline">3D 科技树 · </span>
              {skills.length}
            </span>
          </div>

          <div className="flex items-center gap-1 bg-black/60 backdrop-blur-md px-2 py-0.5 sm:py-1 rounded-full border border-white/10 text-[9px] sm:text-[10px] font-medium text-white/80 pointer-events-auto shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] breathing-glow-emerald" />
            <span className="hidden sm:inline">5/5 端基座实时能量注入</span>
            <span className="sm:hidden">5端热注</span>
          </div>
        </div>

        {/* Right: Unified Action Controls (Never overlapping) */}
        <div className="flex items-center gap-1 sm:gap-1.5 pointer-events-auto shrink-0">
          <button
            onClick={() => setIsRotating((v) => !v)}
            className={`px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all backdrop-blur-md border flex items-center gap-1 ${
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
            className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium backdrop-blur-md border bg-black/50 text-white/70 border-white/10 hover:text-white flex items-center gap-1"
            title="重置技能对焦"
          >
            <span className="text-xs">🎯</span>
            <span className="hidden sm:inline">重置对焦</span>
          </button>

          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-semibold bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 text-white flex items-center gap-1 shadow-md transition-all active:scale-95"
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
        <div className="bg-black/65 backdrop-blur-xl border border-white/10 rounded-2xl p-1.5 shadow-2xl flex items-center gap-2 overflow-x-auto scrollbar-none text-[10px] font-medium">
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
