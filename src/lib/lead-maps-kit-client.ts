import { toast } from "sonner";

function slugifyFileName(input: string): string {
  const clean = (input || "estabelecimento")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "estabelecimento";
}

export interface DownloadLeadMapsKitInput {
  id: string | number;
  nome_negocio?: string | null;
}

export async function downloadLeadMapsKit(lead: DownloadLeadMapsKitInput): Promise<boolean> {
  if (!lead?.id) {
    toast.error("ID do lead inválido para baixar o kit.");
    return false;
  }

  const businessName = (lead.nome_negocio || "estabelecimento").trim();
  toast.info(`Coletando fotos e dados completos do Maps de "${businessName}"...`);

  try {
    const res = await fetch(`/api/leads/${lead.id}/maps-kit`, {
      method: "GET",
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg =
        typeof errData?.error === "string"
          ? errData.error
          : "Não foi possível gerar o pacote do Google Maps.";
      toast.error(msg);
      return false;
    }

    const photoCount = Number(res.headers.get("X-Photo-Count") || "0");
    const headerFileName = res.headers.get("X-File-Name");
    const fileName = headerFileName || `kit-site-${slugifyFileName(businessName)}.zip`;

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 5000);

    toast.success(
      photoCount > 0
        ? `Kit de "${businessName}" baixado com ${photoCount} foto(s) + TXT completo!`
        : `Kit de "${businessName}" baixado com TXT completo de informações!`
    );
    return true;
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "Erro ao baixar kit do Google Maps.");
    return false;
  }
}

