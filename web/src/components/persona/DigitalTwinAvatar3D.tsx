"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { Icon } from "@/components/aurora/Icon";
import type { AvatarSettings } from "@/lib/api-client";
import CartoonAvatarGraphic from "./CartoonAvatarGraphic";

// 模块级 GLTF 模型与动画单例缓存池，避免切换菜单或重复渲染时从头下载与初始化
interface CachedAvatarModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}
const gltfAvatarCache = new Map<string, CachedAvatarModel>();

export type PersonaDimension =
  | "brain"
  | "communication"
  | "tech"
  | "execution"
  | "project"
  | "evolution"
  | "all";

export interface SynapsePulse {
  text: string;
  dimension?: PersonaDimension;
  complianceStatus?: "pass" | "intercepted" | "adapted";
  timestamp: number;
}

interface DigitalTwinAvatar3DProps {
  activeDimension: PersonaDimension;
  onSelectDimension: (dim: PersonaDimension) => void;
  activeSynapse?: SynapsePulse | null;
  evolutionLevel?: number;
  evolutionExp?: number;
  evolutionStage?: string;
  onSparkEvolution?: () => void;
  ruleStats?: {
    ironLaws: number;
    communication: number;
    tech: number;
    execution: number;
    project: number;
  };
  isPanelCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onToggleFullscreen?: () => void;
  isPaused?: boolean;
  avatarSettings?: AvatarSettings | null;
  onOpenAvatarCustomizer?: () => void;
  className?: string;
}

const DIM_COLORS: Record<PersonaDimension, number> = {
  brain: 0xef4444, // 猩红·绝对铁律
  communication: 0x06b6d4, // 青蓝·沟通风格
  tech: 0xf59e0b, // 琥珀金·架构偏好
  execution: 0x10b981, // 翡翠绿·工作习惯
  project: 0x8b5cf6, // 维度紫·项目专属
  evolution: 0xfacc15, // 耀世金·每日进化
  all: 0xa855f7, // 全息紫·全景中枢
};

interface BonePose {
  head: { x: number; y: number; z: number };
  spine: { x: number; y: number; z: number };
  spine2: { x: number; y: number; z: number };
  leftArm: { x: number; y: number; z: number };
  leftForeArm: { x: number; y: number; z: number };
  rightArm: { x: number; y: number; z: number };
  rightForeArm: { x: number; y: number; z: number };
}

// ── 5 大特点维度专属标志性姿态与肢体语言矩阵 ──
const TRAIT_POSES: Record<string, BonePose> = {
  // 1. 全景/默认：优雅端庄站姿，双臂自然垂于身侧
  all: {
    head: { x: 0, y: 0, z: 0 },
    spine: { x: 0, y: 0, z: 0 },
    spine2: { x: 0, y: 0, z: 0 },
    leftArm: { x: 0.1, y: 0, z: -1.18 },
    leftForeArm: { x: 0, y: 0.22, z: 0 },
    rightArm: { x: 0.1, y: 0, z: 1.18 },
    rightForeArm: { x: 0, y: -0.22, z: 0 },
  },

  // 2. 🧠 脑核绝对铁律：右手抚右眉额前（深思凝神态），左手稳沉身侧，身形挺拔威严
  brain: {
    head: { x: -0.06, y: -0.08, z: 0.03 },
    spine: { x: -0.04, y: 0, z: 0 },
    spine2: { x: -0.03, y: 0, z: 0 },
    leftArm: { x: -0.2, y: 0.15, z: -1.12 },
    leftForeArm: { x: 0, y: 0.35, z: 0 },
    rightArm: { x: 0.88, y: -0.42, z: 0.72 },
    rightForeArm: { x: 1.28, y: -0.52, z: 0.32 },
  },

  // 3. 🛡️ 脑核红线拦截手势（当沙盒拦截触犯铁律时触发）：右手立掌向前做警示拒止姿态
  intercept: {
    head: { x: -0.04, y: 0, z: 0 },
    spine: { x: -0.05, y: 0, z: 0 },
    spine2: { x: -0.04, y: 0, z: 0 },
    leftArm: { x: 0.2, y: 0.35, z: -0.65 },
    leftForeArm: { x: 0.95, y: 0.45, z: 0.2 },
    rightArm: { x: 0.82, y: -0.15, z: 0.45 },
    rightForeArm: { x: 0.95, y: -0.85, z: -0.3 },
  },

  // 4. 💬 沟通风格：身体微前倾，右手向前从容平探（掌心微扬做述职与清晰汇报交流状）
  communication: {
    head: { x: 0.05, y: 0.14, z: -0.05 },
    spine: { x: 0.04, y: 0.04, z: 0 },
    spine2: { x: 0.03, y: 0.02, z: 0 },
    leftArm: { x: 0.1, y: 0.15, z: -0.95 },
    leftForeArm: { x: 0.2, y: 0.35, z: 0 },
    rightArm: { x: 0.68, y: -0.28, z: 0.52 },
    rightForeArm: { x: 0.48, y: -0.62, z: -0.12 },
  },

  // 5. ⚡ 架构偏好：双臂在胸前平展微屈，呈操控空中多维全息控制台、算力矩阵姿态
  tech: {
    head: { x: -0.03, y: 0, z: 0 },
    spine: { x: -0.02, y: 0, z: 0 },
    spine2: { x: -0.02, y: 0, z: 0 },
    leftArm: { x: 0.58, y: 0.2, z: -0.62 },
    leftForeArm: { x: 0.78, y: 0.32, z: 0.2 },
    rightArm: { x: 0.58, y: -0.2, z: 0.62 },
    rightForeArm: { x: 0.78, y: -0.32, z: -0.2 },
  },

  // 6. 🛠️ 工作习惯：双手在胸前沉稳抱胸，显露出“一次做到位、严谨自查”的执行官魄力
  execution: {
    head: { x: 0.03, y: 0, z: 0 },
    spine: { x: -0.02, y: 0, z: 0 },
    spine2: { x: -0.02, y: 0, z: 0 },
    leftArm: { x: 0.38, y: 0.45, z: -0.42 },
    leftForeArm: { x: 1.05, y: 0.65, z: 0.4 },
    rightArm: { x: 0.48, y: -0.45, z: 0.38 },
    rightForeArm: { x: 1.15, y: -0.65, z: -0.4 },
  },

  // 7. 🎯 项目专属：双手在腰腹间微拢托举记忆水晶核，与 5 颗工具伴星交相辉映
  project: {
    head: { x: 0.03, y: -0.04, z: 0 },
    spine: { x: 0.01, y: 0, z: 0 },
    spine2: { x: 0.01, y: 0, z: 0 },
    leftArm: { x: 0.32, y: 0.25, z: -0.82 },
    leftForeArm: { x: 0.88, y: 0.45, z: 0.15 },
    rightArm: { x: 0.32, y: -0.25, z: 0.82 },
    rightForeArm: { x: 0.88, y: -0.45, z: -0.15 },
  },

  // 8. ✨ 每日进化：双臂舒展向后仰首向天，拥抱算力星光，心智全面觉醒
  evolution: {
    head: { x: -0.22, y: 0, z: 0 },
    spine: { x: -0.08, y: 0, z: 0 },
    spine2: { x: -0.06, y: 0, z: 0 },
    leftArm: { x: -0.18, y: 0.32, z: -0.92 },
    leftForeArm: { x: 0.32, y: 0.42, z: 0.1 },
    rightArm: { x: -0.18, y: -0.32, z: 0.92 },
    rightForeArm: { x: 0.32, y: -0.42, z: -0.1 },
  },
};

