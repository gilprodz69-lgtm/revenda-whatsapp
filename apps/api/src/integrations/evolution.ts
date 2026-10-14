import { env } from '../config.js';
import { AppError } from '../core/errors.js';
import { z } from 'zod';
export class EvolutionService {
  async call(path: string, method = 'GET', body?: unknown) {
    try {
      const response = await fetch(`${env.EVOLUTION_URL}${path}`, {
        method,
        headers: { apikey: env.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!response.ok)
        throw new AppError(
          'EVOLUTION_ERROR',
          'A conexão WhatsApp não respondeu. Verifique a instância.',
          503,
        );
      const data = (await response.json()) as Record<string, unknown>;
      if (data.error === true)
        throw new AppError(
          'EVOLUTION_ERROR',
          'A Evolution recusou a operação. Confira a instância e sua conexão.',
          503,
        );
      return data;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        'EVOLUTION_TIMEOUT',
        'Resultado do envio desconhecido. Verifique antes de reenviar.',
        503,
      );
    }
  }
  create(name: string, number?: string) {
    return this.call('/instance/create', 'POST', {
      instanceName: name,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      ...(number ? { number } : {}),
      groupsIgnore: true,
      readMessages: false,
      syncFullHistory: false,
      webhook: {
        enabled: true,
        url: 'http://api:3000/webhooks/evolution',
        byEvents: false,
        base64: false,
        headers: { 'x-webhook-secret': env.WEBHOOK_SECRET },
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
      },
    });
  }
  connect(name: string, number?: string) {
    return this.call(
      `/instance/connect/${encodeURIComponent(name)}${number ? `?number=${encodeURIComponent(number)}` : ''}`,
    );
  }
  state(name: string) {
    return this.call(`/instance/connectionState/${encodeURIComponent(name)}`);
  }
  restart(name: string) {
    return this.call(`/instance/restart/${encodeURIComponent(name)}`, 'POST');
  }
  instances() {
    return this.call('/instance/fetchInstances');
  }
  sendText(instance: string, phone: string, text: string) {
    return this.call(`/message/sendText/${encodeURIComponent(instance)}`, 'POST', {
      number: phone,
      text,
      linkPreview: false,
    });
  }
  sendMedia(
    instance: string,
    phone: string,
    media: string,
    mediatype: 'image' | 'document',
    fileName?: string,
    caption?: string,
  ) {
    return this.call(`/message/sendMedia/${encodeURIComponent(instance)}`, 'POST', {
      number: phone,
      mediatype,
      media,
      fileName,
      caption,
      mimetype: mediatype === 'image' ? 'image/png' : 'application/pdf',
    });
  }
}
export const evolution = new EvolutionService();
export const evolutionEventSchema = z.object({
  event: z.string(),
  instance: z.string(),
  data: z.unknown(),
});
export const incomingSchema = z.object({
  key: z.object({
    id: z.string(),
    remoteJid: z.string(),
    remoteJidAlt: z.string().optional(),
    fromMe: z.boolean(),
  }),
  pushName: z.string().optional(),
  message: z
    .object({
      conversation: z.string().optional(),
      extendedTextMessage: z.object({ text: z.string() }).optional(),
      buttonsResponseMessage: z.object({ selectedButtonId: z.string() }).optional(),
      listResponseMessage: z
        .object({ singleSelectReply: z.object({ selectedRowId: z.string() }) })
        .optional(),
    })
    .optional(),
  messageType: z.string().optional(),
});
export function normalizePhone(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const phone = jid.split('@')[0]!;
  return /^\d{8,15}$/.test(phone) ? phone : null;
}
