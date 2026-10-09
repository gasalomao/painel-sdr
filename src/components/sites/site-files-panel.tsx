"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { FileCode2, Lock, Redo2, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { editableFile } from "@/lib/sites/ui-helpers";
import { useSiteDraft } from "@/lib/sites/ui";
import type { WebsiteFiles, WebsiteRevision } from "@/lib/sites/types";
import { apiJson, ApiError, errorMessage, jsonBody } from "./api";
import { DownloadZipButton } from "./download-zip-button";

const MAX_HISTORY = 100;

function filesEqual(a: WebsiteFiles, b: WebsiteFiles): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export function SiteFilesPanel({ draftScope, projectId, files, currentRevisionId, onSaved, onDirtyChange, onMutationStart, onMutationEnd, disabled }: {
  draftScope: string; projectId: string; files: WebsiteFiles; currentRevisionId: string | null;
  onSaved: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; disabled: boolean;
  onMutationStart: () => boolean; onMutationEnd: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState("src/App.tsx");
  const [draft, setDraft] = useSiteDraft(draftScope, "files");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(Boolean(draft && draft.revisionId !== currentRevisionId));
  const [undoStack, setUndoStack] = useState<WebsiteFiles[]>([]);
  const [redoStack, setRedoStack] = useState<WebsiteFiles[]>([]);
  const lastEditRef = useRef({ path: "", at: 0 });
  const prevFilesRef = useRef(files);
  useEffect(() => {
    const previous = prevFilesRef.current;
    if (previous === files) return;
    prevFilesRef.current = files;
    if (!filesEqual(previous, files)) setUndoStack((prev) => [...prev, previous].slice(-MAX_HISTORY));
  }, [files]);
  const snapshot = draft?.files ?? files;
  const paths = Object.keys(snapshot).sort();
  const path = Object.hasOwn(snapshot, selected) ? selected : paths[0];
  const content = snapshot[path] ?? "";
  const canEdit = path && editableFile(path, files[path] ?? content);

  function edit(value: string): void {
    const current = draft?.files ?? files;
    const now = Date.now();
    const coalesce = lastEditRef.current.path === path && now - lastEditRef.current.at < 1000;
    lastEditRef.current = { path, at: now };
    setUndoStack((prev) => (coalesce ? prev : [...prev, current].slice(-MAX_HISTORY)));
    setRedoStack([]);
    onDirtyChange(true);
    setDraft({ revisionId: draft ? draft.revisionId : currentRevisionId, files: { ...current, [path]: value } });
  }

  function undo(): void {
    if (saving || disabled || undoStack.length === 0) return;
    const current = draft?.files ?? files;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [current, ...prev].slice(0, MAX_HISTORY));
    lastEditRef.current = { path: "", at: 0 };
    if (filesEqual(previous, files)) { setDraft(null); onDirtyChange(false); }
    else { setDraft({ revisionId: draft ? draft.revisionId : currentRevisionId, files: previous }); onDirtyChange(true); }
  }

  function redo(): void {
    if (saving || disabled || redoStack.length === 0) return;
    const current = draft?.files ?? files;
    const next = redoStack[0];
    setRedoStack((prev) => prev.slice(1));
    setUndoStack((prev) => [...prev, current].slice(-MAX_HISTORY));
    lastEditRef.current = { path: "", at: 0 };
    if (filesEqual(next, files)) { setDraft(null); onDirtyChange(false); }
    else { setDraft({ revisionId: draft ? draft.revisionId : currentRevisionId, files: next }); onDirtyChange(true); }
  }

  function shortcuts(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
    else if ((key === "z" && event.shiftKey) || key === "y") { event.preventDefault(); redo(); }
  }

  async function save(): Promise<void> {
    if (!draft || saving || disabled) return;
    if (Object.entries(draft.files).some(([key, value]) => value !== files[key] && !editableFile(key, value))) {
      toast.error("Cada arquivo editado deve ter até 100 KB."); return;
    }
    if (!onMutationStart()) return;
    setSaving(true);
    try {
      const saved = await apiJson<{ files: WebsiteFiles; revisions: WebsiteRevision[] }>(`/api/sites/${projectId}/files`, jsonBody({ files: draft.files, expected_revision_id: draft.revisionId }, "PUT"));
      if (!saved.revisions[0]) throw new Error();
      await onSaved();
      setDraft(null); setConflict(false); setUndoStack([]); setRedoStack([]); onDirtyChange(false);
      toast.success("Revisão salva.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      toast.error(errorMessage(error));
    } finally { setSaving(false); onMutationEnd(); }
  }

  async function reload(): Promise<void> {
    if (saving || disabled || (draft && !window.confirm("Descartar suas alterações locais e recarregar os arquivos?")) || !onMutationStart()) return;
    setSaving(true);
    try { await onSaved(); setDraft(null); setConflict(false); setUndoStack([]); setRedoStack([]); onDirtyChange(false); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); onMutationEnd(); }
  }

  return <div className="flex h-full min-h-[440px] min-w-0 flex-col gap-3 p-3">
    {conflict && <p role="alert" className="text-sm text-destructive">A revisão mudou. Suas alterações locais foram preservadas. Copie o conteúdo antes de recarregar.</p>}
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
      <nav aria-label="Arquivos do projeto" className="max-h-40 overflow-auto sm:max-h-none sm:w-44 sm:shrink-0">
        {paths.map((item) => <button key={item} type="button" aria-current={path === item ? "true" : undefined} onClick={() => setSelected(item)} className={`flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-primary ${item === path ? "bg-secondary font-semibold" : "hover:bg-secondary/60"}`}>
          <FileCode2 className="size-3 shrink-0" aria-hidden="true" /><span className="break-all">{item}</span>{!editableFile(item, snapshot[item]) && <Lock aria-label="Somente leitura" className="ml-auto size-3 shrink-0" />}
        </button>)}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <label htmlFor="site-file-content" className="break-all text-xs text-muted-foreground">{path || "Nenhum arquivo"}{draft ? " · Alterações não salvas" : ""}</label>
        <Textarea id="site-file-content" spellCheck={false} value={content} readOnly={!canEdit || disabled || saving} className="min-h-80 flex-1 resize-y font-mono text-xs" onKeyDown={shortcuts} onChange={(event) => edit(event.target.value)} />
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Arquivos .ts, .tsx, .css, .html e .json até 100 KB. Configurações técnicas são somente leitura.</p>
    <div className="flex flex-wrap justify-between gap-2">
      <DownloadZipButton files={snapshot} projectName={projectId} disabled={saving || disabled} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={saving || disabled || undoStack.length === 0} onClick={undo} title="Ctrl+Z"><Undo2 aria-hidden="true" />Desfazer</Button>
        <Button variant="outline" disabled={saving || disabled || redoStack.length === 0} onClick={redo} title="Ctrl+Shift+Z"><Redo2 aria-hidden="true" />Refazer</Button>
        <Button variant="outline" disabled={saving || disabled} onClick={() => void reload()}>Recarregar arquivos</Button>
        <Button disabled={!draft || saving || disabled || conflict} onClick={() => void save()}><Save aria-hidden="true" />{saving ? "Salvando..." : "Salvar revisão"}</Button>
      </div>
    </div>
  </div>;
}
