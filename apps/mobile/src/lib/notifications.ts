import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Alert, Linking, Platform } from "react-native";

import { createNotifyDedupe } from "./notify-dedupe";

// Configure how notifications appear when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// Sliding-window deduplication across remote APNs, Expo pushes, feed polling, and bridge (60 seconds)
export const { isRecentlyNotified, markAsNotified } = createNotifyDedupe();

// Automatically record any incoming remote (APNs / Expo) notification
// so that local foreground polling or webview bridge will NEVER double-notify the same content.
if (Platform.OS !== "web") {
  try {
    Notifications.addNotificationReceivedListener((notification) => {
      const c = notification.request.content;
      markAsNotified(c.title, c.body, notification.request.identifier);
    });

    Notifications.addNotificationResponseReceivedListener((response) => {
      const c = response.notification.request.content;
      markAsNotified(c.title, c.body, response.notification.request.identifier);
    });
  } catch (err) {
    console.warn("Failed to attach notification listeners:", err);
  }
}

/**
 * Trigger an immediate native system notification with sound, banner and haptics on device.
 * Uses interruptionLevel: "timeSensitive" so it is shown even when Focus / Do Not Disturb is active.
 */
export async function triggerLocalNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (Platform.OS === "web") return;
  if (isRecentlyNotified(title, body)) {
    return;
  }
  markAsNotified(title, body);
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          allowDisplayInCarPlay: true,
          allowCriticalAlerts: true,
        },
      });
      finalStatus = status;
    }
    if (finalStatus !== "granted") {
      Alert.alert(
        "未开启通知权限",
        "Memento 需要系统通知权限才能在手机顶部弹出提醒横幅。请前往系统设置开启「允许通知」。",
        [
          { text: "去设置", onPress: () => void Linking.openSettings() },
          { text: "取消", style: "cancel" },
        ],
      );
      return;
    }

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Memento 通知",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#7C3AED",
        enableVibrate: true,
        showBadge: true,
      });
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
        badge: 1,
        interruptionLevel: "timeSensitive",
        data: data || {},
        ...(Platform.OS === "android" ? { channelId: "default" } : {}),
      },
      trigger: null,
    });
  } catch (err) {
    console.warn("Failed to trigger local notification:", err);
  }
}

/**
 * Request notification permissions and fetch the Push Token for this device.
 * Prioritizes Expo Push Token, with automatic fallback to native APNs token.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Memento 通知",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#7C3AED",
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
        allowDisplayInCarPlay: true,
        allowCriticalAlerts: true,
      },
    });
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    return null;
  }

  // 1. Try Expo Push Token if EAS projectId is configured
  try {
    const projectId =
      Constants?.expoConfig?.extra?.eas?.projectId ??
      Constants?.easConfig?.projectId;
    if (projectId) {
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
      if (tokenData?.data) {
        return tokenData.data;
      }
    }
  } catch {
    // fallback to native APNs
  }

  // 2. Fallback to native APNs device push token
  try {
    const deviceToken = await Notifications.getDevicePushTokenAsync();
    if (deviceToken?.data) {
      return typeof deviceToken.data === "string"
        ? deviceToken.data
        : JSON.stringify(deviceToken.data);
    }
  } catch (err) {
    console.warn("Native device push token error:", err);
  }

  // 3. Fallback: generate and persist an installation client ID so the server recognizes this connected mobile device
  try {
    let installId = await SecureStore.getItemAsync("memento_client_install_id");
    if (!installId) {
      installId = `client_${Platform.OS}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      await SecureStore.setItemAsync("memento_client_install_id", installId);
    }
    return installId;
  } catch {
    return `client_${Platform.OS}_active`;
  }
}

/**
 * Register this device's push token with the Memento backend.
 */
export async function syncPushTokenToServer(
  server: string,
  authToken: string,
  deviceToken: string,
): Promise<boolean> {
  try {
    const base = server.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/notify/device-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token: deviceToken, platform: Platform.OS }),
    });
    return res.ok;
  } catch (err) {
    console.warn("Failed to sync push token to server:", err);
    return false;
  }
}

/**
 * Unregister this device's push token from the Memento backend upon sign-out.
 */
export async function unregisterPushTokenFromServer(
  server: string,
  authToken: string,
  deviceToken: string,
): Promise<void> {
  try {
    const base = server.replace(/\/+$/, "");
    await fetch(`${base}/api/notify/device-token`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token: deviceToken, platform: Platform.OS }),
    });
  } catch (err) {
    console.warn("Failed to unregister push token:", err);
  }
}
