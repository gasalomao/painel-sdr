import { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { SitePreview } from "../src/components/sites/site-preview";
import { getStarterFiles } from "../src/lib/sites/starter";
import type { WebsiteFiles } from "../src/lib/sites/types";
import "./site-editor-fixture.css";

const source = (title: string): WebsiteFiles => ({
  ...getStarterFiles(),
  "src/App.tsx": `export default function App(){return <main><h1>${title}</h1></main>}`
});

function EditorFixture() {
  const [canonicalFiles] = useState<WebsiteFiles>(source("Revisão salva"));
  const [checkpointFiles, setCheckpointFiles] = useState<WebsiteFiles | null>(null);
  const [localDraft, setLocalDraft] = useState<string>("");
  const [hasLocalEdit, setHasLocalEdit] = useState(false);
  const [allowEditing, setAllowEditing] = useState(true);
  const pollingActive = useRef(true);

  // Simulate polling for checkpoint updates
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const runId = params.get("run_id");
    if (!runId) return;

    const interval = setInterval(async () => {
      if (!pollingActive.current) return;
      try {
        const response = await fetch(`/api/sites/test-project/files?run_id=${runId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.files) {
            // Only update checkpoint if no local edit exists
            if (!hasLocalEdit) {
              setCheckpointFiles(data.files);
              setAllowEditing(false);
            }
          }
        } else if (response.status === 404) {
          // No checkpoint available, clear it and allow editing
          if (!hasLocalEdit) {
            setCheckpointFiles(null);
            setAllowEditing(true);
          }
        }
      } catch (error) {
        // Silent polling failure
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [hasLocalEdit]);

  const handleEdit = (content: string) => {
    setLocalDraft(content);
    setHasLocalEdit(true);
  };

  const handleUpdateState = () => {
    // Trigger state refresh (useful for testing terminal status transitions)
    pollingActive.current = true;
  };

  // Determine what to display
  const displayFiles = hasLocalEdit
    ? { ...canonicalFiles, "src/App.tsx": localDraft }
    : checkpointFiles || canonicalFiles;

  const editorValue = hasLocalEdit ? localDraft : canonicalFiles["src/App.tsx"];
  const editorDisabled = (!hasLocalEdit && !!checkpointFiles) || !allowEditing;
  const publishDisabled = hasLocalEdit || !checkpointFiles;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "12px", borderBottom: "1px solid #ddd", background: "#f8fafc" }}>
        <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Projeto sintético</h1>
      </header>

      <div style={{ flex: 1, display: "flex", gap: "12px", padding: "12px", overflow: "hidden" }}>
        <div style={{ flex: "0 0 400px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", fontWeight: 500, color: "#64748b" }}>
              src/App.tsx
            </label>
            <textarea
              value={editorValue}
              onChange={(e) => handleEdit(e.target.value)}
              disabled={editorDisabled}
              style={{
                width: "100%",
                height: "200px",
                fontFamily: "monospace",
                fontSize: "12px",
                padding: "8px",
                border: "1px solid #cbd5e1",
                borderRadius: "4px",
                background: editorDisabled ? "#f1f5f9" : "#ffffff",
                color: editorDisabled ? "#94a3b8" : "#0f172a"
              }}
              aria-label="src/App.tsx"
            />
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              onClick={handleUpdateState}
              style={{ padding: "6px 12px", fontSize: "13px", borderRadius: "4px", border: "1px solid #cbd5e1", background: "#ffffff", cursor: "pointer" }}
            >
              Atualizar estado
            </button>
            <button
              disabled={publishDisabled}
              style={{
                padding: "6px 12px",
                fontSize: "13px",
                borderRadius: "4px",
                border: "1px solid #cbd5e1",
                background: publishDisabled ? "#f1f5f9" : "#0ea5e9",
                color: publishDisabled ? "#94a3b8" : "#ffffff",
                cursor: publishDisabled ? "not-allowed" : "pointer"
              }}
            >
              Publicar
            </button>
          </div>

          {checkpointFiles && !hasLocalEdit && (
            <div style={{ padding: "8px", background: "#f0f9ff", border: "1px solid #38bdf8", borderRadius: "4px", fontSize: "12px", color: "#0369a1" }}>
              Rascunho confirmado do agente. Salve para promover à revisão.
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <SitePreview files={displayFiles} revisionId="fixture" projectSlug="fixture-editor" />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<EditorFixture />);
