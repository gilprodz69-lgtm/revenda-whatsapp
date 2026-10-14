import { z } from 'zod';
const choice = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(24),
  description: z.string().max(72).optional(),
});
export const interactiveSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('buttons'),
    title: z.string().max(200),
    description: z.string().max(4000),
    footer: z.string().max(60),
    buttons: z.array(choice).min(1).max(3),
  }),
  z.object({
    type: z.literal('list'),
    title: z.string().max(200),
    description: z.string().max(4000),
    footer: z.string().max(60),
    buttonText: z.string().min(1).max(20),
    rows: z.array(choice).min(1).max(10),
  }),
]);
export type Interactive = z.infer<typeof interactiveSchema>;
export const interactionStateSchema = z.object({ token: z.string(), values: z.array(z.string()) });
export function resolveChoice(id: string, interaction: unknown): string | null {
  const state = interactionStateSchema.safeParse(interaction);
  if (!state.success) return null;
  const [prefix, token, value, extra] = id.split(':');
  return prefix === 'wa' &&
    token === state.data.token &&
    value !== undefined &&
    extra === undefined &&
    state.data.values.includes(value)
    ? value
    : null;
}
export function compactMenu(text: string) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\d+\s*[-–]|^\s*(?:digite menu|voltar\s*[-–])/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}
export function nativeFlowId(params: string | undefined): string {
  if (!params || params.length > 2048) return '';
  try {
    return z.object({ id: z.string().min(1).max(200) }).parse(JSON.parse(params)).id;
  } catch {
    return '';
  }
}
