"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";
import { ExternalLink, LayoutTemplate, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CreateSiteDialog } from "@/components/sites/create-site-dialog";
import { apiJson, errorMessage } from "@/components/sites/api";
import { formatRelative, modelModeLabel, projectStatusLabel, safeSiteUrl } from "@/lib/sites/ui-helpers";
import type { WebsiteBuild, WebsiteProject } from "@/lib/sites/types";

function ProjectThumb({ projectId, fallback }: { projectId: string; fallback: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [shot, setShot] = useState<string | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      apiJson<{ builds: Omit<WebsiteBuild, "artifact">[] }>(`/api/sites/${projectId}/builds`, { signal: controller.signal }).then((data) => {
        const thumb = data.builds.find((build) => build.screenshots?.desktop?.startsWith("data:image/png;base64,iVBOR"))?.screenshots.desktop ?? null;
        if (!controller.signal.aborted) setShot(thumb);
      }).catch(() => undefined);
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => { observer.disconnect(); controller.abort(); };
  }, [projectId]);
  return <div ref={ref} className="pointer-events-none relative flex h-32 items-center justify-center overflow-hidden bg-gradient-to-br from-primary/25 via-primary/5 to-secondary">
    {shot ? <Image unoptimized src={shot} alt="" fill sizes="420px" className="object-cover object-top" /> : <span aria-hidden="true" className="text-5xl font-semibold text-primary">{fallback}</span>}
  </div>;
}

export default function SitesPage(): React.JSX.Element {
  const [projects, setProjects] = useState<WebsiteProject[] | null>(null);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<WebsiteProject | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    await apiJson<{ projects: WebsiteProject[] }>("/api/sites", { signal }).then((data) => {
      if (signal?.aborted) return;
      setProjects(data.projects);
      setError("");
    }).catch((err: unknown) => {
      if (!signal?.aborted) { setError(errorMessage(err)); toast.error(errorMessage(err)); }
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function confirmDeleteProject(): Promise<void> {
    if (!projectToDelete || deleting) return;
    setDeleting(true);
    try {
      await apiJson(`/api/sites/${projectToDelete.id}`, { method: "DELETE" });
      setProjects((prev) => prev ? prev.filter((p) => p.id !== projectToDelete.id) : null);
      toast.success(`Site "${projectToDelete.name}" excluído com sucesso.`);
      setProjectToDelete(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  return <div className="mx-auto max-w-[1600px] space-y-6 px-3 py-5 sm:px-6">
    <div className="flex items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold tracking-tight">Meus Sites</h1><p className="mt-1 text-sm text-muted-foreground">Da primeira ideia ao site publicado, com contexto do seu cliente.</p></div>
      <Button onClick={() => setCreateOpen(true)} className="min-h-10"><Plus aria-hidden="true" />Criar site</Button>
    </div>
    {error ? <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 p-5"><p>{error}</p><Button variant="outline" onClick={() => void load()}>Tentar novamente</Button></div>
      : projects === null ? <div aria-busy="true" aria-label="Carregando sites" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((id) => <div key={id} className="h-64 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}</div>
      : projects.length === 0 ? <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-6 py-16 text-center"><LayoutTemplate className="size-10 text-primary" aria-hidden="true" /><h2 className="text-lg font-medium">Seu primeiro site começa aqui</h2><p className="max-w-md text-sm text-muted-foreground">Crie um projeto e converse com o agente para transformar informações confirmadas em um site.</p><Button onClick={() => setCreateOpen(true)}>Criar meu primeiro site</Button></div>
      : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{projects.map((project) => {
        const url = safeSiteUrl(project.published_url);
        return <article key={project.id} className="relative overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-primary/50">
          <Link href={`/sites/${project.id}`} aria-label={`Editar ${project.name}`} className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-primary" />
          <ProjectThumb projectId={project.id} fallback={project.name.trim().charAt(0).toUpperCase() || "?"} />
          <div className="pointer-events-none space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-semibold">{project.name}</h2>
                <p className="truncate text-sm text-muted-foreground">{project.client_context.name || "Sem cliente vinculado"}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 pointer-events-auto relative z-10">
                <Badge variant={project.status === "published" ? "default" : "secondary"}>
                  {projectStatusLabel(project.status)}
                </Badge>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setProjectToDelete(project);
                  }}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors cursor-pointer"
                  title={`Excluir site "${project.name}"`}
                  aria-label={`Excluir site "${project.name}"`}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>
            {url ? <a className="pointer-events-auto relative z-10 flex items-center gap-1 break-all text-xs text-primary hover:underline" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3 shrink-0" aria-hidden="true" />{url}</a> : <p className="text-xs text-muted-foreground">Ainda não publicado</p>}
            <dl className="space-y-1 text-xs text-muted-foreground">
              <div><dt className="inline">Última alteração: </dt><dd className="inline">{formatRelative(project.updated_at)}</dd></div>
              <div><dt className="inline">Modelo: </dt><dd className="inline break-all">{modelModeLabel(project.model_mode)}{project.model_id ? ` · ${project.model_id}` : ""}</dd></div>
              <div><dt className="inline">Última publicação: </dt><dd className="inline">{project.last_published_at ? formatRelative(project.last_published_at) : "Nenhuma"}</dd></div>
            </dl>
          </div>
        </article>;
      })}</div>}
    {createOpen && <CreateSiteDialog open={createOpen} onOpenChange={setCreateOpen} />}

    {projectToDelete && (
      <Dialog open={Boolean(projectToDelete)} onOpenChange={(open) => { if (!open && !deleting) setProjectToDelete(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5 text-destructive" />
              Excluir site
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <span>
                Tem certeza de que deseja excluir o site <strong className="text-foreground">{projectToDelete.name}</strong>?
              </span>
              <span className="block text-xs text-muted-foreground">
                Esta ação é irreversível e excluirá todas as páginas, arquivos, rascunhos e histórico deste projeto.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:justify-end pt-2">
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setProjectToDelete(null)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDeleteProject()}
            >
              {deleting ? "Excluindo..." : "Excluir definitivamente"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
  </div>;
}
