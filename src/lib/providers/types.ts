/**
 * Interface comum de provedor de WhatsApp.
 *
 * Permite que o painel SDR troque de provedor (Evolution API → Evolution GO)
 * sem tocar no resto do sistema. Cada provedor implementa estes métodos.
 *
 * O channel.ts roteia pra o provedor certo baseado em `channel_connections.provider`.
 */

/** Resultado de envio de mensagem (normalizado entre providers). */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  status?: string;
  error?: string;
}

/** Mídia suportada por todos os provedores. */
export interface MediaData {
  type: "image" | "audio" | "video" | "document";
  base64: string;
  fileName?: string;
  mimetype?: string;
}

/** Status de conexão normalizado. */
export interface ConnectionStatus {
  state: "open" | "close" | "connecting" | "not_found" | "unknown";
  data?: any;
}

/** QR Code para pareamento. */
export interface QRCodeResult {
  qr?: string;
  base64?: string;
  pairingCode?: string;
  error?: string;
}

/** Interface que TODO provedor de WhatsApp deve implementar. */
export interface WhatsAppProvider {
  /** Nome identificador do provedor (ex: "evolution", "evolution_go"). */
  readonly name: string;

  /** Enviar mensagem de texto. */
  sendText(remoteJid: string, text: string, instanceName: string): Promise<SendResult>;

  /** Enviar mídia (imagem/áudio/vídeo/documento). */
  sendMedia(remoteJid: string, caption: string, media: MediaData, instanceName: string): Promise<SendResult>;

  /** Status de conexão da instância. */
  getStatus(instanceName: string): Promise<ConnectionStatus>;

  /** Obter QR Code para pareamento. */
  getQR(instanceName: string): Promise<QRCodeResult>;

  /** Verificar se números têm WhatsApp. */
  checkNumbers(numbers: string[], instanceName: string): Promise<Record<string, boolean>>;

  /** Verificar números com detalhe (jid resolvido). */
  checkNumbersDetailed(
    numbers: string[],
    instanceName: string
  ): Promise<Record<string, { exists: boolean; jid: string | null }>>;

  /** Buscar foto de perfil (null se não suportado pelo provider). */
  fetchProfilePicture(remoteJid: string, instanceName: string): Promise<string | null>;
}
