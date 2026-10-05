"use client";

import { SkillsManager } from "@/components/sites/skills-manager";

export default function SitesSkillsPage(): React.JSX.Element {
  return <div className="mx-auto max-w-[1600px] space-y-6 px-3 py-5 sm:px-6"><div><h1 className="text-2xl font-semibold tracking-tight">Biblioteca de skills</h1><p className="mt-1 text-sm text-muted-foreground">Diretrizes especializadas para orientar a criação dos sites. Skills padrão podem receber overrides privados; suas skills próprias são totalmente editáveis.</p></div><SkillsManager /></div>;
}
