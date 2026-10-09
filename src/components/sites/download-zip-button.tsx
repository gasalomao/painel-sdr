"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { WebsiteFiles } from "@/lib/sites/types";

/**
 * Botão para download de todos os arquivos do site em formato ZIP.
 * Usa JSZip para gerar o arquivo localmente no navegador.
 */
export function DownloadZipButton({
  files,
  projectName = "site",
  disabled,
}: {
  files: WebsiteFiles;
  projectName?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const [downloading, setDownloading] = useState(false);

  async function downloadZip(): Promise<void> {
    if (downloading || disabled) return;

    setDownloading(true);
    try {
      // Importação dinâmica do JSZip (apenas quando necessário)
      const JSZip = (await import("jszip")).default;

      const zip = new JSZip();

      // Adicionar todos os arquivos ao ZIP
      for (const [path, content] of Object.entries(files)) {
        zip.file(path, content);
      }

      // Gerar o ZIP como blob
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      // Criar URL temporária e fazer download
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${sanitizeFilename(projectName)}-${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success("Download do ZIP iniciado!");
    } catch (error) {
      console.error("Erro ao gerar ZIP:", error);
      toast.error("Erro ao gerar arquivo ZIP. Tente novamente.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || downloading}
      onClick={() => void downloadZip()}
      title="Baixar todos os arquivos em ZIP"
    >
      <Download className="size-4" aria-hidden="true" />
      {downloading ? "Gerando..." : "Download ZIP"}
    </Button>
  );
}

/**
 * Sanitiza nome de arquivo removendo caracteres inválidos
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 200);
}
