import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import App from "./App";
import "./index.css";
// Installs the Trusted Types policies before React's first commit so the
// default policy is in place when library-owned HTML sinks (e.g. Radix
// ScrollArea/Select <style> tags) fire under the packaged app's
// `require-trusted-types-for 'script'` CSP.
import "@/lib/trusted-types";
import { installLaunchTokenFetch } from "@/lib/launch-token";

// Attach the per-launch API token (injected into the served HTML) to every
// same-origin /api fetch before any app code can issue one.
installLaunchTokenFetch();

createRoot(document.getElementById("root")!).render(<App />);
