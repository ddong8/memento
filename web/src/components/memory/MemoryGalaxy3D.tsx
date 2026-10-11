"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { Icon } from "@/components/aurora/Icon";

export interface GalaxyNode {
  id: string;
  name: string;
  type: string;
  summary: string | null;
}

export interface GalaxyEdge {
  source: string;
  target: string;
  type: string;
  strength: number;
}

interface MemoryGalaxy3DProps {
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  selectedNodeId?: string | null;
  onSelectNode?: (node: GalaxyNode | null) => void;
  filterType?: string;
  onFilterChange?: (filterType: string) => void;
  dreamingActive?: boolean;
  isPanelCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onToggleFullscreen?: () => void;
  isPaused?: boolean;
  className?: string;
}

const TYPE_COLORS: Record<string, number> = {
  project: 0x10b981,    // 翡翠绿 · 核心项目
  technology: 0x38bdf8, // 天青蓝 · 技术栈
  concept: 0xa855f7,    // 全息紫 · 核心概念
  tool: 0xf59e0b,       // 琥珀金 · 工具链
  rule: 0xef4444,       // 猩红 · 绝对铁律
  default: 0x94a3b8,    // 银灰 · 通用实体
};

const TYPE_COLOR_HEX: Record<string, string> = {
  project: "#10B981",
  technology: "#38BDF8",
  concept: "#A855F7",
  tool: "#F59E0B",
  rule: "#EF4444",
  default: "#94A3B8",
};

