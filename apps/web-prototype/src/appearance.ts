export type ThemeMode = "system" | "light" | "dark";
export type FontScale = "small" | "medium" | "large";
export type FontFamilyId = "system" | "yahei" | "pingfang" | "song";

export interface AppearancePreferences {
  themeMode: ThemeMode;
  accentColor: string;
  fontScale: FontScale;
  fontFamily: FontFamilyId;
}

export const appearanceStorageKey = "ke-team-appearance";

export const defaultAppearance: AppearancePreferences = {
  themeMode: "system",
  accentColor: "#002fa7",
  fontScale: "medium",
  fontFamily: "system",
};

export const accentColorPresets = [
  { label: "海蓝", value: "#002fa7" },
  { label: "靛紫", value: "#6750a4" },
  { label: "青绿", value: "#087f8c" },
  { label: "森林绿", value: "#23825a" },
  { label: "莓红", value: "#b84768" },
  { label: "琥珀", value: "#a56613" },
] as const;

export const fontScaleOptions: { id: FontScale; label: string; scale: number }[] = [
  { id: "small", label: "偏小", scale: 0.92 },
  { id: "medium", label: "标准", scale: 1 },
  { id: "large", label: "偏大", scale: 1.1 },
];

export const fontFamilyOptions: { id: FontFamilyId; label: string; value: string }[] = [
  { id: "system", label: "系统默认", value: 'Inter, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' },
  { id: "yahei", label: "微软雅黑", value: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif' },
  { id: "pingfang", label: "苹方", value: '"PingFang SC", "Microsoft YaHei UI", sans-serif' },
  { id: "song", label: "宋体", value: 'SimSun, "Songti SC", serif' },
];

const isThemeMode = (value: unknown): value is ThemeMode => value === "system" || value === "light" || value === "dark";
const isFontScale = (value: unknown): value is FontScale => value === "small" || value === "medium" || value === "large";
const isFontFamily = (value: unknown): value is FontFamilyId => fontFamilyOptions.some((item) => item.id === value);

function relativeLuminance(hex: string): number {
  const parsed = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const channels = [parsed[0] ?? 0, parsed[1] ?? 0, parsed[2] ?? 0];
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastText(background: string): string {
  const backgroundLuminance = relativeLuminance(background);
  const contrastRatio = (foregroundLuminance: number): number => {
    const lighter = Math.max(backgroundLuminance, foregroundLuminance);
    const darker = Math.min(backgroundLuminance, foregroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const whiteContrast = contrastRatio(1);
  const darkContrast = contrastRatio(relativeLuminance("#101a2b"));
  return darkContrast >= whiteContrast ? "#101a2b" : "#ffffff";
}

function blendWithWhite(hex: string, amount: number): string {
  const parsed = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16)) ?? [];
  const channels = [parsed[0] ?? 0, parsed[1] ?? 0, parsed[2] ?? 0];
  return `#${channels.map((channel) => Math.round(channel * amount + 255 * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
}

export function readAppearancePreferences(): AppearancePreferences {
  if (typeof window === "undefined") return defaultAppearance;
  try {
    const saved = window.localStorage.getItem(appearanceStorageKey);
    if (saved) {
      const value = JSON.parse(saved) as Partial<AppearancePreferences>;
      return {
        themeMode: isThemeMode(value.themeMode) ? value.themeMode : defaultAppearance.themeMode,
        accentColor: typeof value.accentColor === "string" && /^#[\da-f]{6}$/i.test(value.accentColor) ? value.accentColor : defaultAppearance.accentColor,
        fontScale: isFontScale(value.fontScale) ? value.fontScale : defaultAppearance.fontScale,
        fontFamily: isFontFamily(value.fontFamily) ? value.fontFamily : defaultAppearance.fontFamily,
      };
    }
    const legacyTheme = window.localStorage.getItem("ke-team-theme");
    if (legacyTheme === "dark" || legacyTheme === "light") return { ...defaultAppearance, themeMode: legacyTheme };
  } catch {
    return defaultAppearance;
  }
  return defaultAppearance;
}

export function applyAppearance(preferences: AppearancePreferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const darkMode = preferences.themeMode === "dark"
    || (preferences.themeMode === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  root.dataset.theme = darkMode ? "dark" : "light";
  root.style.setProperty("--theme-accent", preferences.accentColor);
  root.style.setProperty("--color-text-on-accent", contrastText(darkMode ? blendWithWhite(preferences.accentColor, 0.56) : preferences.accentColor));
  root.style.setProperty("--font-sans", fontFamilyOptions.find((item) => item.id === preferences.fontFamily)?.value ?? fontFamilyOptions[0]?.value ?? "sans-serif");

  const scale = fontScaleOptions.find((item) => item.id === preferences.fontScale)?.scale ?? 1;
  const sizes: Record<string, number> = {
    "--type-caption": 12,
    "--type-label": 13,
    "--type-table": 13,
    "--type-body": 14,
    "--type-chat": 15,
    "--type-panel-title": 16,
    "--type-section-title": 18,
    "--type-page-title": 24,
    "--type-metric": 24,
    "--line-body": 22,
    "--line-table": 20,
    "--line-chat": 24,
  };
  for (const [name, baseSize] of Object.entries(sizes)) {
    root.style.setProperty(name, `${Math.round(baseSize * scale * 100) / 100}px`);
  }
}
