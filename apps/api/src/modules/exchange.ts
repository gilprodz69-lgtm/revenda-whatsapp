import { db } from '../core/db.js';
import { AppError } from '../core/errors.js';
import { setting } from '../core/settings.js';
import { z } from 'zod';
export async function currentRate() {
  const rate = await db.exchangeRate.findFirst({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!rate)
    throw new AppError('RATE_NOT_CONFIGURED', 'Configure uma cotação válida antes de vender.', 503);
  return rate;
}
export async function refreshExchange(options: { force?: boolean } = {}) {
  const provider = await setting('exchange.provider', 'manual');
  if (!options.force && provider === 'manual') return;
  if (!options.force && provider !== 'bcb')
    throw new AppError('RATE_PROVIDER', 'Provedor de cotação não configurado.');
  // PTAX oficial do Banco Central: último fechamento publicado dentro de sete dias.
  const end = new Date(),
    start = new Date(end.getTime() - 7 * 86400000);
  const fmt = (d: Date) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;
  const query = new URLSearchParams({
    '@moeda': "'USD'",
    '@dataInicial': `'${fmt(start)}'`,
    '@dataFinalCotacao': `'${fmt(end)}'`,
    $filter: "tipoBoletim eq 'Fechamento'",
    $orderby: 'dataHoraCotacao desc',
    $top: '1',
    $format: 'json',
  });
  // Olinda's OData parser requires %20 for spaces; form-style '+' causes HTTP 400.
  const response = await fetch(
    `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?${query.toString().replaceAll('+', '%20')}`,
    { signal: AbortSignal.timeout(10000) },
  ).catch(() => {
    throw new AppError(
      'RATE_UNAVAILABLE',
      'Não foi possível conectar ao BCB. Tente novamente.',
      503,
    );
  });
  if (!response.ok) throw new AppError('RATE_UNAVAILABLE', 'Cotação oficial indisponível.', 503);
  const data = z
    .object({
      value: z.array(
        z.object({ cotacaoVenda: z.number().finite().positive(), dataHoraCotacao: z.string() }),
      ),
    })
    .safeParse(await response.json().catch(() => null));
  if (!data.success)
    throw new AppError(
      'RATE_INVALID_RESPONSE',
      'O BCB retornou uma resposta de cotação inválida.',
      503,
    );
  const rate = data.data.value[0];
  if (!rate) throw new AppError('RATE_UNAVAILABLE', 'O BCB não retornou fechamento recente.', 503);
  const observedAt = new Date(rate.dataHoraCotacao.replace(' ', 'T') + '-03:00');
  if (!Number.isFinite(observedAt.getTime()))
    throw new AppError(
      'RATE_INVALID_RESPONSE',
      'O BCB retornou uma data de cotação inválida.',
      503,
    );
  const expiresAt = new Date(observedAt.getTime() + 4 * 86400000);
  if (expiresAt <= new Date()) throw new AppError('RATE_STALE', 'A última PTAX está vencida.', 503);
  return db.exchangeRate.create({
    data: { usdBrl: String(rate.cotacaoVenda), source: 'BCB-PTAX-venda', observedAt, expiresAt },
  });
}
