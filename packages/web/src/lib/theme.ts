import { useEffect } from "react";
import type { Settings } from "../api";

/** settings.theme to data-theme on <html>; "system" follows prefers-color-scheme. */
export function useTheme(theme: Settings["theme"] | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!theme) return;
    if (theme !== "system") {
      root.setAttribute("data-theme", theme);
      return;
    }
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = () => root.setAttribute("data-theme", mq && !mq.matches ? "light" : "dark");
    apply();
    mq?.addEventListener("change", apply);
    return () => mq?.removeEventListener("change", apply);
  }, [theme]);
}

/** The theme actually shown: "system" resolves through prefers-color-scheme. */
export function effectiveTheme(theme: Settings["theme"] | undefined): "dark" | "light" {
  if (theme === "dark" || theme === "light") return theme;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
