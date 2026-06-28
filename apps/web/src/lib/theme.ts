import { useEffect, useState } from "react";

// Single source of truth for theme. The first-paint class is set by
// the inline script in index.html so there's no flash; this hook
// keeps React in sync with the class + persists explicit user choices
// to localStorage under the key "theme" ("light" | "dark"). Default is
// dark; "light" opts out.

export type Theme = "light" | "dark";

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // localStorage disabled (private mode etc.) — no-op, still works in-session.
    }
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  };
}
