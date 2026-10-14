import { setting } from '../core/settings.js';
import { AppError } from '../core/errors.js';
export const templates: Record<string, { label: string; text: string }> = {
  welcome: {
    label: 'Boas-vindas',
    text: '🛍️ Bem-vindo à {loja}, {nome}!\n\n1 - Ver produtos\n2 - Meu saldo\n3 - Adicionar saldo\n4 - Meus pedidos\n5 - Suporte\n6 - Minha conta\n\nDigite menu para voltar ao início.',
  },
  categories: { label: 'Categorias', text: 'Escolha a categoria:' },
  products: { label: 'Lista de produtos', text: 'Escolha o produto:' },
  quantity: {
    label: 'Solicitar quantidade',
    text: 'Informe a quantidade desejada. O limite de estoque está indicado acima.',
  },
  summary: { label: 'Resumo do pedido', text: 'Resumo da compra\n{produto}\nTotal: R$ {valor}' },
  processing: {
    label: 'Processando compra',
    text: 'Pedido {pedido} recebido. Seu saldo foi reservado e a compra está sendo processada. A entrega será enviada aqui após a confirmação do fornecedor.',
  },
  awaitingPayment: {
    label: 'Aguardando Pix',
    text: 'Pix de R$ {valor}\nO saldo será creditado após confirmação do gateway. Não é necessário enviar comprovante.',
  },
  paymentConfirmed: {
    label: 'Pagamento confirmado',
    text: 'Pagamento confirmado! R$ {valor} adicionados à sua carteira. Digite menu para comprar.',
  },
  paymentExpired: {
    label: 'Pix expirado',
    text: 'O Pix de R$ {valor} expirou. Digite menu para gerar uma nova cobrança. Não reutilize o código vencido.',
  },
  completed: {
    label: 'Pedido concluído',
    text: '✅ Pedido {pedido} concluído\nProduto: {produto}\nGuarde as informações da entrega em local seguro.',
  },
  unavailable: {
    label: 'Sem disponibilidade',
    text: 'Nenhum produto disponível no momento. Digite menu e escolha suporte para falar com a equipe.',
  },
  failed: {
    label: 'Compra não concluída',
    text: 'Pedido {pedido} não concluído. A reserva foi devolvida à sua carteira. Solicite suporte se precisar de ajuda.',
  },
  human: {
    label: 'Atendimento humano',
    text: 'Seu atendimento foi encaminhado para nossa equipe. A automação ficará pausada por 24 horas ou até o atendente liberar.',
  },
};
export const allowedPlaceholders = new Set(['nome', 'loja', 'produto', 'valor', 'pedido']);
export function validateTemplate(text: string) {
  for (const match of text.matchAll(/\{([^{}]+)\}/g))
    if (!allowedPlaceholders.has(match[1]!))
      throw new AppError('INVALID_PLACEHOLDER', `Placeholder não permitido: ${match[1]}`);
  return text;
}
export function renderTemplate(text: string, values: Record<string, string>) {
  return validateTemplate(text).replace(/\{([^{}]+)\}/g, (_, key: string) => values[key] ?? '');
}
export async function messageTemplate(key: string, values: Record<string, string> = {}) {
  const template = templates[key];
  if (!template) throw new Error('Template desconhecido.');
  return renderTemplate(await setting(`messages.${key}`, template.text), values);
}
