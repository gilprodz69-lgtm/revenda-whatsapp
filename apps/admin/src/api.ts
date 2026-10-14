export type Row = Record<string, any>;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = Row>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const csrf =
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('csrf='))
      ?.slice(5) ?? '';
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({ message: 'Servidor indisponível.' }));
  if (!response.ok)
    throw new HttpError(response.status, data.message ?? 'Não foi possível concluir a operação.');
  return data as T;
}
