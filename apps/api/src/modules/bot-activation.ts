import { setting } from '../core/settings.js';
export const defaultActivationKeywords = [
  'oi',
  'olá',
  'menu',
  'início',
  'suporte',
  'atendente',
  'humano',
];
export function normalizeKeyword(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
}
export function matchesActivation(text: string, keywords: string[]) {
  const input = normalizeKeyword(text);
  return !!input && keywords.some((word) => normalizeKeyword(word) === input);
}
export async function activationKeywords(): Promise<string[]> {
  const configured = await setting<string[] | null>('bot.activationKeywords', null);
  if (configured !== null) return configured;
  // Preserve custom greetings from installations created before the activation setting existed.
  return [...defaultActivationKeywords, ...(await setting<string[]>('bot.greetings', []))];
}
