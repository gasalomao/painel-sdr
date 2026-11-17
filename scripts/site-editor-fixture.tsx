import { createRoot } from "react-dom/client";
import "../src/app/globals.css";
import SitesLayout from "../src/app/sites/layout";
import SiteProjectPage from "../src/app/sites/[projectId]/page";

if (typeof document !== "undefined") {
  document.documentElement.classList.add("dark");
  document.body.className = "font-sans flex flex-col h-[100dvh] overflow-hidden";
}

const target =
  document.getElementById("root") ??
  document.getElementById("app") ??
  (() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
  })();

target.className = "flex flex-1 min-h-0 overflow-hidden";

createRoot(target).render(
  <main className="flex-1 min-w-0 min-h-0 h-full overflow-hidden">
    <SitesLayout>
      <SiteProjectPage />
    </SitesLayout>
  </main>
);
