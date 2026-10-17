import * as Clipboard from "expo-clipboard";
import { Redirect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Linking, Platform, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";

import { Button, Note } from "../components/ui";
import { describeError } from "../lib/api";
import { DEFAULT_SERVER, useSession } from "../lib/session";
import { radius, useTheme } from "../lib/theme";

function Mark() {
  return (
    <Svg width={64} height={64} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7C3AED" />
          <Stop offset="0.55" stopColor="#EC4899" />
          <Stop offset="1" stopColor="#06B6D4" />
        </LinearGradient>
        <RadialGradient id="c" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.95} />
          <Stop offset="0.6" stopColor="#ffffff" stopOpacity={0.4} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={2} y={2} width={60} height={60} rx={16} fill="url(#g)" />
      <Circle cx={32} cy={32} r={14} fill="url(#c)" />
      <Circle cx={32} cy={32} r={5} fill="#ffffff" />
    </Svg>
  );
}

function WechatMark({ size = 18, color = "#07C160" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M8.5 2C4.36 2 1 4.91 1 8.5c0 2.03 1.05 3.86 2.69 5.09-.13.56-.63 1.95-.69 2.15-.08.26.1.25.21.18.9-.55 2.1-1.32 2.65-1.68.85.25 1.76.38 2.64.38.16 0 .32 0 .48-.01-.29-.75-.48-1.57-.48-2.43 0-3.69 3.58-6.68 8-6.68.27 0 .54.01.81.04C16.32 4.3 12.72 2 8.5 2zm-2.25 4.5c.69 0 1.25.56 1.25 1.25S6.94 9 6.25 9 5 8.44 5 7.75 5.56 6.5 6.25 6.5zm5 0c.69 0 1.25.56 1.25 1.25S11.94 9 11.25 9 10 8.44 10 7.75s.56-1.25 1.25-1.25zM16 9.5c-3.59 0-6.5 2.46-6.5 5.5s2.91 5.5 6.5 5.5c.74 0 1.45-.11 2.11-.31.45.31 1.45.94 2.18 1.39.09.05.24.06.17-.15-.05-.16-.46-1.3-.56-1.76 1.36-1.02 2.1-2.45 2.1-4.17 0-3.04-2.91-5.5-6.5-5.5zm-2 3.5c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm4 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1z" />
    </Svg>
  );
}

