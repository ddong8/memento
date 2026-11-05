"use client";

import { useCallback, useState } from "react";
import type { DeviceSummary, ProjectSummary } from "@/lib/api-client";
import type { ExecutionMode } from "@/lib/ask/turns";
import type { AgentSessionItem } from "@/lib/ask/sessions";
import { isConcreteDevice, projectPathOn } from "@/lib/ask/devices";

export interface CascadeState {
  device: string;
  projectId: string;
  projectTitle: string;
  sessionId: string;
  cwd: string;
  executionMode: ExecutionMode;
}

export function useDeviceCascade(initialDevice = "auto", initialMode: ExecutionMode = "ai") {
  const [selectedDevice, setSelectedDevice] = useState<string>(initialDevice);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedProjectTitle, setSelectedProjectTitle] = useState<string>("");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(initialMode);
  const [cwd, setCwd] = useState<string>("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sessions, setSessions] = useState<AgentSessionItem[]>([]);

  const handleDeviceChange = useCallback((newDev: string) => {
    setSelectedDevice(newDev);
    // 切换设备立即清空上一设备的项目列表与历史 Agent 会话
    setProjects([]);
    setSelectedProjectId("");
    setSelectedProjectTitle("");
    setSelectedSessionId("");
    setSessions([]);
    setCwd("");
  }, []);

  const handleProjectChange = useCallback((projId: string, projTitle: string, defaultCwd?: string) => {
    setSelectedProjectId(projId);
    setSelectedProjectTitle(projTitle);
    setSelectedSessionId("");
    setSessions([]);
    if (defaultCwd) {
      setCwd(defaultCwd);
    }
  }, []);

  const handleSessionChange = useCallback((sessId: string) => {
    setSelectedSessionId(sessId);
  }, []);

  const getFilteredProjects = useCallback((dev: string, allProjects: ProjectSummary[]) => {
    if (!isConcreteDevice(dev)) return allProjects;
    return allProjects.filter((p) => {
      const hasPath = projectPathOn(p, dev);
      if (hasPath !== undefined) return Boolean(hasPath);
      return true;
    });
  }, []);

  return {
    selectedDevice,
    setSelectedDevice,
    selectedProjectId,
    setSelectedProjectId,
    selectedProjectTitle,
    setSelectedProjectTitle,
    selectedSessionId,
    setSelectedSessionId,
    executionMode,
    setExecutionMode,
    cwd,
    setCwd,
    projects,
    setProjects,
    sessions,
    setSessions,
    handleDeviceChange,
    handleProjectChange,
    handleSessionChange,
    getFilteredProjects,
  };
}