export default function DigitalTwinAvatar3D({
  activeDimension,
  onSelectDimension,
  activeSynapse,
  evolutionLevel = 9,
  evolutionExp = 860,
  evolutionStage = "深度共生体",
  onSparkEvolution,
  ruleStats = { ironLaws: 11, communication: 6, tech: 15, execution: 13, project: 5 },
  isPanelCollapsed = false,
  onToggleCollapse,
  onToggleFullscreen,
  isPaused = false,
  avatarSettings,
  onOpenAvatarCustomizer,
  className = "",
}: DigitalTwinAvatar3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRotating, setIsRotating] = useState(false);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [viewMode, setViewMode] = useState<"full" | "close">("full");
  const [hudSynapse, setHudSynapse] = useState<SynapsePulse | null>(null);

  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const isRotatingRef = useRef(isRotating);
  isRotatingRef.current = isRotating;

  // References for live 3D mutations without React re-renders
  const avatarGroupRef = useRef<THREE.Group | null>(null);
  const solidMannequinRef = useRef<THREE.Group | null>(null);
  const solidHumanMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const haloMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const bonesRef = useRef<Record<string, THREE.Object3D>>({});
  const auraRingsRef = useRef<THREE.Group | null>(null);
  const haloRef = useRef<THREE.Mesh | null>(null);
  const chestCoreRef = useRef<THREE.Mesh | null>(null);
  const soundWaveRef = useRef<THREE.Mesh | null>(null);
  const scanRingRef = useRef<THREE.Mesh | null>(null);
  const spotlightRef = useRef<THREE.SpotLight | null>(null);
  const currentModelRef = useRef<THREE.Group | null>(null);
  const currentLoadedGenderRef = useRef<string | null>(null);
  const avatarLoaderRef = useRef<GLTFLoader | null>(null);
  const activeMixerRef = useRef<THREE.AnimationMixer | null>(null);

  // Dynamic animation states in frame loop
  const activeDimRef = useRef<PersonaDimension>(activeDimension);
  const isInterceptRef = useRef<boolean>(false);
  const pulseIntensityRef = useRef<number>(1.0);
  const nodProgressRef = useRef<number>(0);
  const lastSynapseTimeRef = useRef<number>(0);

  // Web Speech API Synthesis for Lifelike Persona Voice
  const speakPhrase = (phrase: string) => {
    if (!isVoiceEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const clean = phrase.replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！]/g, "").slice(0, 32);
      if (!clean) return;
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "zh-CN";
      utterance.rate = 1.08;
      utterance.pitch = 1.02;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Audio autoplay gracefully handled
    }
  };

  useEffect(() => {
    activeDimRef.current = activeDimension;
    isInterceptRef.current = false;
    pulseIntensityRef.current = 1.8;
  }, [activeDimension]);

  // Handle Dynamic Avatar Settings (Theme Color, Outfit Color & Metallic Vibe)
  useEffect(() => {
    if (!avatarSettings) return;
    if (solidHumanMatRef.current) {
      if (avatarSettings.outfit_color) {
        try {
          solidHumanMatRef.current.color.set(avatarSettings.outfit_color);
        } catch {}
      }
      if (avatarSettings.gender === "agent") {
        solidHumanMatRef.current.metalness = 0.92;
        solidHumanMatRef.current.roughness = 0.15;
      } else {
        solidHumanMatRef.current.metalness = 0.65;
        solidHumanMatRef.current.roughness = 0.3;
      }
    }
    if (haloMatRef.current && avatarSettings.theme_color) {
      try {
        haloMatRef.current.color.set(avatarSettings.theme_color);
      } catch {}
    }
  }, [avatarSettings]);

  // Handle Dynamic Gender Switch (Male, Female, Agent)
  const targetGender = avatarSettings?.gender || "male";
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("memento:switch-avatar-gender", { detail: targetGender }));
    }
  }, [targetGender]);

  // Handle Synapse Pulse from Props
  useEffect(() => {
    if (activeSynapse && activeSynapse.timestamp !== lastSynapseTimeRef.current) {
      lastSynapseTimeRef.current = activeSynapse.timestamp;
      pulseIntensityRef.current = activeSynapse.complianceStatus === "intercepted" ? 3.0 : 2.4;
      nodProgressRef.current = 1.0;
      isInterceptRef.current = activeSynapse.complianceStatus === "intercepted";
      setHudSynapse(activeSynapse);

      // Voice read out
      if (activeSynapse.complianceStatus === "intercepted") {
        speakPhrase("绝对红线已生效拦截：严禁违背画像铁律");
      } else {
        speakPhrase(activeSynapse.text);
      }

      const timer = setTimeout(() => {
        setHudSynapse((curr) => (curr?.timestamp === activeSynapse.timestamp ? null : curr));
        isInterceptRef.current = false;
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [activeSynapse]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 500;

    // Detect mobile device for performance optimization
    const isMobile =
      typeof window !== "undefined" &&
      (window.innerWidth < 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent));

    // 1. Responsive Camera Setup (默认全景放小尺寸：人物比例适中，保留充裕留白与精致底座展示)
    let currentCamMode: "full" | "close" = "full";
    const getCameraConfig = (w: number, h: number, mode: "full" | "close" = "full") => {
      const aspect = w / h;
      if (mode === "close") {
        return {
          fov: 34,
          pos: [0, 1.45, 1.95] as [number, number, number],
          targetY: 1.38,
        };
      }
      if (aspect < 1.0) {
        // 手机竖屏自适应：将相机拉远以缩小显示
        const zoomFactor = Math.max(1.0, 0.72 / Math.max(aspect, 0.35));
        const dist = Math.min(5.6, 4.2 * zoomFactor);
        return {
          fov: 36,
          pos: [0, 1.08, dist] as [number, number, number],
          targetY: 0.98,
        };
      } else {
        // PC 桌面端宽屏：默认放小全身尺寸（人物占比约 65%，四周留有呼吸感）
        return {
          fov: 36,
          pos: [0, 1.08, 4.2] as [number, number, number],
          targetY: 0.98,
        };
      }
    };

    const initialConfig = getCameraConfig(width, height, "full");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(initialConfig.fov, width / height, 0.1, 100);
    camera.position.set(...initialConfig.pos);
    const cameraTarget = new THREE.Vector3(0, initialConfig.targetY, 0);
    camera.lookAt(cameraTarget);

    // 2. High-Performance WebGL Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.38;
    container.appendChild(renderer.domElement);

    // 3. Studio Portrait Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.6);
    scene.add(ambientLight);

    const frontKey = new THREE.DirectionalLight(0xfff7ee, 2.5);
    frontKey.position.set(0.4, 2.2, 2.8);
    scene.add(frontKey);

    const fillLight = new THREE.DirectionalLight(0xdbeafe, 1.4);
    fillLight.position.set(-1.6, 1.6, 1.8);
    scene.add(fillLight);

    const rimLight = new THREE.PointLight(0xa855f7, 3.2, 8);
    rimLight.position.set(-2.0, 2.0, -1.0);
    scene.add(rimLight);

    const spotlight = new THREE.SpotLight(0x06b6d4, 3.0, 10, Math.PI / 4, 0.4);
    spotlight.position.set(0, 3.2, 1.5);
    spotlight.target.position.set(0, 1.2, 0);
    scene.add(spotlight);
    scene.add(spotlight.target);
    spotlightRef.current = spotlight;

    // 4. Character Root Group
    const avatarGroup = new THREE.Group();
    avatarGroup.position.set(0, 0, 0);
    avatarGroupRef.current = avatarGroup;
    scene.add(avatarGroup);

    // Stand Pedestal (Multi-Layer Holographic Cybernetic Stage)
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.76, 0.88, 0.045, 64),
      new THREE.MeshStandardMaterial({
        color: 0x121426,
        metalness: 0.88,
        roughness: 0.18,
      })
    );
    pedestal.position.set(0, 0.02, 0);
    avatarGroup.add(pedestal);

    const pedestalRingMat = new THREE.MeshBasicMaterial({
      color: 0x8b5cf6,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
    });
    const pedestalRing = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.745, 64),
      pedestalRingMat
    );
    pedestalRing.rotation.x = -Math.PI / 2;
    pedestalRing.position.set(0, 0.044, 0);
    avatarGroup.add(pedestalRing);

    const innerRuneRingMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    const innerRuneRing = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.49, 32),
      innerRuneRingMat
    );
    innerRuneRing.rotation.x = -Math.PI / 2;
    innerRuneRing.position.set(0, 0.045, 0);
    avatarGroup.add(innerRuneRing);

    // Subtle upward stage energy veil from pedestal rim
    const stageVeilMat = new THREE.MeshBasicMaterial({
      color: 0x8b5cf6,
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const stageVeil = new THREE.Mesh(
      new THREE.CylinderGeometry(0.76, 0.74, 0.42, 48, 1, true),
      stageVeilMat
    );
    stageVeil.position.set(0, 0.24, 0);
    avatarGroup.add(stageVeil);

    // Ascending Mind Stardust Particles around Avatar
    const mindParticleCount = isMobile ? 28 : 48;
    const mindParticleGeo = new THREE.BufferGeometry();
    const mindParticlePos = new Float32Array(mindParticleCount * 3);
    const mindParticleData: { radius: number; angle: number; speed: number; yOffset: number }[] = [];
    for (let i = 0; i < mindParticleCount; i++) {
      const r = 0.48 + Math.random() * 0.65;
      const a = Math.random() * Math.PI * 2;
      const y = Math.random() * 1.9;
      mindParticlePos[i * 3] = Math.cos(a) * r;
      mindParticlePos[i * 3 + 1] = y;
      mindParticlePos[i * 3 + 2] = Math.sin(a) * r;
      mindParticleData.push({
        radius: r,
        angle: a,
        speed: 0.22 + Math.random() * 0.25,
        yOffset: y,
      });
    }
    mindParticleGeo.setAttribute("position", new THREE.BufferAttribute(mindParticlePos, 3));
    const mindParticleMat = new THREE.PointsMaterial({
      color: 0xa855f7,
      size: 0.036,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mindParticles = new THREE.Points(mindParticleGeo, mindParticleMat);
    avatarGroup.add(mindParticles);

    // ── Zero-Second Solid Sculpted Humanoid Figure ──
    const solidMannequin = new THREE.Group();
    solidMannequinRef.current = solidMannequin;
    avatarGroup.add(solidMannequin);

    const solidHumanMat = new THREE.MeshStandardMaterial({
      color: avatarSettings?.outfit_color ? new THREE.Color(avatarSettings.outfit_color) : 0x6366f1,
      metalness: avatarSettings?.gender === "agent" ? 0.92 : 0.7,
      roughness: avatarSettings?.gender === "agent" ? 0.15 : 0.25,
      emissive: 0x312e81,
      emissiveIntensity: 0.2,
    });
    solidHumanMatRef.current = solidHumanMat;

    const jointMat = new THREE.MeshStandardMaterial({
      color: 0x8b5cf6,
      metalness: 0.85,
      roughness: 0.2,
    });

    const solidHead = new THREE.Mesh(new THREE.SphereGeometry(0.18, 32, 24), solidHumanMat);
    solidHead.scale.set(0.9, 1.15, 0.95);
    solidHead.position.set(0, 1.62, 0);
    solidMannequin.add(solidHead);

    const solidNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.16, 16), solidHumanMat);
    solidNeck.position.set(0, 1.42, 0);
    solidMannequin.add(solidNeck);

    const solidChest = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.42, 20), solidHumanMat);
    solidChest.position.set(0, 1.2, 0);
    solidMannequin.add(solidChest);

    const solidSpine = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.32, 16), solidHumanMat);
    solidSpine.position.set(0, 0.95, 0);
    solidMannequin.add(solidSpine);

    const shoulderL = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), jointMat);
    shoulderL.position.set(-0.35, 1.35, 0);
    const shoulderR = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), jointMat);
    shoulderR.position.set(0.35, 1.35, 0);
    solidMannequin.add(shoulderL, shoulderR);

    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.55, 12), solidHumanMat);
    armL.position.set(-0.41, 1.05, 0.02);
    armL.rotation.z = 0.18;
    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.55, 12), solidHumanMat);
    armR.position.set(0.41, 1.05, 0.02);
    armR.rotation.z = -0.18;
    solidMannequin.add(armL, armR);

    const foreArmL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.48, 12), solidHumanMat);
    foreArmL.position.set(-0.46, 0.62, 0.05);
    const foreArmR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.48, 12), solidHumanMat);
    foreArmR.position.set(0.46, 0.62, 0.05);
    solidMannequin.add(foreArmL, foreArmR);

    const solidPelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.22, 16), solidHumanMat);
    solidPelvis.position.set(0, 0.75, 0);
    solidMannequin.add(solidPelvis);

    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.05, 0.72, 12), solidHumanMat);
    legL.position.set(-0.12, 0.38, 0);
    const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.05, 0.72, 12), solidHumanMat);
    legR.position.set(0.12, 0.38, 0);
    solidMannequin.add(legL, legR);

    // ── 专属特点光学特效系统 ──
    const haloMat = new THREE.MeshBasicMaterial({
      color: avatarSettings?.theme_color ? new THREE.Color(avatarSettings.theme_color) : 0xef4444,
      transparent: true,
      opacity: 0.9,
    });
    haloMatRef.current = haloMat;
    const haloMesh = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.005, 16, 48), haloMat);
    haloMesh.rotation.x = Math.PI / 2.2;
    haloMesh.position.set(0, 1.84, 0);
    avatarGroup.add(haloMesh);
    haloRef.current = haloMesh;

    const chestMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.95 });
    const chestCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.038, 1), chestMat);
    chestCore.position.set(0, 1.25, 0.14);
    avatarGroup.add(chestCore);
    chestCoreRef.current = chestCore;

    const soundWaveMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.0 });
    const soundWave = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.08, 32), soundWaveMat);
    soundWave.position.set(0, 1.48, 0.15);
    avatarGroup.add(soundWave);
    soundWaveRef.current = soundWave;

    const scanRingMat = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.0, side: THREE.DoubleSide });
    const scanRing = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.52, 48), scanRingMat);
    scanRing.rotation.x = -Math.PI / 2;
    scanRing.position.set(0, 0.05, 0);
    avatarGroup.add(scanRing);
    scanRingRef.current = scanRing;

    const auraGroup = new THREE.Group();
    auraGroup.position.set(0, 1.15, 0);
    avatarGroup.add(auraGroup);
    auraRingsRef.current = auraGroup;

    const ring1Mat = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.4 });
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.005, 16, 80), ring1Mat);
    ring1.rotation.x = Math.PI / 2.4;
    auraGroup.add(ring1);

    const ring2Mat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.35 });
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.004, 16, 100), ring2Mat);
    ring2.rotation.x = Math.PI / 2.1;
    auraGroup.add(ring2);

    const toolColors = [0xa855f7, 0x3b82f6, 0x10b981, 0xf59e0b, 0xec4899];
    const satellites: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      const sat = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 16, 16),
        new THREE.MeshBasicMaterial({ color: toolColors[i] })
      );
      auraGroup.add(sat);
      satellites.push(sat);
    }

    // 5. Dynamic Multi-Gender (Male, Female, Silicon Agent) 3D Model Loader with Instant Module Cache
    const loadAvatarModel = (targetGender: string) => {
      currentLoadedGenderRef.current = targetGender;

      // 保护特效 Mesh 不随旧模型意外销毁
      if (haloMesh.parent !== avatarGroup) {
        avatarGroup.add(haloMesh);
        haloMesh.position.set(0, 1.84, 0);
      }
      if (chestCore.parent !== avatarGroup) {
        avatarGroup.add(chestCore);
        chestCore.position.set(0, 1.25, 0.14);
      }
      if (soundWave.parent !== avatarGroup) {
        avatarGroup.add(soundWave);
        soundWave.position.set(0, 1.48, 0.15);
      }

      // 清除旧模型与旧动画
      if (activeMixerRef.current) {
        activeMixerRef.current.stopAllAction();
        activeMixerRef.current = null;
      }
      if (currentModelRef.current) {
        avatarGroup.remove(currentModelRef.current);
        currentModelRef.current = null;
      }

      // 三大模型映射：男 -> avatar_male.glb, 女 -> avatar_female.glb, 硅基 -> avatar_agent.glb
      let modelUrl = "/models/avatar_male.glb";
      if (targetGender === "female") modelUrl = "/models/avatar_female.glb";
      else if (targetGender === "agent") modelUrl = "/models/avatar_agent.glb";

      const applyModelToScene = (sourceScene: THREE.Group, animations: THREE.AnimationClip[]) => {
        if (currentLoadedGenderRef.current !== targetGender) return;

        // 使用 SkeletonUtils.clone 快速克隆带骨架网格，保证场景间隔离与极速装配
        const model = SkeletonUtils.clone(sourceScene) as THREE.Group;
        currentModelRef.current = model;
        avatarGroup.add(model);

        // Vanguard 男性模型 Mixamo 坐标系默认面向 -Z，旋转 180 度正对观察者
        if (targetGender === "male") {
          model.rotation.y = Math.PI;
        }

        // 自动包围盒归一化与黄金高度对齐（智能体 1.55m，人类标准 1.78m）
        model.position.set(0, 0, 0);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const targetHeight = targetGender === "agent" ? 1.55 : 1.78;
        if (size.y > 0.1) {
          const scaleFactor = targetHeight / size.y;
          model.scale.setScalar(scaleFactor);
        }

        // 重新更新矩阵并精确对齐底座表面，水平严格居中于底座 (0, 0)
        model.updateMatrixWorld(true);
        const scaledBox = new THREE.Box3().setFromObject(model);
        model.position.y -= (scaledBox.min.y - 0.04);
        model.position.x = 0;
        model.position.z = 0;

        // 隐藏素模假人
        solidMannequin.visible = false;

        // 挂载原生 Idle 待机动作（如 Mixamo 男性与机器人智能体），防止骨骼动作冲突
        if (animations && animations.length > 0) {
          const mixer = new THREE.AnimationMixer(model);
          const idleClip =
            animations.find((a) => a.name.toLowerCase() === "idle") ||
            animations.find((a) => a.name.toLowerCase().includes("idle")) ||
            animations[0];
          if (idleClip) {
            const action = mixer.clipAction(idleClip);
            action.play();
          }
          activeMixerRef.current = mixer;
        } else {
          activeMixerRef.current = null;
        }

        const bones: Record<string, THREE.Object3D> = {};
        model.traverse((child) => {
          if (child instanceof THREE.Bone) {
            const cleanName = child.name.replace(/^mixamorig[:_]?/i, "");
            bones[cleanName] = child;
            bones[child.name] = child;
          }
          if (child instanceof THREE.Mesh && child.material) {
            child.material.side = THREE.FrontSide;
            if ("roughness" in child.material) {
              child.material.roughness = Math.max(0.3, child.material.roughness * 0.9);
            }
          }
        });

        // 骨骼别名对齐（支持 Mixamo 标准、Ready Player Me、以及 RobotExpressive 硅基骨骼）
        if (!bones.RightArm && bones["UpperArm.R"]) bones.RightArm = bones["UpperArm.R"];
        if (!bones.RightForeArm && bones["LowerArm.R"]) bones.RightForeArm = bones["LowerArm.R"];
        if (!bones.LeftArm && bones["UpperArm.L"]) bones.LeftArm = bones["UpperArm.L"];
        if (!bones.LeftForeArm && bones["LowerArm.L"]) bones.LeftForeArm = bones["LowerArm.L"];
        if (!bones.Spine && bones["Torso"]) bones.Spine = bones["Torso"];
        if (!bones.Spine2 && bones["Abdomen"]) bones.Spine2 = bones["Abdomen"];
        bonesRef.current = bones;

        const headBone = bones.Head || bones.head;
        if (headBone) {
          headBone.add(haloMesh);
          haloMesh.position.set(0, 0.16, 0);
          headBone.add(soundWave);
          soundWave.position.set(0, -0.05, 0.16);
        } else {
          avatarGroup.add(haloMesh);
          haloMesh.position.set(0, 1.84, 0);
          avatarGroup.add(soundWave);
          soundWave.position.set(0, 1.48, 0.15);
        }

        const chestBone = bones.Spine2 || bones.Spine || bones.spine2 || bones.spine;
        if (chestBone) {
          chestBone.add(chestCore);
          chestCore.position.set(0, 0.08, 0.12);
        } else {
          avatarGroup.add(chestCore);
          chestCore.position.set(0, 1.25, 0.14);
        }
      };

      // 关键优化：若模型已在模块缓存池中，0ms 同步秒开！直接跳过假人阶段
      const cached = gltfAvatarCache.get(modelUrl);
      if (cached) {
        applyModelToScene(cached.scene, cached.animations);
        return;
      }

      // 仅在首次拉取时展示全息素模待机过渡
      solidMannequin.visible = true;

      const loader = new GLTFLoader();
      avatarLoaderRef.current = loader;

      loader.load(
        modelUrl,
        (gltf) => {
          gltfAvatarCache.set(modelUrl, {
            scene: gltf.scene,
            animations: gltf.animations || [],
          });
          applyModelToScene(gltf.scene, gltf.animations || []);
        },
        undefined,
        (err) => {
          console.warn(`载入 ${modelUrl} 模型失败，降级显示全息数字人体:`, err);
          solidMannequin.visible = true;
        }
      );
    };

    const handleGenderSwitch = (e: Event) => {
      const g = (e as CustomEvent).detail;
      if (g) loadAvatarModel(g);
    };
    window.addEventListener("memento:switch-avatar-gender", handleGenderSwitch);

    // 初始载入用户形象设定性别模型
    loadAvatarModel(avatarSettings?.gender || "male");

    // 6. Interactive Drag, Parallax Look-At & Zoom Controls with Smooth Damping
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let prevMouseX = 0;
    let targetRotationY = 0;
    let initialPinchDist = 0;
    let initialCamZ = camera.position.z;

    const handlePointerDown = (e: MouseEvent) => {
      isDragging = true;
      prevMouseX = e.clientX;
    };

    const handlePointerUp = () => {
      isDragging = false;
    };

    const handlePointerMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (isDragging) {
        const deltaX = e.clientX - prevMouseX;
        targetRotationY += deltaX * 0.0085;
        prevMouseX = e.clientX;
      }
    };

    const camTransition = {
      active: false,
      targetZ: initialConfig.pos[2],
      targetCamY: initialConfig.pos[1],
      targetY: initialConfig.targetY,
    };

    const handleCamViewSwitch = (e: Event) => {
      const mode = (e as CustomEvent).detail as "full" | "close";
      currentCamMode = mode;
      const cfg = getCameraConfig(container.clientWidth, container.clientHeight, mode);
      camTransition.targetZ = cfg.pos[2];
      camTransition.targetCamY = cfg.pos[1];
      camTransition.targetY = cfg.targetY;
      camTransition.active = true;
    };
    window.addEventListener("memento:set-cam-view", handleCamViewSwitch);

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      camTransition.active = false;
      const newZ = Math.max(1.2, Math.min(6.5, camera.position.z + e.deltaY * 0.004));
      camera.position.z = newZ;
      // 当拉近时，观察目标平滑上移至面部；拉远时平滑居中全身（0.98）
      const t = THREE.MathUtils.clamp((newZ - 1.8) / (4.2 - 1.8), 0, 1);
      cameraTarget.y = THREE.MathUtils.lerp(1.38, 0.98, t);
      camera.position.y = THREE.MathUtils.lerp(1.45, 1.08, t);
    };

    container.style.touchAction = "none";

    const handleDblClick = () => {
      const next = currentCamMode === "full" ? "close" : "full";
      currentCamMode = next;
      const cfg = getCameraConfig(container.clientWidth, container.clientHeight, next);
      camTransition.targetZ = cfg.pos[2];
      camTransition.targetCamY = cfg.pos[1];
      camTransition.targetY = cfg.targetY;
      camTransition.active = true;
      setViewMode(next);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDragging = true;
        prevMouseX = e.touches[0].clientX;
        const rect = container.getBoundingClientRect();
        mouse.x = ((e.touches[0].clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.touches[0].clientY - rect.top) / rect.height) * 2 + 1;
      } else if (e.touches.length === 2) {
        isDragging = false;
        initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        initialCamZ = camera.position.z;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isDragging && e.touches.length === 1) {
        const deltaX = e.touches[0].clientX - prevMouseX;
        targetRotationY += deltaX * 0.0085;
        prevMouseX = e.touches[0].clientX;
        const rect = container.getBoundingClientRect();
        mouse.x = ((e.touches[0].clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.touches[0].clientY - rect.top) / rect.height) * 2 + 1;
      } else if (e.touches.length === 2 && initialPinchDist > 0) {
        camTransition.active = false;
        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = initialPinchDist / (currentDist || 1);
        const newZ = Math.max(1.2, Math.min(6.5, initialCamZ * factor));
        camera.position.z = newZ;
        const t = THREE.MathUtils.clamp((newZ - 1.8) / (4.2 - 1.8), 0, 1);
        cameraTarget.y = THREE.MathUtils.lerp(1.38, 0.98, t);
        camera.position.y = THREE.MathUtils.lerp(1.45, 1.08, t);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        isDragging = false;
        initialPinchDist = 0;
      }
    };

    container.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("mouseup", handlePointerUp);
    container.addEventListener("mousemove", handlePointerMove);
    container.addEventListener("dblclick", handleDblClick);
    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("touchstart", handleTouchStart, { passive: false });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd, { passive: false });

    // 7. 60fps Trait-Driven Gesture & Physics Loop
    let animId: number;
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

    const currentColor = new THREE.Color(0xef4444);
    const targetColor = new THREE.Color(0xef4444);

    const currentPose = {
      head: { x: 0, y: 0, z: 0 },
      spine: { x: 0, y: 0, z: 0 },
      spine2: { x: 0, y: 0, z: 0 },
      leftArm: { x: 0.1, y: 0, z: -1.18 },
      leftForeArm: { x: 0, y: 0.22, z: 0 },
      rightArm: { x: 0.1, y: 0, z: 1.18 },
      rightForeArm: { x: 0, y: -0.22, z: 0 },
    };

    const animate = () => {
      animId = requestAnimationFrame(animate);

      // Stop GPU work when tab is in background, element is offscreen, or parent page asks to pause
      if (!isPageVisible || !isElementIntersecting || isPausedRef.current) return;

      const elapsed = clock.getElapsedTime();

      // Lifelike Micro-Gaze Saccades (每 3 秒极微小的视线生理颤动，告别木讷)
      const saccade = Math.sin(elapsed * 4.5) * 0.008 * Math.cos(elapsed * 2.1);
      const breath = Math.sin(elapsed * 2.2);

      // Synapse Pulse Decay
      if (pulseIntensityRef.current > 1.0) {
        pulseIntensityRef.current = THREE.MathUtils.lerp(pulseIntensityRef.current, 1.0, 0.05);
      }

      // Nod gesture decay
      let nodAngle = 0;
      if (nodProgressRef.current > 0) {
        nodAngle = Math.sin(nodProgressRef.current * Math.PI) * 0.14;
        nodProgressRef.current = Math.max(0, nodProgressRef.current - 0.04);
      }

      // Active Dimension Color
      const activeDim = activeDimRef.current;
      targetColor.setHex(DIM_COLORS[activeDim] ?? 0xa855f7);
      currentColor.lerp(targetColor, 0.08);

      if (haloMat) haloMat.color.copy(currentColor);
      if (chestMat) chestMat.color.copy(currentColor);
      if (spotlightRef.current) spotlightRef.current.color.copy(currentColor);
      pedestalRingMat.color.copy(currentColor);
      stageVeilMat.color.copy(currentColor);
      mindParticleMat.color.copy(currentColor);

      // Animate Pedestal Rings & Ascending Mind Particles
      pedestalRing.rotation.z = elapsed * 0.35;
      innerRuneRing.rotation.z = -elapsed * 0.55;
      stageVeilMat.opacity = 0.07 + Math.sin(elapsed * 2.2) * 0.03;

      const mindPosAttr = mindParticleGeo.getAttribute("position") as THREE.BufferAttribute;
      const boost = pulseIntensityRef.current;
      for (let i = 0; i < mindParticleCount; i++) {
        const d = mindParticleData[i];
        const y = (d.yOffset + elapsed * d.speed * boost) % 1.95;
        const spiralAngle = d.angle + elapsed * 0.45;
        mindPosAttr.setXYZ(
          i,
          Math.cos(spiralAngle) * d.radius,
          y,
          Math.sin(spiralAngle) * d.radius
        );
      }
      mindPosAttr.needsUpdate = true;

      // Select Target Pose (Support Intercept Stance if flagged)
      const targetPose = isInterceptRef.current
        ? TRAIT_POSES.intercept
        : TRAIT_POSES[activeDim] || TRAIT_POSES.all;
      const lerpSpeed = 0.07;

      currentPose.head.x = THREE.MathUtils.lerp(currentPose.head.x, targetPose.head.x, lerpSpeed);
      currentPose.head.y = THREE.MathUtils.lerp(currentPose.head.y, targetPose.head.y, lerpSpeed);
      currentPose.head.z = THREE.MathUtils.lerp(currentPose.head.z, targetPose.head.z, lerpSpeed);

      currentPose.spine.x = THREE.MathUtils.lerp(currentPose.spine.x, targetPose.spine.x, lerpSpeed);
      currentPose.spine2.x = THREE.MathUtils.lerp(currentPose.spine2.x, targetPose.spine2.x, lerpSpeed);

      currentPose.rightArm.x = THREE.MathUtils.lerp(currentPose.rightArm.x, targetPose.rightArm.x, lerpSpeed);
      currentPose.rightArm.y = THREE.MathUtils.lerp(currentPose.rightArm.y, targetPose.rightArm.y, lerpSpeed);
      currentPose.rightArm.z = THREE.MathUtils.lerp(currentPose.rightArm.z, targetPose.rightArm.z, lerpSpeed);

      currentPose.rightForeArm.x = THREE.MathUtils.lerp(currentPose.rightForeArm.x, targetPose.rightForeArm.x, lerpSpeed);
      currentPose.rightForeArm.y = THREE.MathUtils.lerp(currentPose.rightForeArm.y, targetPose.rightForeArm.y, lerpSpeed);
      currentPose.rightForeArm.z = THREE.MathUtils.lerp(currentPose.rightForeArm.z, targetPose.rightForeArm.z, lerpSpeed);

      currentPose.leftArm.x = THREE.MathUtils.lerp(currentPose.leftArm.x, targetPose.leftArm.x, lerpSpeed);
      currentPose.leftArm.y = THREE.MathUtils.lerp(currentPose.leftArm.y, targetPose.leftArm.y, lerpSpeed);
      currentPose.leftArm.z = THREE.MathUtils.lerp(currentPose.leftArm.z, targetPose.leftArm.z, lerpSpeed);

      currentPose.leftForeArm.x = THREE.MathUtils.lerp(currentPose.leftForeArm.x, targetPose.leftForeArm.x, lerpSpeed);
      currentPose.leftForeArm.y = THREE.MathUtils.lerp(currentPose.leftForeArm.y, targetPose.leftForeArm.y, lerpSpeed);
      currentPose.leftForeArm.z = THREE.MathUtils.lerp(currentPose.leftForeArm.z, targetPose.leftForeArm.z, lerpSpeed);

      // Update Animation Mixer for models with native glTF animations (Mixamo male & Robot)
      const delta = clock.getDelta();
      if (activeMixerRef.current) {
        activeMixerRef.current.update(delta);
      }

      // Apply to GLB Bones
      const bones = bonesRef.current;
      if (bones.Head && !isDragging) {
        const lookMult = currentLoadedGenderRef.current === "male" ? -1 : 1;
        bones.Head.rotation.x = currentPose.head.x - mouse.y * 0.18 + nodAngle + saccade;
        bones.Head.rotation.y = currentPose.head.y + lookMult * mouse.x * 0.28 + saccade;
        bones.Head.rotation.z = currentPose.head.z;
      }
      if (!activeMixerRef.current) {
        if (bones.Spine) bones.Spine.rotation.x = currentPose.spine.x + breath * 0.02;
        if (bones.Spine2) bones.Spine2.rotation.x = currentPose.spine2.x + breath * 0.02;

        if (bones.RightArm) {
          bones.RightArm.rotation.x = currentPose.rightArm.x + breath * 0.015;
          bones.RightArm.rotation.y = currentPose.rightArm.y;
          bones.RightArm.rotation.z = currentPose.rightArm.z;
        }
        if (bones.RightForeArm) {
          bones.RightForeArm.rotation.x = currentPose.rightForeArm.x;
          bones.RightForeArm.rotation.y = currentPose.rightForeArm.y;
          bones.RightForeArm.rotation.z = currentPose.rightForeArm.z;
        }

        if (bones.LeftArm) {
          bones.LeftArm.rotation.x = currentPose.leftArm.x + breath * 0.015;
          bones.LeftArm.rotation.y = currentPose.leftArm.y;
          bones.LeftArm.rotation.z = currentPose.leftArm.z;
        }
        if (bones.LeftForeArm) {
          bones.LeftForeArm.rotation.x = currentPose.leftForeArm.x;
          bones.LeftForeArm.rotation.y = currentPose.leftForeArm.y;
          bones.LeftForeArm.rotation.z = currentPose.leftForeArm.z;
        }
      }

      // Apply to Solid Mannequin
      if (solidMannequin.visible) {
        solidChest.scale.set(1 + breath * 0.025, 1 + breath * 0.015, 1 + breath * 0.03);
        solidHead.rotation.y = currentPose.head.y + mouse.x * 0.25;
        solidHead.rotation.x = currentPose.head.x - mouse.y * 0.16 + nodAngle;

        armR.rotation.z = currentPose.rightArm.z;
        armR.rotation.x = currentPose.rightArm.x;
        foreArmR.rotation.z = currentPose.rightForeArm.z;
        foreArmR.rotation.x = currentPose.rightForeArm.x;

        armL.rotation.z = currentPose.leftArm.z;
        armL.rotation.x = currentPose.leftArm.x;
        foreArmL.rotation.z = currentPose.leftForeArm.z;
        foreArmL.rotation.x = currentPose.leftForeArm.x;
      }

      // 特征专属特效
      if (soundWave) {
        if (activeDim === "communication") {
          const wavePhase = (elapsed * 2.5) % 1;
          soundWave.scale.setScalar(1 + wavePhase * 1.8);
          soundWaveMat.opacity = Math.max(0, (1 - wavePhase) * 0.85);
        } else {
          soundWaveMat.opacity = 0;
        }
      }

      if (scanRing) {
        if (activeDim === "execution") {
          const scanPhase = (elapsed * 0.8) % 1;
          scanRing.position.y = 0.05 + scanPhase * 1.7;
          scanRingMat.opacity = Math.sin(scanPhase * Math.PI) * 0.6;
        } else {
          scanRingMat.opacity = 0;
        }
      }

      const speedMultiplier = activeDim === "tech" ? 2.5 : activeDim === "evolution" ? 3.0 : 1.0;
      const orbitSpeed = (0.65 * speedMultiplier + (pulseIntensityRef.current - 1.0) * 0.8) * elapsed;
      satellites.forEach((sat, idx) => {
        const angle = orbitSpeed + (idx * Math.PI * 2) / 5;
        sat.position.set(Math.cos(angle) * 1.35, Math.sin(angle * 2) * 0.08, Math.sin(angle) * 1.35);
      });

      haloMesh.rotation.z = elapsed * (activeDim === "brain" ? 1.5 : 0.4);
      const haloBaseScale = 1 + Math.sin(elapsed * 2.5) * 0.05;
      haloMesh.scale.setScalar(haloBaseScale * pulseIntensityRef.current * (activeDim === "brain" ? 1.15 : 1.0));

      chestCore.rotation.x = elapsed * (activeDim === "tech" ? 3.2 : 1.2);
      chestCore.rotation.y = elapsed * (activeDim === "tech" ? 4.0 : 1.6);
      chestCore.scale.setScalar(pulseIntensityRef.current * (activeDim === "tech" ? 1.3 : 1.0));

      if (isRotatingRef.current && !isDragging) {
        targetRotationY += 0.005;
      }
      avatarGroup.rotation.y = THREE.MathUtils.lerp(avatarGroup.rotation.y, targetRotationY, 0.14);

      if (camTransition.active) {
        camera.position.z = THREE.MathUtils.lerp(camera.position.z, camTransition.targetZ, 0.12);
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, camTransition.targetCamY, 0.12);
        cameraTarget.y = THREE.MathUtils.lerp(cameraTarget.y, camTransition.targetY, 0.12);
        if (
          Math.abs(camera.position.z - camTransition.targetZ) < 0.01 &&
          Math.abs(camera.position.y - camTransition.targetCamY) < 0.01 &&
          Math.abs(cameraTarget.y - camTransition.targetY) < 0.01
        ) {
          camera.position.z = camTransition.targetZ;
          camera.position.y = camTransition.targetCamY;
          cameraTarget.y = camTransition.targetY;
          camTransition.active = false;
        }
      }

      camera.lookAt(cameraTarget);
      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container || !renderer || !camera) return;
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      const cfg = getCameraConfig(newW, newH, currentCamMode);
      camera.aspect = newW / newH;
      camera.fov = cfg.fov;
      camera.position.set(camera.position.x, cfg.pos[1], cfg.pos[2]);
      cameraTarget.set(0, cfg.targetY, 0);
      camera.updateProjectionMatrix();
      camera.lookAt(cameraTarget);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(newW, newH);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      if (activeMixerRef.current) {
        activeMixerRef.current.stopAllAction();
        activeMixerRef.current = null;
      }
      window.removeEventListener("memento:switch-avatar-gender", handleGenderSwitch);
      window.removeEventListener("memento:set-cam-view", handleCamViewSwitch);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      container.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("mouseup", handlePointerUp);
      container.removeEventListener("mousemove", handlePointerMove);
      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      // Deep dispose geometries and materials to prevent WebGL memory leak
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) {
          (obj as THREE.Mesh).geometry.dispose();
        }
        const mat = (obj as THREE.Mesh).material;
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
  }, []);

  const DIMENSIONS_CONFIG = [
    {
      id: "brain" as const,
      label: "🧠 脑核 · 绝对红线",
      shortLabel: "🧠 铁律",
      gestureHint: "抚眉凝神",
      color: "#EF4444",
      count: ruleStats.ironLaws,
    },
    {
      id: "communication" as const,
      label: "💬 喉核 · 交互沟通",
      shortLabel: "💬 沟通",
      gestureHint: "述职手势",
      color: "#06B6D4",
      count: ruleStats.communication,
    },
    {
      id: "tech" as const,
      label: "⚡ 心核 · 架构偏好",
      shortLabel: "⚡ 架构",
      gestureHint: "全息操控",
      color: "#F59E0B",
      count: ruleStats.tech,
    },
    {
      id: "execution" as const,
      label: "🛠️ 肢端 · 工作习惯",
      shortLabel: "🛠️ 习惯",
      gestureHint: "沉稳抱胸",
      color: "#10B981",
      count: ruleStats.execution,
    },
    {
      id: "project" as const,
      label: "🎯 靶向 · 项目规范",
      shortLabel: "🎯 项目",
      gestureHint: "托举晶核",
      color: "#8B5CF6",
      count: ruleStats.project,
    },
  ];

  return (
    <div
      className={`relative w-full h-full min-h-[340px] sm:min-h-[460px] rounded-3xl overflow-hidden select-none border border-[var(--aurora-border)] bg-[radial-gradient(ellipse_at_50%_0%,#181a36_0%,#080912_55%,#030308_100%)] shadow-2xl flex flex-col justify-between ${className}`}
    >
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} className="absolute inset-0 cursor-grab active:cursor-grabbing z-0 touch-none" />

      {/* 身体各部位「特点神经突触热点」(仅在桌面端显示，手机端通过底部精致 Dock 掌控，彻底消除小屏重叠) */}
      <div className="hidden sm:block absolute inset-0 pointer-events-none z-15 overflow-hidden">
        <button
          onClick={() => onSelectDimension("brain")}
          className={`absolute top-[16%] left-[16%] pointer-events-auto px-2 py-0.8 rounded-full border text-[10px] font-mono transition-all flex items-center gap-1 backdrop-blur-md shadow-md hover:scale-105 ${
            activeDimension === "brain"
              ? "bg-[#EF4444]/30 border-[#EF4444] text-[#EF4444] ring-2 ring-[#EF4444]/40 font-bold scale-105"
              : "bg-black/50 border-white/10 text-white/70 hover:text-white hover:border-[#EF4444]/60"
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-ping" />
          <span>🧠 脑核铁律</span>
          <span className="opacity-60">({ruleStats.ironLaws})</span>
        </button>

        <button
          onClick={() => onSelectDimension("communication")}
          className={`absolute top-[28%] right-[16%] pointer-events-auto px-2 py-0.8 rounded-full border text-[10px] font-mono transition-all flex items-center gap-1 backdrop-blur-md shadow-md hover:scale-105 ${
            activeDimension === "communication"
              ? "bg-[#06B6D4]/30 border-[#06B6D4] text-[#06B6D4] ring-2 ring-[#06B6D4]/40 font-bold scale-105"
              : "bg-black/50 border-white/10 text-white/70 hover:text-white hover:border-[#06B6D4]/60"
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#06B6D4] animate-ping" />
          <span>💬 沟通风格</span>
          <span className="opacity-60">({ruleStats.communication})</span>
        </button>

        <button
          onClick={() => onSelectDimension("tech")}
          className={`absolute top-[44%] left-[12%] pointer-events-auto px-2 py-0.8 rounded-full border text-[10px] font-mono transition-all flex items-center gap-1 backdrop-blur-md shadow-md hover:scale-105 ${
            activeDimension === "tech"
              ? "bg-[#F59E0B]/30 border-[#F59E0B] text-[#F59E0B] ring-2 ring-[#F59E0B]/40 font-bold scale-105"
              : "bg-black/50 border-white/10 text-white/70 hover:text-white hover:border-[#F59E0B]/60"
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B] animate-ping" />
          <span>⚡ 架构心核</span>
          <span className="opacity-60">({ruleStats.tech})</span>
        </button>

        <button
          onClick={() => onSelectDimension("execution")}
          className={`absolute top-[58%] right-[14%] pointer-events-auto px-2 py-0.8 rounded-full border text-[10px] font-mono transition-all flex items-center gap-1 backdrop-blur-md shadow-md hover:scale-105 ${
            activeDimension === "execution"
              ? "bg-[#10B981]/30 border-[#10B981] text-[#10B981] ring-2 ring-[#10B981]/40 font-bold scale-105"
              : "bg-black/50 border-white/10 text-white/70 hover:text-white hover:border-[#10B981]/60"
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-ping" />
          <span>🛠️ 工作习惯</span>
          <span className="opacity-60">({ruleStats.execution})</span>
        </button>

        <button
          onClick={() => onSelectDimension("project")}
          className={`absolute top-[72%] left-[14%] pointer-events-auto px-2 py-0.8 rounded-full border text-[10px] font-mono transition-all flex items-center gap-1 backdrop-blur-md shadow-md hover:scale-105 ${
            activeDimension === "project"
              ? "bg-[#8B5CF6]/30 border-[#8B5CF6] text-[#8B5CF6] ring-2 ring-[#8B5CF6]/40 font-bold scale-105"
              : "bg-black/50 border-white/10 text-white/70 hover:text-white hover:border-[#8B5CF6]/60"
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6] animate-ping" />
          <span>🎯 项目专属</span>
          <span className="opacity-60">({ruleStats.project})</span>
        </button>
      </div>

      {/* Top Floating Holographic Growth & Level HUD */}
      <div className="relative z-20 p-2 sm:p-3.5 flex items-center justify-between pointer-events-none gap-1 sm:gap-2 flex-nowrap overflow-hidden">
        {/* Left Side: Avatar Identity Pill & Evolution Level Pill */}
        <div className="flex items-center gap-1.5 sm:gap-2 pointer-events-auto shrink-0">
          {/* Avatar Identity Hologram Pill */}
          <button
            onClick={onOpenAvatarCustomizer}
            className="flex items-center gap-1.5 sm:gap-2 bg-black/70 hover:bg-black/90 backdrop-blur-xl px-2 sm:px-3 py-1 rounded-full border border-white/20 shadow-xl cursor-pointer transition-all hover:scale-102 group text-left"
            style={{
              borderColor: avatarSettings?.theme_color ? `${avatarSettings.theme_color}60` : undefined,
            }}
            title="点击定制或重塑数字孪生形象"
          >
            <CartoonAvatarGraphic
              presetId={avatarSettings?.preset_id || "geek_male"}
              customPhotoUrl={avatarSettings?.avatar_url || avatarSettings?.custom_photo_url}
              size={20}
              themeColor={avatarSettings?.theme_color || "#8B5CF6"}
              showGlow={false}
            />
            <div className="flex items-center gap-1 text-[11px]">
              <span className="font-bold text-white tracking-tight truncate max-w-[80px] sm:max-w-[120px]">
                {avatarSettings?.nickname || "极客孪生"}
              </span>
              <span className="text-[10px] text-white/60 font-mono hidden sm:inline">
                {avatarSettings?.gender === "female" ? "👧" : avatarSettings?.gender === "agent" ? "🤖" : "👦"}
              </span>
              <span className="text-[10px] text-white/40 group-hover:text-white transition-colors">
                🎨
              </span>
            </div>
          </button>

          {/* Level & Evolution Status Pill */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 bg-black/65 backdrop-blur-xl px-2.5 sm:px-3.5 py-1 sm:py-1.5 rounded-full border border-white/15 shadow-xl shrink-0">
            <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-[#10B981] animate-ping" />
            <div className="flex items-center gap-1.5 sm:gap-2 text-[11px] sm:text-xs">
              <span className="font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#F59E0B] via-[#EC4899] to-[#8B5CF6] font-mono tracking-wide">
                Lv.{evolutionLevel} <span className="hidden sm:inline">· {evolutionStage}</span>
              </span>
              <span className="text-[10px] text-white/50 font-mono hidden md:inline">
                EXP {evolutionExp}/1000
              </span>
            </div>
          </div>
        </div>

        {/* Action Controls: Voice, Spark Evolution, Avatar & Rotation */}
        <div className="flex items-center gap-1 sm:gap-1.5 pointer-events-auto shrink-0">
          {onOpenAvatarCustomizer && (
            <button
              onClick={onOpenAvatarCustomizer}
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-mono font-medium transition-all backdrop-blur-md border bg-purple-950/40 border-purple-500/40 text-purple-300 hover:bg-purple-900/60 hover:text-white flex items-center gap-1 shadow-md"
              title="定制或重塑数字孪生形象"
            >
              <span>🎨</span>
              <span className="hidden sm:inline">重塑形象</span>
            </button>
          )}

          {/* Voice Toggle */}
          <button
            onClick={() => {
              const next = !isVoiceEnabled;
              setIsVoiceEnabled(next);
              if (next) speakPhrase("数字孪生拟态语音已激活");
            }}
            className={`px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all backdrop-blur-md border flex items-center gap-1 ${
              isVoiceEnabled
                ? "bg-[#10B981]/25 text-[#10B981] border-[#10B981]/40 shadow-xs"
                : "bg-black/50 text-white/50 border-white/10 hover:text-white"
            }`}
            title="切换 3D 数字人语音播报"
          >
            <span>{isVoiceEnabled ? "🔊" : "🔇"}</span>
            <span className="hidden sm:inline">{isVoiceEnabled ? "语音" : "静音"}</span>
          </button>

          {onSparkEvolution && (
            <button
              onClick={() => {
                pulseIntensityRef.current = 2.8;
                nodProgressRef.current = 1.0;
                onSparkEvolution();
              }}
              title="激发今日心智进化共鸣"
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all backdrop-blur-md border bg-gradient-to-r from-[#F59E0B]/20 to-[#EC4899]/20 hover:from-[#F59E0B]/35 hover:to-[#EC4899]/35 text-[#F59E0B] border-[#F59E0B]/40 hover:scale-102 flex items-center gap-1 shadow-md"
            >
              <span>⚡</span>
              <span className="hidden sm:inline">共鸣</span>
            </button>
          )}

          <button
            onClick={() => setIsRotating((v) => !v)}
            className={`px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all backdrop-blur-md border flex items-center gap-1 ${
              isRotating
                ? "bg-[#A855F7]/30 text-[#C084FC] border-[#A855F7]/50"
                : "bg-black/50 text-white/70 border-white/10 hover:bg-black/70 hover:text-white"
            }`}
            title="切换视角自转"
          >
            <span>🔄</span>
            <span className="hidden sm:inline">{isRotating ? "自转中" : "自转"}</span>
          </button>

          {/* 视角切换按钮：默认全身全貌 / 半身特写 */}
          <button
            onClick={() => {
              const nextMode = viewMode === "full" ? "close" : "full";
              setViewMode(nextMode);
              if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("memento:set-cam-view", { detail: nextMode }));
              }
            }}
            className={`px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all backdrop-blur-md border flex items-center gap-1 ${
              viewMode === "close"
                ? "bg-[#3B82F6]/30 text-[#93C5FD] border-[#3B82F6]/50 shadow-xs"
                : "bg-black/50 text-white/70 border-white/10 hover:bg-black/70 hover:text-white"
            }`}
            title={viewMode === "full" ? "切换为半身近景特写" : "切换回默认全身全貌（双击画面亦可快速切换）"}
          >
            <span>{viewMode === "full" ? "🧍" : "👤"}</span>
            <span className="hidden sm:inline">{viewMode === "full" ? "全身" : "特写"}</span>
          </button>

          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="px-2 sm:px-2.5 py-1 rounded-xl text-[11px] font-semibold bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 text-white flex items-center gap-1 shadow-md transition-all active:scale-95"
              title={isPanelCollapsed ? "打开右侧管理面板" : "让 3D 数字人铺满整屏"}
            >
              <span>{isPanelCollapsed ? "⧉" : "⛶"}</span>
              <span className="hidden sm:inline">{isPanelCollapsed ? "打开侧边面板" : "3D 铺满整屏"}</span>
            </button>
          )}

          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-1 rounded-xl text-white/80 bg-black/65 hover:bg-black/90 backdrop-blur-md border border-white/20 hover:text-white shadow-md transition-all"
              title="显示器物理全屏"
            >
              <Icon name="command" size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Center Dynamic Holographic Synapse Activation Banner */}
      {hudSynapse && (
        <div className="relative z-30 self-center pointer-events-none px-4 animate-in fade-in zoom-in-95 duration-200">
          <div
            className={`backdrop-blur-xl px-4 py-2.5 rounded-2xl border shadow-[0_0_35px_rgba(239,68,68,0.5)] flex items-center gap-2.5 max-w-[420px] ${
              hudSynapse.complianceStatus === "intercepted"
                ? "bg-[#EF4444]/20 border-[#EF4444] text-white"
                : "bg-black/85 border-[var(--aurora-accent)] text-white"
            }`}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full animate-ping shrink-0 ${
                hudSynapse.complianceStatus === "intercepted" ? "bg-[#EF4444]" : "bg-[var(--aurora-accent)]"
              }`}
            />
            <div className="flex flex-col min-w-0">
              <span
                className={`text-[10px] font-bold tracking-wider flex items-center gap-1.5 ${
                  hudSynapse.complianceStatus === "intercepted" ? "text-[#EF4444]" : "text-[var(--aurora-accent)]"
                }`}
              >
                <span>
                  {hudSynapse.complianceStatus === "intercepted"
                    ? "🛡️ P0 绝对红线已生效拦截"
                    : "⚡ 神经突触实时共鸣"}
                </span>
                <span className="text-white/40 font-normal">· 已沉淀至长时记忆</span>
              </span>
              <span className="text-xs text-white/95 truncate font-medium mt-0.5">
                {hudSynapse.text}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Holographic Dimension Floating Dock with Trait Gesture Badges */}
      <div className="relative z-20 pb-3 px-3 flex justify-center pointer-events-auto">
        <div className="bg-black/65 backdrop-blur-xl border border-white/10 rounded-2xl p-1 shadow-2xl flex items-center gap-1 overflow-x-auto scrollbar-none max-w-full">
          <button
            onClick={() => onSelectDimension("all")}
            className={`px-3 py-1.2 rounded-xl text-xs font-medium transition-all shrink-0 border ${
              activeDimension === "all"
                ? "bg-[#8B5CF6] text-white border-[#8B5CF6] shadow-md font-semibold"
                : "border-transparent text-white/70 hover:text-white hover:bg-white/10"
            }`}
          >
            🌐 全景
          </button>

          {DIMENSIONS_CONFIG.map((dim) => {
            const isSelected = activeDimension === dim.id;
            return (
              <button
                key={dim.id}
                onClick={() => onSelectDimension(dim.id)}
                className={`px-2.5 py-1.2 rounded-xl text-xs font-medium transition-all shrink-0 border flex items-center gap-1.5 ${
                  isSelected
                    ? "text-white shadow-md font-semibold scale-102"
                    : "border-transparent text-white/70 hover:text-white hover:bg-white/10"
                }`}
                style={{
                  backgroundColor: isSelected ? dim.color : undefined,
                  borderColor: isSelected ? dim.color : undefined,
                }}
              >
                <span>{dim.shortLabel}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/35 font-mono font-bold">
                  {dim.count}
                </span>
                {isSelected && (
                  <span className="text-[9px] font-medium opacity-80 border-l border-white/20 pl-1 hidden sm:inline">
                    {dim.gestureHint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