/** Create text canvas sprite for crisp 3D labels with neon type dot & glass pill */
function createTextSprite(text: string, colorHex: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(2, 2);
    ctx.clearRect(0, 0, 256, 64);

    // Rich gradient glass pill background
    const grad = ctx.createLinearGradient(12, 10, 244, 54);
    grad.addColorStop(0, "rgba(13, 18, 34, 0.88)");
    grad.addColorStop(1, "rgba(7, 10, 22, 0.92)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(12, 12, 232, 40, 20);
    ctx.fill();

    // Glowing border stroke
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Left neon indicator dot
    ctx.fillStyle = colorHex;
    ctx.beginPath();
    ctx.arc(28, 32, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // High contrast crisp text
    ctx.fillStyle = "#F8FAFC";
    ctx.font =
      'bold 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const truncated = text.length > 11 ? text.slice(0, 10) + "…" : text;
    ctx.fillText(truncated, 134, 32);
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
  sprite.scale.set(1.48, 0.37, 1);
  return sprite;
}

export default function MemoryGalaxy3D({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  filterType = "",
  onFilterChange,
  dreamingActive = false,
  isPanelCollapsed,
  onToggleCollapse,
  onToggleFullscreen,
  isPaused = false,
  className = "",
}: MemoryGalaxy3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<GalaxyNode | null>(null);
  const [isRotating, setIsRotating] = useState(true);
  const resetCameraRef = useRef<() => void>(() => {});

  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const isRotatingRef = useRef(isRotating);
  isRotatingRef.current = isRotating;

  const hoveredNodeIdRef = useRef<string | null>(null);

  // Filtered nodes
  const activeNodes = useMemo(() => {
    if (!filterType) return nodes;
    return nodes.filter((n) => n.type === filterType);
  }, [nodes, filterType]);

  const activeNodeIds = useMemo(() => new Set(activeNodes.map((n) => n.id)), [activeNodes]);

  const activeEdges = useMemo(() => {
    return edges.filter(
      (e) => activeNodeIds.has(e.source) && activeNodeIds.has(e.target)
    );
  }, [edges, activeNodeIds]);

  // Keep ref to latest callbacks & props for render loop
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;

  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;

  const dreamingActiveRef = useRef(dreamingActive);
  dreamingActiveRef.current = dreamingActive;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 500;

    // Detect mobile device for performance optimization
    const isMobile =
      typeof window !== "undefined" &&
      (window.innerWidth < 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent));

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04060f, 0.032);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    camera.position.set(0, 4.5, 11);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // 2. Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.78);
    scene.add(ambientLight);

    const centerPointLight = new THREE.PointLight(0x8b5cf6, 4.2, 28);
    centerPointLight.position.set(0, 0, 0);
    scene.add(centerPointLight);

    const topLight = new THREE.DirectionalLight(0x38bdf8, 1.35);
    topLight.position.set(5, 12, 8);
    scene.add(topLight);

    const rimLight = new THREE.DirectionalLight(0xec4899, 0.85);
    rimLight.position.set(-6, -8, -5);
    scene.add(rimLight);

    // 3. Cosmic Dust & Starfield Particles
    const starCount = isMobile ? 260 : 420;
    const starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      const radius = 5.8 + Math.random() * 13;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      starPositions[i * 3 + 2] = radius * Math.cos(phi);

      const c = new THREE.Color().setHSL(0.56 + Math.random() * 0.28, 0.78, 0.82);
      starColors[i * 3] = c.r;
      starColors[i * 3 + 1] = c.g;
      starColors[i * 3 + 2] = c.b;
    }
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3));
    const starMaterial = new THREE.PointsMaterial({
      size: 0.11,
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
    });
    const starField = new THREE.Points(starGeometry, starMaterial);
    scene.add(starField);

    // 4. Central Cognitive Core (多层全息外脑记忆母星)
    const coreGroup = new THREE.Group();
    const coreGeo = new THREE.IcosahedronGeometry(0.86, 2);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x8b5cf6,
      emissive: 0x6d28d9,
      emissiveIntensity: 0.95,
      roughness: 0.18,
      metalness: 0.85,
      wireframe: true,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    coreGroup.add(coreMesh);

    // Glowing Inner Nucleus
    const innerGeo = new THREE.SphereGeometry(0.54, 28, 28);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0xd8b4fe,
      transparent: true,
      opacity: 0.92,
    });
    const innerNucleus = new THREE.Mesh(innerGeo, innerMat);
    coreGroup.add(innerNucleus);

    // Primary Equatorial Halo Ring
    const haloGeo = new THREE.RingGeometry(1.06, 1.14, 64);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xa855f7,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
    });
    const haloRing = new THREE.Mesh(haloGeo, haloMat);
    haloRing.rotation.x = Math.PI / 2;
    coreGroup.add(haloRing);

    // Secondary Counter-Rotating Tilted Astrolabe Ring
    const tiltedOrbitGeo = new THREE.TorusGeometry(1.32, 0.014, 16, 80);
    const tiltedOrbitMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    const tiltedOrbitRing = new THREE.Mesh(tiltedOrbitGeo, tiltedOrbitMat);
    tiltedOrbitRing.rotation.set(Math.PI / 3, Math.PI / 6, 0);
    coreGroup.add(tiltedOrbitRing);

    scene.add(coreGroup);

    // 5. Build 3D Entities Layout (Orbital Constellation Sphere Layout)
    const galaxyRoot = new THREE.Group();
    scene.add(galaxyRoot);

    const nodeMeshMap = new Map<string, THREE.Mesh>();
    const nodeShellMap = new Map<string, THREE.Mesh>();
    const nodeMeshList: THREE.Mesh[] = [];
    const nodePositionMap = new Map<string, THREE.Vector3>();
    const adjacencyMap = new Map<string, Set<string>>();

    // Compute 3D Fibonacci Sphere positions for nice organic balance
    const N = Math.max(activeNodes.length, 1);
    const phiAngle = Math.PI * (3 - Math.sqrt(5)); // Golden ratio angle

    activeNodes.forEach((node, idx) => {
      adjacencyMap.set(node.id, new Set());
      const y = 1 - (idx / (N - 1 || 1)) * 2; // y goes from 1 to -1
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = phiAngle * idx;

      // Distance layer: projects are closer, tools mid, concepts outer
      let dist = 3.2;
      if (node.type === "project") dist = 2.4;
      else if (node.type === "technology") dist = 3.4;
      else if (node.type === "concept") dist = 4.2;
      else if (node.type === "rule") dist = 2.8;
      else if (node.type === "tool") dist = 3.8;

      const pos = new THREE.Vector3(
        Math.cos(theta) * radiusAtY * dist,
        y * (dist * 0.85),
        Math.sin(theta) * radiusAtY * dist
      );
      nodePositionMap.set(node.id, pos);

      // Node Geometry & Materials
      const colorVal = TYPE_COLORS[node.type] || TYPE_COLORS.default;
      const colorHex = TYPE_COLOR_HEX[node.type] || TYPE_COLOR_HEX.default;

      let geo: THREE.BufferGeometry;
      if (node.type === "project") {
        geo = new THREE.DodecahedronGeometry(0.32);
      } else if (node.type === "rule") {
        geo = new THREE.OctahedronGeometry(0.29);
      } else if (node.type === "technology") {
        geo = new THREE.IcosahedronGeometry(0.27);
      } else {
        geo = new THREE.SphereGeometry(0.24, 20, 20);
      }

      const mat = new THREE.MeshStandardMaterial({
        color: colorVal,
        emissive: colorVal,
        emissiveIntensity: 0.52,
        roughness: 0.22,
        metalness: 0.78,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.userData = { node, baseY: pos.y, phase: idx * 0.7 };

      // Subtle holographic orbital ring around each node
      const shellGeo = new THREE.TorusGeometry(
        node.type === "project" ? 0.44 : 0.36,
        0.01,
        12,
        36
      );
      const shellMat = new THREE.MeshBasicMaterial({
        color: colorVal,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
      });
      const shellMesh = new THREE.Mesh(shellGeo, shellMat);
      shellMesh.rotation.x = Math.PI / 2.3;
      mesh.add(shellMesh);
      nodeShellMap.set(node.id, shellMesh);

      // Sprite Label
      const sprite = createTextSprite(node.name, colorHex);
      sprite.position.set(0, 0.48, 0);
      mesh.add(sprite);

      galaxyRoot.add(mesh);
      nodeMeshMap.set(node.id, mesh);
      nodeMeshList.push(mesh);
    });

    // 6. Draw 3D Synaptic Connections (Neural Fiber Lines + Flowing Photon Pulses)
    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const validEdgePairs: { p1: THREE.Vector3; p2: THREE.Vector3; c: THREE.Color; speed: number; phase: number }[] = [];

    activeEdges.forEach((edge, idx) => {
      const p1 = nodePositionMap.get(edge.source);
      const p2 = nodePositionMap.get(edge.target);
      if (p1 && p2) {
        adjacencyMap.get(edge.source)?.add(edge.target);
        adjacencyMap.get(edge.target)?.add(edge.source);

        linePositions.push(p1.x, p1.y, p1.z);
        linePositions.push(p2.x, p2.y, p2.z);

        const c1 = new THREE.Color(0x38bdf8);
        const c2 = new THREE.Color(0xa855f7);
        lineColors.push(c1.r, c1.g, c1.b);
        lineColors.push(c2.r, c2.g, c2.b);

        validEdgePairs.push({
          p1,
          p2,
          c: idx % 2 === 0 ? c1 : c2,
          speed: 0.35 + (idx % 5) * 0.08,
          phase: (idx * 0.23) % 1,
        });
      }
    });

    // Also add subtle core filaments from central mother core (0,0,0) to project/rule nodes
    const coreOrigin = new THREE.Vector3(0, 0, 0);
    activeNodes.forEach((node, idx) => {
      if (node.type === "project" || node.type === "rule") {
        const p = nodePositionMap.get(node.id);
        if (p) {
          linePositions.push(0, 0, 0, p.x, p.y, p.z);
          const cCore = new THREE.Color(0x8b5cf6);
          const cNode = new THREE.Color(TYPE_COLORS[node.type] || 0x38bdf8);
          lineColors.push(cCore.r, cCore.g, cCore.b, cNode.r, cNode.g, cNode.b);
          validEdgePairs.push({
            p1: coreOrigin,
            p2: p,
            c: cNode,
            speed: 0.42 + (idx % 4) * 0.07,
            phase: (idx * 0.31) % 1,
          });
        }
      }
    });

    const linesGeo = new THREE.BufferGeometry();
    linesGeo.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
    linesGeo.setAttribute("color", new THREE.Float32BufferAttribute(lineColors, 3));
    const linesMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.38,
      blending: THREE.AdditiveBlending,
    });
    const linesMesh = new THREE.LineSegments(linesGeo, linesMat);
    galaxyRoot.add(linesMesh);

    // Synaptic Signal Pulse Particles travelling along edges
    const pulseCount = validEdgePairs.length;
    const pulseGeo = new THREE.BufferGeometry();
    const pulsePositions = new Float32Array(pulseCount * 3);
    const pulseColors = new Float32Array(pulseCount * 3);
    validEdgePairs.forEach((pair, idx) => {
      pulseColors[idx * 3] = pair.c.r;
      pulseColors[idx * 3 + 1] = pair.c.g;
      pulseColors[idx * 3 + 2] = pair.c.b;
    });
    pulseGeo.setAttribute("position", new THREE.BufferAttribute(pulsePositions, 3));
    pulseGeo.setAttribute("color", new THREE.BufferAttribute(pulseColors, 3));
    const pulseMat = new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const pulsePoints = new THREE.Points(pulseGeo, pulseMat);
    galaxyRoot.add(pulsePoints);

    // 7. Interactive Controls & Responsive Spherical Camera with Smooth Damping
    const getOptimalRadius = (w: number, h: number) => {
      const aspect = w / h;
      const baseRadius = 11;
      if (aspect >= 1.25) {
        return baseRadius;
      }
      const fovRad = (50 * Math.PI) / 360;
      const requiredRadius = (5.2 * 1.15) / (Math.tan(fovRad) * Math.max(aspect, 0.32));
      return Math.max(baseRadius, Math.min(28, requiredRadius));
    };

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let isMouseActive = false;
    let prevMousePos = { x: 0, y: 0 };
    let userHasManuallyZoomed = false;
    const initialRadius = getOptimalRadius(width, height);
    const targetSpherical = { radius: initialRadius, theta: 0, phi: Math.PI / 2.8 };
    const currentSpherical = { radius: initialRadius, theta: 0, phi: Math.PI / 2.8 };
    const targetCameraTarget = new THREE.Vector3(0, 0, 0);
    const currentCameraTarget = new THREE.Vector3(0, 0, 0);

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

    // 绑定重置视角回调，供顶部按钮触发
    resetCameraRef.current = () => {
      userHasManuallyZoomed = false;
      targetCameraTarget.set(0, 0, 0);
      targetSpherical.radius = getOptimalRadius(container.clientWidth || width, container.clientHeight || height);
      targetSpherical.phi = Math.PI / 2.8;
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

        targetSpherical.theta -= dx * 0.007;
        targetSpherical.phi = Math.max(0.12, Math.min(Math.PI - 0.12, targetSpherical.phi - dy * 0.007));
      }
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      userHasManuallyZoomed = true;
      targetSpherical.radius = Math.max(4.5, Math.min(32, targetSpherical.radius + e.deltaY * 0.015));
    };

    const handleClick = (e: MouseEvent) => {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist > 6) return;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(nodeMeshList, false);

      if (intersects.length > 0) {
        const hit = intersects[0].object as THREE.Mesh;
        const node = hit.userData.node as GalaxyNode;
        if (node && onSelectNodeRef.current) {
          onSelectNodeRef.current(node);
          const worldPos = new THREE.Vector3();
          hit.getWorldPosition(worldPos);
          targetCameraTarget.copy(worldPos);
          targetSpherical.radius = 7.2;
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
        initialPinchRadius = targetSpherical.radius;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1 && isDragging) {
        const touch = e.touches[0];
        const dx = touch.clientX - prevMousePos.x;
        const dy = touch.clientY - prevMousePos.y;
        prevMousePos = { x: touch.clientX, y: touch.clientY };

        targetSpherical.theta -= dx * 0.008;
        targetSpherical.phi = Math.max(0.12, Math.min(Math.PI - 0.12, targetSpherical.phi - dy * 0.008));

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
        targetSpherical.radius = Math.max(4.5, Math.min(32, initialPinchRadius * factor));
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
            const intersects = raycaster.intersectObjects(nodeMeshList, false);
            if (intersects.length > 0) {
              const hit = intersects[0].object as THREE.Mesh;
              const node = hit.userData.node as GalaxyNode;
              if (node && onSelectNodeRef.current) {
                onSelectNodeRef.current(node);
                const worldPos = new THREE.Vector3();
                hit.getWorldPosition(worldPos);
                targetCameraTarget.copy(worldPos);
                targetSpherical.radius = 7.2;
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

    container.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("mouseup", handlePointerUp);
    container.addEventListener("mousemove", handlePointerMove);
    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("click", handleClick);
    container.addEventListener("touchstart", handleTouchStart, { passive: false });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd, { passive: false });

    // 8. Animation Render Loop (with Battery-Friendly Pause on Inactivity / Background / Offscreen)
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

      // Smooth Camera Damping & Fly-to Lerp
      currentCameraTarget.lerp(targetCameraTarget, 0.08);
      currentSpherical.theta = THREE.MathUtils.lerp(currentSpherical.theta, targetSpherical.theta, 0.14);
      currentSpherical.phi = THREE.MathUtils.lerp(currentSpherical.phi, targetSpherical.phi, 0.14);
      currentSpherical.radius = THREE.MathUtils.lerp(currentSpherical.radius, targetSpherical.radius, 0.12);
      updateCameraFromSpherical();

      // Slow Galaxy Rotation (Seamless toggle via isRotatingRef without rebuilding scene)
      if (isRotatingRef.current && !isDragging) {
        galaxyRoot.rotation.y += 0.0018;
        coreGroup.rotation.y -= 0.0035;
        starField.rotation.y += 0.0006;
      }

      // Mother Core Breathing Glow & Dual Orbit Rings
      const pulseSpeed = dreamingActiveRef.current ? 4.5 : 1.8;
      const coreScale = 1 + Math.sin(elapsed * pulseSpeed) * (dreamingActiveRef.current ? 0.22 : 0.08);
      coreGroup.scale.setScalar(coreScale);
      haloRing.rotation.z += 0.012;
      tiltedOrbitRing.rotation.z -= 0.018;
      tiltedOrbitRing.rotation.y += 0.008;

      // Animate Synaptic Signal Pulses along Neural Edges
      if (pulseCount > 0) {
        const posAttr = pulseGeo.getAttribute("position") as THREE.BufferAttribute;
        const speedBoost = dreamingActiveRef.current ? 2.4 : 1.0;
        for (let i = 0; i < pulseCount; i++) {
          const pair = validEdgePairs[i];
          const t = (elapsed * pair.speed * speedBoost + pair.phase) % 1;
          posAttr.setXYZ(
            i,
            pair.p1.x + (pair.p2.x - pair.p1.x) * t,
            pair.p1.y + (pair.p2.y - pair.p1.y) * t,
            pair.p1.z + (pair.p2.z - pair.p1.z) * t
          );
        }
        posAttr.needsUpdate = true;
      }

      // Dreaming Convergence Particle Drift
      if (dreamingActiveRef.current) {
        starField.rotation.y += 0.008;
      }

      // Raycast Hover Inspection (Desktop only & only on active mouse movement, saving mobile GPU)
      if (!isMobile && isMouseActive) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(nodeMeshList, false);

        if (intersects.length > 0) {
          const hit = intersects[0].object as THREE.Mesh;
          const node = hit.userData.node as GalaxyNode;
          hoveredNodeIdRef.current = node.id;
          setHoveredNode(node);
          document.body.style.cursor = "pointer";
        } else {
          hoveredNodeIdRef.current = null;
          setHoveredNode(null);
          document.body.style.cursor = "default";
        }
        isMouseActive = false;
      }

      // Highlight Selected / Hovered Node & 1-Hop Connected Neighbors
      const focusId = hoveredNodeIdRef.current || selectedNodeIdRef.current || null;
      const connectedSet = focusId ? adjacencyMap.get(focusId) : null;

      nodeMeshMap.forEach((mesh, id) => {
        const isPrimary = selectedNodeIdRef.current === id || hoveredNodeIdRef.current === id;
        const isNeighbor = connectedSet ? connectedSet.has(id) : false;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const shell = nodeShellMap.get(id);

        if (shell) {
          shell.rotation.z = elapsed * 1.4 + (mesh.userData.phase || 0);
        }

        if (isPrimary) {
          mesh.scale.setScalar(1.38 + Math.sin(elapsed * 4.5) * 0.14);
          mat.emissiveIntensity = 1.35;
        } else if (isNeighbor) {
          mesh.scale.setScalar(1.14 + Math.sin(elapsed * 3.2) * 0.06);
          mat.emissiveIntensity = 0.85;
        } else if (focusId) {
          mesh.scale.setScalar(0.92);
          mat.emissiveIntensity = 0.28;
        } else {
          mesh.scale.setScalar(1.0);
          mat.emissiveIntensity = 0.52;
        }
      });

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      if (!userHasManuallyZoomed && !selectedNodeIdRef.current) {
        targetSpherical.radius = getOptimalRadius(newW, newH);
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
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      document.body.style.cursor = "default";
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      // Deep dispose geometries, materials and CanvasTextures to prevent WebGL memory leak
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) {
          (obj as THREE.Mesh).geometry.dispose();
        }
        const mat = (obj as THREE.Mesh | THREE.Sprite).material;
        if (mat) {
          const disposeMat = (m: THREE.Material) => {
            const anyMat = m as THREE.Material & { map?: THREE.Texture | null };
            if (anyMat.map) {
              anyMat.map.dispose();
            }
            m.dispose();
          };
          if (Array.isArray(mat)) {
            mat.forEach(disposeMat);
          } else {
            disposeMat(mat);
          }
        }
      });
      renderer.dispose();
    };
  }, [activeNodes, activeEdges]);

  return (
    <div
      className={`relative w-full h-full min-h-[340px] sm:min-h-[520px] rounded-3xl overflow-hidden select-none border border-[var(--aurora-border)] bg-[radial-gradient(ellipse_at_50%_0%,#13172e_0%,#080914_60%,#030308_100%)] shadow-2xl flex flex-col justify-between ${className}`}
    >
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} className="absolute inset-0 cursor-grab active:cursor-grabbing z-0 touch-none" />

      {/* Top Floating HUD: Unified Single-Row Controls & Metrics */}
      <div className="relative z-10 p-2 sm:p-3.5 flex items-center justify-between pointer-events-none gap-1 sm:gap-2 flex-nowrap overflow-hidden">
        {/* Left: Galaxy Badge & Filter Type Pills */}
        <div className="flex items-center gap-1 sm:gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 bg-black/65 backdrop-blur-xl px-2 sm:px-3 py-1 sm:py-1.5 rounded-full border border-white/10 shadow-lg pointer-events-auto shrink-0">
            <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-[#38BDF8] animate-ping" />
            <span className="text-[11px] sm:text-xs font-bold text-white tracking-wide">
              <span className="sm:hidden">🌌 </span>
              <span className="hidden sm:inline">3D 认知星云 · </span>
              {activeNodes.length}
            </span>
          </div>

          {onFilterChange && (
            <div className="flex items-center gap-0.5 sm:gap-1 bg-black/60 backdrop-blur-md p-0.5 sm:p-1 rounded-full border border-white/10 overflow-x-auto scrollbar-none pointer-events-auto max-w-[130px] sm:max-w-[280px]">
              {[
                { id: "", label: "全部", color: "#38BDF8" },
                { id: "project", label: "核心工程", color: "#10B981" },
                { id: "technology", label: "技术栈", color: "#38BDF8" },
                { id: "concept", label: "概念", color: "#A855F7" },
                { id: "rule", label: "铁律", color: "#EF4444" },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => onFilterChange(f.id)}
                  style={{
                    backgroundColor: filterType === f.id ? `${f.color}40` : "transparent",
                    borderColor: filterType === f.id ? f.color : "transparent",
                    color: filterType === f.id ? "#FFFFFF" : "rgba(255,255,255,0.7)",
                  }}
                  className="px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-medium border transition-all hover:text-white shrink-0 whitespace-nowrap"
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Unified Action Controls (Never overlapping) */}
        <div className="flex items-center gap-1 sm:gap-1.5 pointer-events-auto shrink-0">
          <button
            onClick={() => setIsRotating((v) => !v)}
            className={`px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all backdrop-blur-md border flex items-center gap-1 ${
              isRotating
                ? "bg-[#8B5CF6]/30 text-[#C084FC] border-[#8B5CF6]/50 shadow-xs"
                : "bg-black/50 text-white/70 border-white/10 hover:text-white"
            }`}
            title="切换星云自转"
          >
            <span className="text-xs">🔄</span>
            <span className="hidden sm:inline">{isRotating ? "自转中" : "已暂停"}</span>
          </button>

          <button
            onClick={() => {
              if (onSelectNodeRef.current) {
                onSelectNodeRef.current(null);
              }
              resetCameraRef.current?.();
            }}
            className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium backdrop-blur-md border bg-black/50 text-white/70 border-white/10 hover:text-white flex items-center gap-1"
            title="重置视角对焦"
          >
            <span className="text-xs">🎯</span>
            <span className="hidden sm:inline">重置视角</span>
          </button>

          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-semibold bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 text-white flex items-center gap-1 shadow-md transition-all active:scale-95"
              title={isPanelCollapsed ? "打开侧边面板" : "让 3D 认知星云铺满整屏"}
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

      {/* Hover Inspection Capsule Banner */}
      {hoveredNode && (
        <div className="relative z-20 self-center pointer-events-none px-4 mb-2 animate-in fade-in zoom-in-95 duration-150">
          <div className="backdrop-blur-xl px-4 py-2 rounded-2xl border border-[var(--aurora-accent)] bg-black/85 text-white shadow-[0_0_25px_rgba(139,92,246,0.35)] flex items-center gap-2.5 max-w-[420px]">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0 animate-ping"
              style={{ backgroundColor: TYPE_COLOR_HEX[hoveredNode.type] || "#fff" }}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold truncate">{hoveredNode.name}</span>
                <span
                  className="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded-md font-bold"
                  style={{
                    backgroundColor: `${TYPE_COLOR_HEX[hoveredNode.type]}25`,
                    color: TYPE_COLOR_HEX[hoveredNode.type],
                  }}
                >
                  {hoveredNode.type}
                </span>
              </div>
              {hoveredNode.summary && (
                <p className="text-[10px] text-white/70 truncate mt-0.5 max-w-[280px]">
                  {hoveredNode.summary}
                </p>
              )}
            </div>
            <span className="text-[9px] font-mono text-[var(--aurora-accent)] ml-auto shrink-0 hidden sm:inline">
              点击对焦 →
            </span>
          </div>
        </div>
      )}

      {/* Bottom Floating Legend Dock */}
      <div className="relative z-10 pb-3 px-3 flex justify-center pointer-events-auto">
        <div className="bg-black/65 backdrop-blur-xl border border-white/10 rounded-2xl p-1 shadow-2xl flex items-center gap-1.5 overflow-x-auto scrollbar-none text-[10px] font-medium">
          <span className="text-white/40 px-2">图例:</span>
          {Object.entries(TYPE_COLOR_HEX).map(([k, hex]) => (
            <div
              key={k}
              className="px-2 py-0.8 rounded-lg flex items-center gap-1.5 bg-white/5 border border-white/10 text-white/80"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hex }} />
              <span className="capitalize">{k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
