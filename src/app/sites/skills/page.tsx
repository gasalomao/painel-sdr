"use client";

import { SkillsManager } from "@/components/sites/skills-manager";

export default function SitesSkillsPage(): React.JSX.Element {
  return <div className="mx-auto max-w-[1600px] space-y-6 px-3 py-5 sm:px-6"><div><h1 className="text-2xl font-semibold tracking-tight">Diretrizes de IA</h1><p className="mt-1 text-sm leading-relaxed text-muted-foreground">As diretrizes (skills) orientam como a IA cria seus sites. Personalize as padrão ou crie suas próprias instruções.</p></div><SkillsManager /></div>;
}
