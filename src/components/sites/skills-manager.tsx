import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { isOverrideSkill } from "@/lib/sites/ui-helpers";
import type { WebsiteSkill } from "@/lib/sites/types";
import { apiJson, errorMessage, jsonBody, selectClass } from "./api";

type SkillForm = {
  editing: string | null;
  name: string;
  slug: string;
  description: string;
  instructions: string;
  category: string;
  tags: string;
  priority: number;
  trigger_mode: WebsiteSkill["trigger_mode"];
  is_enabled: boolean;
};

const EMPTY_FORM: SkillForm = { editing: null, name: "", slug: "", description: "", instructions: "", category: "custom", tags: "", priority: 50, trigger_mode: "manual", is_enabled: true };
const LIMITS = { name: 100, slug: 80, description: 500, instructions: 12000, category: 60 } as const;

function toForm(skill: WebsiteSkill, editing: boolean): SkillForm {
  return {
    editing: editing ? skill.id : null,
    name: skill.name, slug: skill.slug, description: skill.description, instructions: skill.instructions,
    category: skill.category, tags: skill.tags.join(", "), priority: skill.priority,
    trigger_mode: skill.trigger_mode, is_enabled: skill.is_enabled,
  };
}

function formBody(form: SkillForm, partial: boolean): Record<string, unknown> {
  const tags = form.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  const body: Record<string, unknown> = {
    name: form.name, description: form.description, instructions: form.instructions,
    category: form.category, tags, priority: form.priority, trigger_mode: form.trigger_mode, is_enabled: form.is_enabled,
  };
  if (!partial || !form.editing?.startsWith("builtin:")) body.slug = form.slug.trim() || form.name.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return body;
}

