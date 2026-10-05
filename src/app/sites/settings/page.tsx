import { SitesSettings } from "@/components/sites/sites-settings";

export default function SitesSettingsPage(): React.JSX.Element {
  return <div className="mx-auto max-w-[1600px] space-y-6 px-3 py-5 sm:px-6"><div><h1 className="text-2xl font-semibold tracking-tight">Configurações do Site Studio</h1><p className="mt-1 text-sm text-muted-foreground">Administração global de integrações, limites e direção criativa.</p></div><SitesSettings /></div>;
}
