"use client";

import { useEffect, useMemo, useState } from "react";
import { FileCode2, Loader2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DownloadZipButton } from "@/components/sites/download-zip-button";
import type { WebsiteFiles } from "@/lib/sites/types";

interface FileChange {
  path: string;
  content: string;
  timestamp: number;
  isNew: boolean;
}

/**
 * Visualizador de arquivos em tempo real - mostra mudanças conforme IA edita.
 * Similar ao Lovable: destaca arquivos sendo editados, mostra diff visual.
 */
export function RealtimeFilesViewer({
  files,
  previousFiles,
  isGenerating,
  projectName,
}: {
  files: WebsiteFiles;
  previousFiles?: WebsiteFiles;
  isGenerating?: boolean;
  projectName?: string;
}): React.JSX.Element {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState(new Set<string>());
  const [changes, setChanges] = useState<FileChange[]>([]);

  // Detecta mudanças nos arquivos
  const filesList = useMemo(() => {
    const prev = previousFiles ?? {};
    const detected: FileChange[] = [];

    for (const [path, content] of Object.entries(files)) {
      const isNew = !prev[path];
      const hasChanged = prev[path] !== content;

      if (isNew || hasChanged) {
        detected.push({
          path,
          content,
          timestamp: Date.now(),
          isNew,
        });
      }
    }

    return detected;
  }, [files, previousFiles]);

  // Atualiza lista de mudanças com animação
  useEffect(() => {
    if (filesList.length > 0) {
      setChanges((prev) => {
        const newChanges = [...prev];
        for (const file of filesList) {
          const existingIndex = newChanges.findIndex((c) => c.path === file.path);
          if (existingIndex >= 0) {
            newChanges[existingIndex] = file;
          } else {
            newChanges.push(file);
          }
        }
        // Mantém apenas últimas 50 mudanças
        return newChanges.slice(-50);
      });
    }
  }, [filesList]);

  // Auto-seleciona arquivo mais recente se estiver gerando
  useEffect(() => {
    if (isGenerating && filesList.length > 0 && !selectedFile) {
      setSelectedFile(filesList[filesList.length - 1].path);
    }
  }, [isGenerating, filesList, selectedFile]);

  const allFiles = Object.keys(files).sort();
  const currentFile = selectedFile && files[selectedFile] ? { path: selectedFile, content: files[selectedFile] } : null;

  function toggleExpanded(path: string): void {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {/* Header com status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">
            Arquivos {isGenerating && <Badge variant="secondary" className="ml-2"><Loader2 className="mr-1 size-3 animate-spin" />Gerando...</Badge>}
          </h3>
          <span className="text-xs text-muted-foreground">{allFiles.length} arquivo{allFiles.length !== 1 ? "s" : ""}</span>
        </div>
        <DownloadZipButton files={files} projectName={projectName} />
      </div>

      {/* Lista de arquivos com destaque para mudanças */}
      <div className="flex flex-1 gap-3 overflow-hidden">
        {/* Sidebar com lista */}
        <ScrollArea className="h-full w-48 shrink-0 border-r border-border pr-2">
          <div className="space-y-1">
            {allFiles.map((path) => {
              const change = changes.find((c) => c.path === path);
              const isRecent = change && Date.now() - change.timestamp < 5000;
              const isActive = selectedFile === path;

              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => setSelectedFile(path)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? "bg-primary/10 font-semibold text-primary"
                      : "hover:bg-secondary"
                  } ${isRecent ? "animate-pulse bg-green-500/10" : ""}`}
                >
                  <FileCode2 className="size-3 shrink-0" />
                  <span className="flex-1 truncate">{path.split("/").pop()}</span>
                  {change?.isNew && <Badge variant="secondary" className="text-[10px] px-1 py-0">Novo</Badge>}
                  {isRecent && <span className="size-2 shrink-0 rounded-full bg-green-500" />}
                </button>
              );
            })}
          </div>
        </ScrollArea>

        {/* Visualizador de conteúdo */}
        <div className="flex flex-1 flex-col gap-2 overflow-hidden">
          {currentFile ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FileCode2 className="size-4 text-muted-foreground" />
                  <span className="text-xs font-medium">{currentFile.path}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpanded(currentFile.path)}
                  title={expandedFiles.has(currentFile.path) ? "Recolher" : "Expandir"}
                >
                  {expandedFiles.has(currentFile.path) ? (
                    <EyeOff className="size-3" />
                  ) : (
                    <Eye className="size-3" />
                  )}
                </Button>
              </div>

              <ScrollArea className="flex-1">
                <pre className="rounded-md bg-secondary/30 p-3 text-[11px] leading-relaxed">
                  <code className="text-foreground">
                    {expandedFiles.has(currentFile.path)
                      ? currentFile.content
                      : currentFile.content.slice(0, 1000) + (currentFile.content.length > 1000 ? "\n\n..." : "")}
                  </code>
                </pre>
              </ScrollArea>

              <p className="text-[10px] text-muted-foreground">
                {currentFile.content.split("\n").length} linhas · {(currentFile.content.length / 1024).toFixed(1)} KB
              </p>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Selecione um arquivo para visualizar
            </div>
          )}
        </div>
      </div>

      {/* Timeline de mudanças recentes */}
      {changes.length > 0 && (
        <div className="border-t border-border pt-2">
          <p className="mb-2 text-xs font-medium">Mudanças recentes:</p>
          <ScrollArea className="h-20">
            <div className="space-y-1">
              {changes.slice(-10).reverse().map((change, idx) => (
                <div key={`${change.path}-${idx}`} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-green-500" />
                  <span className="flex-1 truncate">{change.path}</span>
                  <span>{change.isNew ? "Criado" : "Atualizado"}</span>
                  <span>{new Date(change.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
