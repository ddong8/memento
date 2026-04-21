"use client";

import { createContext, useContext } from "react";
import zhCN, { type Translations } from "./zh-CN";
import enUS from "./en-US";

export type Locale = "zh-CN" | "en-US";

export const locales: Record<Locale, { label: string; translations: Translations }> = {
  "zh-CN": { label: "中文", translations: zhCN },
  "en-US": { label: "English", translations: enUS },
};

export const I18nContext = createContext<{
  locale: Locale;
  t: Translations;
  setLocale: (l: Locale) => void;
}>({
  locale: "zh-CN",
  t: zhCN,
  setLocale: () => {},
});

export function useI18n() {
  return useContext(I18nContext);
}

/** Template string interpolation: t("Found {count} results", { count: 5 }) */
export function fmt(template: string, vars: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(`{${key}}`, String(value));
  }
  return result;
}
