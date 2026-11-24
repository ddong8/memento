// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioComputePanel } from "../src/components/studio/StudioComputePanel";
import { studioApi, type StudioColabAccount, type StudioComputeState } from "../src/lib/studio-api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_COMPUTE: StudioComputeState = {
  status: "offline",
  stage: "空闲待机",
  gpu: "",
  vram_total_gb: 0,
  vram_free_gb: 0,
  comfy_url: "",
  uptime_sec: 0,
  est_cu_used: 0,
  auto_shutdown_in_sec: null,
  error: "",
  logs: [],
};

const BASE_CONFIG = {
  compute_provider: "auto",
  compute_colab_gpus: "G4,A100,H100",
  compute_colab_high_mem: true,
  compute_colab_session: "filmkit",
  compute_models: "h3,h3_ref2va,seedvr2_fp16",
  compute_auto_shutdown_min: 15,
  compute_dual_worker: true,
  compute_gdrive_cache: true,
  compute_hourly_cu_rate: 12,
};

describe("StudioComputePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders real Colab CU balance, 0 burn rate, and mobile overflow-x-hidden guard", async () => {
    const account: StudioColabAccount = {
      cli_installed: true,
      cli_authorized: true,
      balance_cu: 896.56,
      usage_rate_per_hr: 0,
      active_assignments: 0,
      sessions: [],
      checked_at: 1795516000,
      error: "",
    };
    vi.spyOn(studioApi, "computeAccount").mockResolvedValue({
      account,
      compute: BASE_COMPUTE,
      config: BASE_CONFIG,
    });

    await act(async () => {
      root.render(
        <StudioComputePanel
          compute={BASE_COMPUTE}
          account={account}
          onComputeChange={vi.fn()}
          onAccountChange={vi.fn()}
          onNotify={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain("896.56 CU");
    expect(container.textContent).toContain("0.00 CU/时");
    expect(container.textContent).toContain("当前无任何计费中的 Colab 实例");
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper?.className).toContain("overflow-x-hidden");
    expect(wrapper?.className).toContain("max-w-full");
  });

  it("shows orphan cloud session alert and triggers 1-click stop session", async () => {
    const activeAccount: StudioColabAccount = {
      cli_installed: true,
      cli_authorized: true,
      balance_cu: 880.2,
      usage_rate_per_hr: 11.9,
      active_assignments: 1,
      sessions: [
        {
          name: "",
          endpoint: "m-s-orphan99",
          hardware: "G4",
          shape: "High-RAM",
          variant: "GPU",
          status: "ACTIVE",
          raw: "[?] m-s-orphan99 | Hardware: G4 | Shape: High-RAM | Variant: GPU",
        },
      ],
      checked_at: 1795516000,
      error: "",
    };
    const clearedAccount: StudioColabAccount = {
      ...activeAccount,
      usage_rate_per_hr: 0,
      active_assignments: 0,
      sessions: [],
    };
    vi.spyOn(studioApi, "computeAccount").mockResolvedValue({
      account: activeAccount,
      compute: BASE_COMPUTE,
      config: BASE_CONFIG,
    });
    const stopSpy = vi.spyOn(studioApi, "computeStopSession").mockResolvedValue({
      ok: true,
      compute: BASE_COMPUTE,
      account: clearedAccount,
    });
    const onAccountChange = vi.fn();

    await act(async () => {
      root.render(
        <StudioComputePanel
          compute={BASE_COMPUTE}
          account={activeAccount}
          onComputeChange={vi.fn()}
          onAccountChange={onAccountChange}
          onNotify={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain("m-s-orphan99");
    expect(container.textContent).toContain("仍有 1 台计费中的云端实例");

    const stopBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("释放停表")
    );
    expect(stopBtn).toBeTruthy();
    await act(async () => {
      stopBtn?.click();
    });

    expect(stopSpy).toHaveBeenCalledWith({ name: "", endpoint: "m-s-orphan99" });
    expect(onAccountChange).toHaveBeenCalledWith(clearedAccount);
  });
});
