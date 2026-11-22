import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "katex/dist/katex.min.css";
import "./index.css";

import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import { AuthProvider } from "./hooks/useAuth";
import { applyTheme, storedTheme } from "./lib/theme";

// Applied before the first paint, so the page never flashes the wrong theme.
applyTheme(storedTheme());

createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <App />
  </AuthProvider>,
);
