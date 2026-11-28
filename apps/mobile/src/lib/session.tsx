import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, type AppStateStatus, Linking, Platform, Settings } from "react-native";

import { ApiError } from "./api";
import { isPairingDeepLink, subscribePairingDeepLink } from "./deeplink";
import { registerForPushNotificationsAsync, syncPushTokenToServer, unregisterPushTokenFromServer } from "./notifications";
import {
  claimPairingCode,
  parsePairingUrl,
  resolveBestStandaloneRoute,
  type RouteMode,
  type StandaloneProfile,
} from "./standalone-route";

export const DEFAULT_SERVER = "https://mem.ihasy.com";
const SERVER_KEY = "memento.server";
const TOKEN_KEY = "memento.token";
const PUSH_TOKEN_KEY = "memento.push_token";
const STANDALONE_PROFILE_KEY = "memento.standalone_profile";
export const SNAPSHOT_CONVOS_KEY = "memento.snapshot.conversations";
export const SNAPSHOT_TODOS_KEY = "memento.snapshot.todos";

export async function saveLocalSnapshot(key: string, data: unknown): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, JSON.stringify(data));
  } catch (e) {
    console.warn("Failed to save local snapshot:", e);
  }
}

export async function loadLocalSnapshot<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (e) {
    console.warn("Failed to load local snapshot:", e);
    return null;
  }
}

function syncCredentialsToNative(apiBase: string, token: string | null) {
  if (Platform.OS === "ios") {
    try {
      Settings.set({
        memento_server: (apiBase.trim() || DEFAULT_SERVER).replace(/\/+$/, ""),
        memento_token: token || "",
      });
    } catch (e) {
      console.warn("Failed to sync credentials to iOS UserDefaults:", e);
    }
  }
}

