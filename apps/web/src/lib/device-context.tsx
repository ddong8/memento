"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api } from "./api-client";

interface Device {
  id: string;
  name: string;
  device_id: string;
  last_heartbeat: string | null;
}

interface DeviceState {
  devices: Device[];
  selectedDeviceId: string | null; // null = all devices
  setSelectedDeviceId: (id: string | null) => void;
  deviceParam: string; // URL param string: "" or "&device_id=xxx"
}

const DeviceContext = createContext<DeviceState>({
  devices: [],
  selectedDeviceId: null,
  setSelectedDeviceId: () => {},
  deviceParam: "",
});

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  useEffect(() => {
    // Only fetch if logged in (uses shared api.getDevices() cache & in-flight deduplication)
    const token = localStorage.getItem("dr_token");
    if (token) {
      api
        .getDevices()
        .then((list) => setDevices(Array.isArray(list) ? list : []))
        .catch(() => {});
    }
  }, []);

  const handleSelect = (id: string | null) => {
    setSelectedDeviceId(id);
    localStorage.setItem("dr_device_id", id || "all");
  };

  const deviceParam = selectedDeviceId ? `&device_id=${selectedDeviceId}` : "";

  return (
    <DeviceContext.Provider value={{ devices, selectedDeviceId, setSelectedDeviceId: handleSelect, deviceParam }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice() {
  return useContext(DeviceContext);
}