export function SkillsManager(): React.JSX.Element {
  const [skills, setSkills] = useState<WebsiteSkill[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [form, setForm] = useState<SkillForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const data = await apiJson<{ skills: WebsiteSkill[] }>("/api/sites/skills", { signal });
      if (!signal?.aborted) { setSkills(data.skills); setError(""); }
    } catch (err) { if (!signal?.aborted) { setError(errorMessage(err)); toast.error(errorMessage(err)); } }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const categories = [...new Set((skills ?? []).map((skill) => skill.category))];
  const visible = (skills ?? []).filter((skill) => (!category || skill.category === category) && `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR")));
  const editingTarget = form?.editing ? (skills ?? []).find((skill) => skill.id === form.editing) ?? null : null;
  const builtinForm = Boolean(form && form.editing?.startsWith("builtin:"));

  function openCreate(source?: WebsiteSkill): void {
    if (!source) { setForm({ ...EMPTY_FORM }); return; }
    const draft = toForm(source, false);
    if (!draft.slug) draft.slug = `copia-${source.slug}`.slice(0, 80);
    setForm(draft);
  }

  function closeForm(): void {
    setForm(null);
    setPendingDelete(null);
  }

  function validate(form: SkillForm, partial: boolean): string | null {
    if (form.name.trim().length > LIMITS.name) return "Nome acima do limite.";
    if (form.description.length > LIMITS.description) return "Descrição acima do limite.";
    if (!form.instructions.trim() || form.instructions.length > LIMITS.instructions) return "Instruções são obrigatórias (até 12000 caracteres).";
    if (form.category.length > LIMITS.category) return "Categoria acima do limite.";
    if (!partial && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug)) return "Slug: letras minúsculas, números e hífens (ex.: minha-skill).";
    if (!Number.isInteger(form.priority) || form.priority < 0 || form.priority > 100) return "Prioridade deve estar entre 0 e 100.";
    return null;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!form || busy) return;
    const invalid = validate(form, Boolean(form.editing) && builtinForm);
    if (invalid) { toast.error(invalid); return; }
    setBusy(true);
    try {
      const partial = Boolean(form.editing);
      if (partial && form.editing) {
        const { skill } = await apiJson<{ skill: WebsiteSkill }>(`/api/sites/skills/${encodeURIComponent(form.editing)}`, jsonBody(formBody(form, true), "PATCH"));
        setSkills((prev) => prev ? prev.map((item) => item.id === skill.id ? skill : item) : prev);
        if (form.editing.startsWith("builtin:")) await load();
      } else {
        await apiJson<{ skill: WebsiteSkill }>("/api/sites/skills", jsonBody(formBody(form, false)));
        await load();
      }
      closeForm();
      toast.success(partial ? "Skill atualizada." : "Skill criada.");
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  }

  async function remove(skill: WebsiteSkill): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const data = await apiJson<{ skills: WebsiteSkill[] }>(`/api/sites/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      setSkills(data.skills);
      closeForm();
      toast.success(skill.is_builtin ? "Override removido; skill padrão restaurada." : "Skill excluída.");
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); setPendingDelete(null); }
  }

  async function toggleEnabled(skill: WebsiteSkill): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const { skill: updated } = await apiJson<{ skill: WebsiteSkill }>(`/api/sites/skills/${encodeURIComponent(skill.id)}`, jsonBody({ is_enabled: !skill.is_enabled }, "PATCH"));
      setSkills((prev) => prev ? prev.map((item) => item.id === skill.id ? updated : item) : prev);
      toast.success(updated.is_enabled ? "Skill ativada." : "Skill desativada.");
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  }

  const disabledAll = busy || Boolean(form);

  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-[1fr_220px]"><label className="space-y-1 text-sm">Buscar skill<Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome ou tag" /></label><label className="space-y-1 text-sm">Categoria<select className={selectClass} value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todas</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
    <Button onClick={() => openCreate()} disabled={disabledAll}>Nova skill</Button>
    {error ? <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 p-5"><p>{error}</p><Button variant="outline" disabled={disabledAll} onClick={() => void load()}>Tentar novamente</Button></div>
      : skills === null ? <p role="status" className="animate-pulse text-sm text-muted-foreground">Carregando skills...</p>
      : visible.length === 0 ? <p className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">Nenhuma skill encontrada. Ajuste os filtros ou crie uma nova.</p>
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((skill) => <article key={skill.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{skill.name}</h2><Badge variant="secondary">{skill.is_builtin ? (isOverrideSkill(skill) ? "Padrão · override" : "Padrão") : "Privada"} · v{skill.version}</Badge></div>
        <p className="text-sm text-muted-foreground">{skill.description || skill.name}</p>
        <dl className="space-y-1 text-xs"><div><dt className="inline">Categoria: </dt><dd className="inline">{skill.category}</dd></div><div><dt className="inline">Ativação: </dt><dd className="inline">{{ always: "Sempre", automatic: "Automática por tags", manual: "Manual" }[skill.trigger_mode]}</dd></div><div><dt className="inline">Prioridade: </dt><dd className="inline">{skill.priority}</dd></div><div><dt className="inline">Estado: </dt><dd className="inline">{skill.is_enabled ? "Ativa" : "Desativada"}</dd></div></dl>
        <div className="flex flex-wrap gap-1">{skill.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}</div>
        <details><summary className="cursor-pointer py-2 text-sm text-primary">Ler instruções</summary><p className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-sm text-muted-foreground">{skill.instructions}</p></details>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={disabledAll} onClick={() => { setForm(toForm(skill, true)); setPendingDelete(null); }}>Editar{skill.is_builtin ? " (override)" : ""}</Button>
          <Button size="sm" variant="outline" disabled={disabledAll} onClick={() => openCreate(skill)}>Duplicar</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleEnabled(skill)}>{skill.is_enabled ? "Desativar" : "Ativar"}</Button>
          {isOverrideSkill(skill) || !skill.is_builtin ? <Button size="sm" variant="outline" className="text-destructive" disabled={disabledAll} onClick={() => setPendingDelete(skill.id)}>{isOverrideSkill(skill) ? "Restaurar padrão" : "Excluir"}</Button> : null}
        </div>
        {pendingDelete === skill.id && <div role="alertdialog" aria-label="Confirmar exclusão" className="space-y-2 rounded-lg border border-destructive/40 p-3 text-sm"><p>{isOverrideSkill(skill) ? "Remover o override privado e voltar à skill padrão?" : `Excluir definitivamente "${skill.name}"? Projetos que a usam param de recebê-la.`}</p><div className="flex gap-2"><Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(skill)}>Confirmar</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setPendingDelete(null)}>Cancelar</Button></div></div>}
      </article>)}</div>}
    {form && <Dialog open onOpenChange={(next) => { if (!busy && !next) closeForm(); }}>
      <DialogContent showCloseButton={false} className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{form.editing ? `Editar "${form.name}"` : "Nova skill"}</DialogTitle>
          <DialogDescription>{builtinForm ? "Você está criando um override privado desta skill padrão. O slug original é preservado e a segurança do agente não é alterada." : "Instruções orientam o agente; elas não ampliam permissões nem substituem as regras de segurança."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <fieldset disabled={busy} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1">Nome<Input required maxLength={LIMITS.name} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label className="space-y-1">Slug<Input maxLength={LIMITS.slug} readOnly={builtinForm} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="minha-skill" /><span className="text-xs text-muted-foreground">Gerado do nome quando vazio. Slugs de skills padrão são reservados.</span></label></div>
            <label className="block space-y-1">Descrição<Input maxLength={LIMITS.description} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
            <label className="block space-y-1">Instruções<Textarea required maxLength={LIMITS.instructions} rows={8} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} /></label>
            <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1">Categoria<Input maxLength={LIMITS.category} value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} list="skill-categories" /><datalist id="skill-categories">{["design", "quality", "content", "seo", "custom"].map((item) => <option key={item} value={item} />)}</datalist></label><label className="space-y-1">Prioridade (0–100)<Input type="number" min={0} max={100} step={1} value={Number.isNaN(form.priority) ? "" : form.priority} onChange={(event) => setForm({ ...form, priority: event.target.valueAsNumber })} /></label><label className="space-y-1">Ativação<select className={selectClass} value={form.trigger_mode} onChange={(event) => setForm({ ...form, trigger_mode: event.target.value as WebsiteSkill["trigger_mode"] })}><option value="manual">Manual (seleção por projeto)</option><option value="automatic">Automática por tags</option><option value="always">Sempre</option></select></label></div>
            <label className="block space-y-1">Tags (separadas por vírgula)<Input maxLength={400} value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="seo, copy" /></label>
            <label className="flex items-center gap-2"><input className="size-4 accent-primary" type="checkbox" checked={form.is_enabled} onChange={(event) => setForm({ ...form, is_enabled: event.target.checked })} />Ativa para novos projetos</label>
          </fieldset>
          {editingTarget && <p className="text-xs text-muted-foreground">Versão atual: v{editingTarget.version}. O salvamento cria a próxima versão.</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={closeForm}>Cancelar</Button><Button type="submit" disabled={busy}>{busy ? "Salvando..." : form.editing ? "Salvar alterações" : "Criar skill"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>}
  </div>;
}
