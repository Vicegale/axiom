import { useAxiom } from "../../data/DataProvider";
import { useActions } from "../../data/useActions";
import { effectiveTheme } from "../../lib/theme";

/** One button that flips between dark and light (the settings page also offers "system"). */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { settings } = useAxiom();
  const actions = useActions();
  const dark = effectiveTheme(settings?.theme) === "dark";
  return (
    <button
      type="button"
      className={className}
      onClick={() => void actions.saveSettings({ theme: dark ? "light" : "dark" })}
    >
      {dark ? "Light theme" : "Dark theme"}
    </button>
  );
}
