"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, ExternalLink, LayoutTemplate, Plus, Trash2 } from "lucide-react";
import styles from "./sites.module.css";
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
  return <div ref={ref} className={styles.thumb}>
    {shot ? <Image unoptimized src={shot} alt="" fill sizes="420px" className="object-cover object-top" /> : <span aria-hidden="true">{fallback}</span>}
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

  return <div className={styles.list}>
    <div className={styles.heading}>
      <div><h1>Meus sites</h1><p>Crie sites com IA e continue editando seus projetos por aqui.</p></div>
      <Button onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" />Criar site</Button>
    </div>
    <div className={styles.guide} aria-label="Como funciona">
      <span><strong>Descreva</strong> o site que precisa.</span>
      <span><strong>Revise</strong> a prévia e peça ajustes na conversa.</span>
      <span><strong>Publique</strong> quando estiver pronto.</span>
    </div>
    {error ? <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 p-5"><p>{error}</p><Button variant="outline" onClick={() => void load()}>Tentar novamente</Button></div>
      : projects === null ? <div aria-busy="true" aria-label="Carregando sites" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((id) => <div key={id} className="h-64 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}</div>
      : projects.length === 0 ? <div className={styles.empty}><LayoutTemplate aria-hidden="true" /><h2>Seu primeiro site começa aqui</h2><p>Conte sobre o negócio e o site que precisa. Depois, acompanhe a prévia e peça alterações na conversa com a IA.</p><Button onClick={() => setCreateOpen(true)}>Criar meu primeiro site</Button></div>
      : <div className={styles.grid}>{projects.map((project) => {
        const url = safeSiteUrl(project.published_url);
        return <article key={project.id} className={styles.project}>
          <Link href={`/sites/${project.id}`} aria-label={`Abrir projeto ${project.name}`} tabIndex={-1}>
            <ProjectThumb projectId={project.id} fallback={project.name.trim().charAt(0).toUpperCase() || "?"} />
          </Link>
          <div className={styles.projectContent}>
            <Badge variant={project.status === "published" ? "default" : "secondary"}>{projectStatusLabel(project.status)}</Badge>
            <h2 className={`${styles.projectTitle} mt-3`}>{project.name}</h2>
            <p className={styles.projectClient}>{project.client_context.name || "Sem cliente vinculado"}</p>
            <dl className={styles.projectMeta}>
              <div><dt className="inline">Última alteração: </dt><dd className="inline">{formatRelative(project.updated_at)}</dd></div>
              <div><dt className="inline">IA: </dt><dd className="inline">{modelModeLabel(project.model_mode)}{project.model_id ? ` · ${project.model_id}` : ""}</dd></div>
              <div><dt className="inline">Última publicação: </dt><dd className="inline">{project.last_published_at ? formatRelative(project.last_published_at) : "Nenhuma"}</dd></div>
            </dl>
            {url ? <a className="mt-3 inline-flex min-h-9 items-center gap-2 text-xs text-primary hover:underline" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />Ver site publicado</a> : <p className="mt-3 text-xs text-muted-foreground">Ainda não publicado</p>}
            <div className={styles.projectFooter}>
              <Link href={`/sites/${project.id}`} aria-label={`Editar ${project.name}`} className={styles.editLink}>Continuar edição<ArrowRight className="size-4" aria-hidden="true" /></Link>
              <button type="button" onClick={() => setProjectToDelete(project)} className={styles.deleteButton} title={`Excluir site "${project.name}"`} aria-label={`Excluir site "${project.name}"`}><Trash2 className="size-4" aria-hidden="true" /></button>
            </div>
          </div>
        </article>;
      })}</div>}
    {createOpen && <CreateSiteDialog open={createOpen} onOpenChange={setCreateOpen} />}

    {projectToDelete && (
      <Dialog open={Boolean(projectToDelete)} onOpenChange={(open) => { if (!open && !deleting) setProjectToDelete(null); }}>
        <DialogContent className={`${styles.dialog} ${styles.paddedDialog} sm:max-w-md`}>
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
