import { useSyncExternalStore } from "react";
import catalog from "./messages.json";
export const locales = ["zh-CN", "zh-TW", "en"] as const;
export type Locale = (typeof locales)[number];
type Message = string | { one: string; other: string };
const messages: Record<string, { en: Message; "zh-TW": string }> = catalog;
const key = "sip-gateway.locale";
const listeners = new Set<() => void>();
function supported(value: string | null): value is Locale {
  return locales.includes(value as Locale);
}
function browserLocale(): Locale {
  const language = (
    navigator.languages?.[0] ||
    navigator.language ||
    "en"
  ).toLowerCase();
  return language.startsWith("zh")
    ? language.includes("tw") ||
      language.includes("hk") ||
      language.includes("mo") ||
      language.includes("hant")
      ? "zh-TW"
      : "zh-CN"
    : "en";
}
function initialLocale(): Locale {
  try {
    const value = localStorage.getItem(key);
    if (supported(value)) return value;
  } catch {}
  return browserLocale();
}
let locale: Locale = initialLocale();
document.documentElement.lang = locale;
function notify() {
  document.documentElement.lang = locale;
  listeners.forEach((fn) => fn());
}
export function setLocale(value: Locale) {
  if (!supported(value)) return;
  locale = value;
  try {
    localStorage.setItem(key, value);
  } catch {}
  notify();
}
window.addEventListener("storage", (event) => {
  if (event.key === key || event.key === null) {
    locale = supported(event.newValue) ? event.newValue : initialLocale();
    notify();
  }
});
export function useLocale() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => locale,
  );
}
// State may hold a translated notification from before a language switch.
const canonical = new Map<string, string>();
for (const [source, values] of Object.entries(messages)) {
  for (const value of Object.values(values))
    if (typeof value === "string")
      if (!canonical.has(value)) canonical.set(value, source);
}
export function t(
  source: string,
  params: Record<string, string | number> = {},
): string {
  const id = messages[source] ? source : canonical.get(source) || source;
  let value: Message = locale === "zh-CN" ? id : messages[id]?.[locale] || id;
  if (typeof value !== "string")
    value =
      new Intl.PluralRules(locale).select(Number(params.count)) === "one"
        ? value.one
        : value.other;
  return value.replace(/\{([A-Za-z]+)\}/g, (match, name) => {
    const param = params[name];
    return param === undefined
      ? match
      : typeof param === "number"
        ? new Intl.NumberFormat(locale).format(param)
        : param;
  });
}
export function LanguageSwitcher() {
  const value = useLocale();
  return (
    <label className="language-control">
      <span className="sr-only">{t("语言")}</span>
      <select
        aria-label={t("语言")}
        value={value}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
        <option value="zh-TW" lang="zh-TW">
          繁體中文
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </label>
  );
}