export default function LoginScreen() {
  const t = useTheme();
  const { token, signIn, signInWithToken, server: savedServer } = useSession();
  const [server, setServer] = useState(savedServer || DEFAULT_SERVER);
  const [authTab, setAuthTab] = useState<"wechat" | "password">("wechat");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showServer, setShowServer] = useState(false);

  // WeChat login state
  const [ticket, setTicket] = useState<string>("");
  const [ticketLoading, setTicketLoading] = useState<boolean>(false);
  const [ticketStatus, setTicketStatus] = useState<"pending" | "success" | "expired" | "error">("pending");
  const [countdown, setCountdown] = useState<number>(300);
  const completedRef = useRef<boolean>(false);
  const fetchingRef = useRef<boolean>(false);

  const baseServer = (server.trim() || DEFAULT_SERVER).replace(/\/+$/, "");

  // Fetch ticket
  const fetchNewTicket = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      setTicketLoading(true);
      setError(null);
      setTicketStatus("pending");
      setCountdown(300);
      completedRef.current = false;
      const res = await fetch(`${baseServer}/api/auth/wechat/ticket`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error("获取口令失败");
      const data = (await res.json()) as { ticket: string };
      setTicket(data.ticket);
    } catch {
      setError("获取登录口令失败，请检查网络或点击刷新");
      setTicketStatus("error");
    } finally {
      setTicketLoading(false);
      fetchingRef.current = false;
    }
  }, [baseServer]);

  // Initial fetch on mount or tab change
  useEffect(() => {
    if (authTab === "wechat") {
      void fetchNewTicket();
    }
  }, [authTab, fetchNewTicket]);

  // Countdown timer
  useEffect(() => {
    if (authTab !== "wechat" || ticketStatus !== "pending") return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setTicketStatus("expired");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [authTab, ticketStatus]);

  // Poll ticket status
  const checkPoll = useCallback(async () => {
    if (!ticket || ticketStatus !== "pending" || completedRef.current || authTab !== "wechat") return;
    try {
      const res = await fetch(`${baseServer}/api/auth/wechat/poll?ticket=${encodeURIComponent(ticket)}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = (await res.json()) as { status: string; access_token?: string; detail?: string };
      if (data.status === "success" && data.access_token) {
        completedRef.current = true;
        setTicketStatus("success");
        await signInWithToken(baseServer, data.access_token);
      } else if (data.status === "expired" || data.status === "not_found") {
        setTicketStatus("expired");
      } else if (data.status === "account_disabled" || data.status === "registration_closed") {
        setTicketStatus("error");
        setError(data.detail || "登录受限");
      }
    } catch {
      // network blip — keep polling
    }
  }, [ticket, ticketStatus, authTab, baseServer, signInWithToken]);

  // Polling interval
  useEffect(() => {
    if (authTab !== "wechat" || ticketStatus !== "pending" || !ticket) return;
    const interval = setInterval(checkPoll, 1000);
    return () => clearInterval(interval);
  }, [authTab, ticketStatus, ticket, checkPoll]);

  // Instant poll when user returns to App from WeChat
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && authTab === "wechat") {
        void checkPoll();
      }
    });
    return () => sub.remove();
  }, [authTab, checkPoll]);

  const [copied, setCopied] = useState<boolean>(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyToClipboard = useCallback(async (textToCopy: string, andOpenWeChat = false) => {
    if (!textToCopy) return;
    try {
      await Clipboard.setStringAsync(textToCopy);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 3500);
    } catch {
      // ignore
    }
    if (andOpenWeChat) {
      void Linking.openURL("weixin://").catch(() => {
        setError("无法唤起微信，请确保手机已安装微信客户端");
      });
    }
  }, []);

  const handleOpenWeChat = () => {
    void copyToClipboard(ticket, true);
  };

  if (token) return <Redirect href="/" />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(server, email, password);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const field = { fontSize: 15, color: t.fg1, backgroundColor: t.surface, borderRadius: radius.control, borderWidth: 1, borderColor: t.border, paddingHorizontal: 12, paddingVertical: 12 } as const;

  const minutes = Math.floor(countdown / 60);
  const seconds = countdown % 60;
  const timeFormatted = `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView style={{ flex: 1, justifyContent: "center", padding: 24 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ alignItems: "center", marginBottom: 20, gap: 8 }}>
          <Mark />
          <Text style={{ fontSize: 26, fontWeight: "700", color: t.fg1 }}>Memento</Text>
          <Text style={{ fontSize: 13.5, color: t.fg3 }}>你的 AI 外脑，随身带着</Text>
        </View>

        {error && <Note>{error}</Note>}

        <View style={{ width: "100%", maxWidth: 400, alignSelf: "center", gap: 14 }}>
          {/* Tab Switcher */}
          <View style={{ flexDirection: "row", backgroundColor: t.surface, borderRadius: radius.control, padding: 3, borderWidth: 1, borderColor: t.border }}>
            <Pressable
              onPress={() => setAuthTab("wechat")}
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                paddingVertical: 8,
                borderRadius: radius.control - 2,
                backgroundColor: authTab === "wechat" ? t.bg : "transparent",
              }}
            >
              <WechatMark size={16} color={authTab === "wechat" ? "#07C160" : t.fg3} />
              <Text style={{ fontSize: 13, fontWeight: authTab === "wechat" ? "600" : "400", color: authTab === "wechat" ? t.fg1 : t.fg3 }}>
                微信登录
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setAuthTab("password")}
              style={{
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: 8,
                borderRadius: radius.control - 2,
                backgroundColor: authTab === "password" ? t.bg : "transparent",
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: authTab === "password" ? "600" : "400", color: authTab === "password" ? t.fg1 : t.fg3 }}>
                密码登录
              </Text>
            </Pressable>
          </View>

          {/* WeChat Login Tab Content */}
          {authTab === "wechat" ? (
            <View style={{ gap: 12 }}>
              {/* Passcode Box */}
              <Pressable
                onPress={() => void copyToClipboard(ticket)}
                style={({ pressed }) => ({
                  backgroundColor: t.surface,
                  borderWidth: 1.5,
                  borderColor: copied ? "#07C160" : t.border,
                  borderRadius: radius.control,
                  padding: 18,
                  alignItems: "center",
                  gap: 8,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                  <Text style={{ fontSize: 11, color: t.fg3, fontWeight: "600", letterSpacing: 0.5 }}>登录口令</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {copied ? (
                      <Text style={{ fontSize: 11, color: "#07C160", fontWeight: "600" }}>✓ 已复制到剪贴板</Text>
                    ) : (
                      <Text style={{ fontSize: 11, color: t.accent }}>轻触可直接复制</Text>
                    )}
                    <Text style={{ fontSize: 11, color: t.fg3 }}>
                      {ticketStatus === "pending" && !ticketLoading ? ` · ${timeFormatted}` : ""}
                    </Text>
                  </View>
                </View>

                <Text
                  selectable
                  style={{
                    fontSize: 34,
                    fontWeight: "700",
                    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                    color: ticketStatus === "expired" ? t.fg4 : copied ? "#07C160" : t.accent,
                    letterSpacing: 5,
                    paddingVertical: 4,
                  }}
                >
                  {ticketLoading ? "••••••" : ticket ? ticket.split("").join(" ") : "------"}
                </Text>

                {ticketStatus === "expired" && (
                  <Button variant="ghost" small onPress={fetchNewTicket}>
                    口令已过期，点击刷新
                  </Button>
                )}
              </Pressable>

              {/* Action Buttons: Copy & Open WeChat */}
              {ticketStatus === "pending" && (
                <View style={{ gap: 8 }}>
                  <Pressable
                    onPress={handleOpenWeChat}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      backgroundColor: "#07C160",
                      borderRadius: radius.control,
                      paddingVertical: 13,
                      opacity: pressed ? 0.85 : 1,
                    })}
                  >
                    <WechatMark size={20} color="#ffffff" />
                    <Text style={{ color: "#ffffff", fontSize: 15, fontWeight: "600" }}>
                      {copied ? "口令已复制，前往微信粘贴" : "复制口令并打开微信"}
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => void copyToClipboard(ticket)}
                    style={({ pressed }) => ({
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: 6,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <Text style={{ fontSize: 12.5, color: copied ? "#07C160" : t.fg3 }}>
                      {copied ? "口令已就绪，直接在公众号粘贴发送即可" : "不想跳转？点击仅复制 6 位口令"}
                    </Text>
                  </Pressable>
                </View>
              )}

              {/* Guide steps */}
              <View style={{ backgroundColor: t.surface, borderRadius: radius.control, padding: 14, borderWidth: 1, borderColor: t.border, gap: 8 }}>
                <Text style={{ fontSize: 12, color: t.fg2, lineHeight: 18 }}>
                  1. 微信关注公众号「<Text style={{ fontWeight: "700", color: t.fg1 }}>深度部署</Text>」
                </Text>
                <Text style={{ fontSize: 12, color: t.fg2, lineHeight: 18 }}>
                  2. 点击上方按钮前往微信，<Text style={{ fontWeight: "700", color: "#07C160" }}>口令已自动写入剪贴板</Text>，在公众号中直接<Text style={{ fontWeight: "600", color: t.fg1 }}>长按粘贴发送</Text>
                </Text>
                <Text style={{ fontSize: 12, color: t.fg2, lineHeight: 18 }}>
                  3. 发送后切回本应用，系统将<Text style={{ fontWeight: "700", color: t.accent }}>自动秒级完成登录</Text>
                </Text>
              </View>
            </View>
          ) : (
            /* Password Login Tab Content */
            <View style={{ gap: 10 }}>
              <TextInput value={email} onChangeText={setEmail} placeholder="邮箱" placeholderTextColor={t.fg4} autoCapitalize="none" keyboardType="email-address" autoComplete="email" style={field} />
              <TextInput value={password} onChangeText={setPassword} placeholder="密码" placeholderTextColor={t.fg4} secureTextEntry autoComplete="password" onSubmitEditing={submit} style={field} />
              <Button onPress={submit} busy={busy} disabled={!email.trim() || !password}>
                登录
              </Button>
            </View>
          )}

          {showServer && (
            <TextInput value={server} onChangeText={setServer} placeholder={DEFAULT_SERVER} placeholderTextColor={t.fg4} autoCapitalize="none" keyboardType="url" style={field} />
          )}

          <View style={{ flexDirection: "row", justifyContent: "center", gap: 20, marginTop: 4 }}>
            <Text onPress={() => void Linking.openURL(`${baseServer}/auth/register`)} style={{ fontSize: 13, color: t.accent }}>
              注册账号
            </Text>
            <Text onPress={() => setShowServer((v) => !v)} style={{ fontSize: 13, color: t.fg3 }}>
              {showServer ? "收起服务器地址" : "自建服务器？"}
            </Text>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