interface Session {
  ready: boolean;
  /** Web origin loaded in WebView (equals apiBase for cloud/LAN/Tailscale, or uiOrigin for blind relay). */
  server: string;
  /** Active API endpoint (cloud, LAN, Tailscale, or stateless blind relay `/api/relay/t/<id>`). */
  apiBase: string;
  /** Non-null only when running over stateless blind relay (injected into WebView localStorage). */
  customApiBase: string | null;
  routeMode: RouteMode;
  standaloneProfile: StandaloneProfile | null;
  pairingBusy: boolean;
  pairingError: string | null;
  token: string | null;
  signIn(server: string, email: string, password: string): Promise<void>;
  signInWithToken(server: string, token: string): Promise<void>;
  pairFromUrl(rawUrl: string): Promise<void>;
  reprobeRoute(): Promise<void>;
  signOut(): Promise<void>;
  switchServer(server: string, resetAuth?: boolean): Promise<void>;
  deleteAccount(confirmation: string): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

/** The signed-in user's server, standalone multi-route profile and JWT, kept in the device keychain. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [apiBase, setApiBase] = useState(DEFAULT_SERVER);
  const [customApiBase, setCustomApiBase] = useState<string | null>(null);
  const [routeMode, setRouteMode] = useState<RouteMode>("cloud");
  const [standaloneProfile, setStandaloneProfile] = useState<StandaloneProfile | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const handledPairCodesRef = useRef<Set<string>>(new Set());
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const profileRef = useRef<StandaloneProfile | null>(null);
  profileRef.current = standaloneProfile;

  useEffect(() => {
    void (async () => {
      const [s, t, rawProfile] = await Promise.all([
        SecureStore.getItemAsync(SERVER_KEY),
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(STANDALONE_PROFILE_KEY),
      ]);

      let activeWeb = s || DEFAULT_SERVER;
      let activeApi = activeWeb;
      let activeCustom: string | null = null;
      let activeMode: RouteMode = "cloud";
      let parsedProfile: StandaloneProfile | null = null;

      if (rawProfile) {
        try {
          parsedProfile = JSON.parse(rawProfile) as StandaloneProfile;
        } catch {
          parsedProfile = null;
        }
      }

      if (parsedProfile && (parsedProfile.lanUrl || parsedProfile.tsUrl || parsedProfile.relayApiUrl)) {
        setStandaloneProfile(parsedProfile);
        const resolved = await resolveBestStandaloneRoute(parsedProfile);
        activeWeb = resolved.webOrigin;
        activeApi = resolved.apiBase;
        activeCustom = resolved.customApiBase;
        activeMode = resolved.mode;
      }

      setServer(activeWeb);
      setApiBase(activeApi);
      setCustomApiBase(activeCustom);
      setRouteMode(activeMode);

      // Tokens last a day: trade the stored one for a fresh one on each start.
      if (t) {
        try {
          const res = await fetch(`${activeApi}/api/auth/refresh`, { method: "POST", headers: { Authorization: `Bearer ${t}` } });
          if (res.ok) {
            const { access_token } = (await res.json()) as { access_token: string };
            await SecureStore.setItemAsync(TOKEN_KEY, access_token);
            setToken(access_token);
          } else if (res.status === 401) {
            await SecureStore.deleteItemAsync(TOKEN_KEY);
          } else {
            setToken(t);
          }
        } catch {
          setToken(t); // offline: keep it, calls will fail visibly
        }
      }
      setReady(true);
    })();
  }, []);

  const reprobeRoute = useCallback(async () => {
    const profile = profileRef.current;
    if (!profile) return;
    const resolved = await resolveBestStandaloneRoute(profile);
    setServer((prev) => (prev === resolved.webOrigin ? prev : resolved.webOrigin));
    setApiBase((prev) => (prev === resolved.apiBase ? prev : resolved.apiBase));
    setCustomApiBase((prev) => (prev === resolved.customApiBase ? prev : resolved.customApiBase));
    setRouteMode((prev) => (prev === resolved.mode ? prev : resolved.mode));
  }, []);

  // Re-probe fastest standalone channel (LAN <-> Tailscale <-> Relay) whenever app returns to foreground
  useEffect(() => {
    if (!ready || !standaloneProfile || !token) return;
    let lastState = AppState.currentState;
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (lastState !== "active" && nextState === "active") {
        void reprobeRoute();
      }
      lastState = nextState;
    });
    return () => sub.remove();
  }, [ready, standaloneProfile, token, reprobeRoute]);

  // Whenever a valid user token is available, ensure mobile push token is registered to the server
  useEffect(() => {
    if (!ready || !token) return;
    void (async () => {
      try {
        const pushToken = await registerForPushNotificationsAsync();
        if (pushToken) {
          await SecureStore.setItemAsync(PUSH_TOKEN_KEY, pushToken);
          await syncPushTokenToServer(apiBase, token, pushToken);
        }
      } catch (err) {
        console.warn("Mobile push token auto-register failed:", err);
      }
    })();
  }, [ready, apiBase, token]);

  // Whenever apiBase or token changes, keep iOS UserDefaults in sync for native background health/sleep tasks
  useEffect(() => {
    if (!ready) return;
    syncCredentialsToNative(apiBase, token);
  }, [ready, apiBase, token]);

  const pairFromUrl = useCallback(async (rawUrl: string) => {
    const parsed = parsePairingUrl(rawUrl);
    if (!parsed) {
      throw new ApiError("配对链接格式无效，请在电脑端单机模式重新生成二维码", 400);
    }
    setPairingBusy(true);
    setPairingError(null);
    try {
      const { accessToken, route, profile } = await claimPairingCode(parsed.profile, parsed.code);
      await Promise.all([
        SecureStore.setItemAsync(SERVER_KEY, route.webOrigin),
        SecureStore.setItemAsync(TOKEN_KEY, accessToken),
        SecureStore.setItemAsync(STANDALONE_PROFILE_KEY, JSON.stringify(profile)),
      ]);
      syncCredentialsToNative(route.apiBase, accessToken);
      setStandaloneProfile(profile);
      setServer(route.webOrigin);
      setApiBase(route.apiBase);
      setCustomApiBase(route.customApiBase);
      setRouteMode(route.mode);
      setToken(accessToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "连接单机桌面失败";
      setPairingError(msg);
      throw e;
    } finally {
      setPairingBusy(false);
    }
  }, []);

  // Listen globally for native camera QR deep links (`memento://pair?v=1&...`) from any screen
  useEffect(() => {
    const handleIncomingPair = (rawUrl: string) => {
      if (!isPairingDeepLink(rawUrl)) return;
      const parsed = parsePairingUrl(rawUrl);
      if (!parsed) return;
      // Deduplicate against cold-start double delivery (+native-intent + Linking.getInitialURL)
      if (handledPairCodesRef.current.has(parsed.code)) return;
      handledPairCodesRef.current.add(parsed.code);

      const run = () => {
        void pairFromUrl(rawUrl).catch((err) => {
          const msg = err instanceof Error ? err.message : "配对失败";
          Alert.alert("连接单机桌面失败", msg);
        });
      };

      if (tokenRef.current) {
        Alert.alert(
          `连接到「${parsed.profile.deviceName}」？`,
          "将切换到这台电脑的单机版 Memento（同 Wi-Fi 自动局域网直连，出门自动走无状态盲隧道）。",
          [
            { text: "取消", style: "cancel" },
            { text: "连接", onPress: run },
          ],
        );
      } else {
        run();
      }
    };

    const unsub = subscribePairingDeepLink(handleIncomingPair);
    void Linking.getInitialURL().then((url) => {
      if (url) handleIncomingPair(url);
    });
    const linkSub = Linking.addEventListener("url", (event) => {
      if (event?.url) handleIncomingPair(event.url);
    });
    return () => {
      unsub();
      linkSub.remove();
    };
  }, [pairFromUrl]);

  const signOut = useCallback(async () => {
    try {
      const [storedToken, pushTok] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(PUSH_TOKEN_KEY),
      ]);
      if (storedToken && pushTok) {
        await unregisterPushTokenFromServer(apiBase, storedToken, pushTok);
      }
    } catch {
      // ignore network errors on sign out
    }
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(PUSH_TOKEN_KEY),
      SecureStore.deleteItemAsync(STANDALONE_PROFILE_KEY),
    ]);
    syncCredentialsToNative(DEFAULT_SERVER, null);
    setStandaloneProfile(null);
    setCustomApiBase(null);
    setRouteMode("cloud");
    setApiBase(server);
    setToken(null);
  }, [apiBase, server]);

  const signIn = useCallback(async (serverUrl: string, email: string, password: string) => {
    const base = (serverUrl.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new ApiError(res.status === 401 ? "邮箱或密码不对" : data.detail || `登录失败（${res.status}）`, res.status);
    }
    const { access_token } = (await res.json()) as { access_token: string };
    await Promise.all([
      SecureStore.setItemAsync(SERVER_KEY, base),
      SecureStore.setItemAsync(TOKEN_KEY, access_token),
      SecureStore.deleteItemAsync(STANDALONE_PROFILE_KEY),
    ]);
    syncCredentialsToNative(base, access_token);
    setStandaloneProfile(null);
    setCustomApiBase(null);
    setRouteMode("cloud");
    setServer(base);
    setApiBase(base);
    setToken(access_token);
  }, []);

  const signInWithToken = useCallback(async (serverUrl: string, accessToken: string) => {
    const base = (serverUrl.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
    await Promise.all([
      SecureStore.setItemAsync(SERVER_KEY, base),
      SecureStore.setItemAsync(TOKEN_KEY, accessToken),
      SecureStore.deleteItemAsync(STANDALONE_PROFILE_KEY),
    ]);
    syncCredentialsToNative(base, accessToken);
    setStandaloneProfile(null);
    setCustomApiBase(null);
    setRouteMode("cloud");
    setServer(base);
    setApiBase(base);
    setToken(accessToken);
  }, []);

  const switchServer = useCallback(async (newServerUrl: string, resetAuth = true) => {
    const base = (newServerUrl.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
    await SecureStore.deleteItemAsync(STANDALONE_PROFILE_KEY);
    setStandaloneProfile(null);
    setCustomApiBase(null);
    setRouteMode("cloud");
    if (resetAuth) {
      await Promise.all([
        SecureStore.setItemAsync(SERVER_KEY, base),
        SecureStore.deleteItemAsync(TOKEN_KEY),
        SecureStore.deleteItemAsync(PUSH_TOKEN_KEY),
      ]);
      syncCredentialsToNative(base, null);
      setServer(base);
      setApiBase(base);
      setToken(null);
    } else {
      await SecureStore.setItemAsync(SERVER_KEY, base);
      syncCredentialsToNative(base, token);
      setServer(base);
      setApiBase(base);
    }
  }, [token]);

  const deleteAccount = useCallback(async (confirmation: string) => {
    if (!token) throw new ApiError("未登录", 401);
    const res = await fetch(`${apiBase}/api/profile/account`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ confirmation }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new ApiError(data.detail || `注销失败（${res.status}）`, res.status);
    }
    await signOut();
  }, [apiBase, token, signOut]);

  const value = useMemo(
    () => ({
      ready,
      server,
      apiBase,
      customApiBase,
      routeMode,
      standaloneProfile,
      pairingBusy,
      pairingError,
      token,
      signIn,
      signInWithToken,
      pairFromUrl,
      reprobeRoute,
      signOut,
      switchServer,
      deleteAccount,
    }),
    [
      ready,
      server,
      apiBase,
      customApiBase,
      routeMode,
      standaloneProfile,
      pairingBusy,
      pairingError,
      token,
      signIn,
      signInWithToken,
      pairFromUrl,
      reprobeRoute,
      signOut,
      switchServer,
      deleteAccount,
    ],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
