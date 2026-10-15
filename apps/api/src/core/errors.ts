export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const partnerMessages: Record<string, string> = {
  INVALID_API_KEY: 'A integração da loja precisa de uma chave válida.',
  API_KEY_EXPIRED: 'A chave da integração expirou.',
  USER_BLOCKED: 'A conta da loja está bloqueada.',
  API_ACCESS_DISABLED: 'O acesso da loja à API está desativado.',
  PARTNER_SUSPENDED: 'A integração está suspensa.',
  MAINTENANCE: 'O fornecedor está em manutenção. Tente mais tarde.',
  UPSTREAM_UNAVAILABLE:
    'O fornecedor está temporariamente indisponível. Aguarde um instante e tente novamente.',
  TRANSPORT_UNKNOWN:
    'Falha de comunicação com o fornecedor. Aguarde um instante e tente novamente.',
  RATE_LIMIT_EXCEEDED: 'Aguarde um momento antes de tentar novamente.',
  PRODUCT_NOT_FOUND: 'Produto não encontrado.',
  PRODUCT_NOT_ALLOWED: 'Este produto não está disponível para a loja.',
  PRODUCT_UNAVAILABLE: 'Este produto está indisponível.',
  UNSUPPORTED_DELIVERY_TYPE: 'Este produto exige revisão de entrega.',
  OUT_OF_STOCK: 'O estoque deste produto acabou.',
  INVALID_QUANTITY: 'Informe uma quantidade válida.',
  INSUFFICIENT_BALANCE:
    'O saldo da loja no fornecedor é insuficiente. Entre em contato com o suporte.',
  ORDER_NOT_FOUND: 'Pedido ainda não localizado no fornecedor.',
  VALIDATION_ERROR: 'Os dados do pedido precisam ser revisados.',
  FAILED: 'O resultado da compra precisa ser verificado. Seu saldo permanece protegido.',
};
export class PartnerError extends AppError {
  constructor(
    code: string,
    public requestId: string | undefined,
    status: number,
    public uncertain = false,
  ) {
    super(code, partnerMessages[code] ?? 'Não foi possível consultar o fornecedor.', status);
  }
}
export const definitiveOrderFailures = new Set([
  'PRODUCT_NOT_FOUND',
  'PRODUCT_NOT_ALLOWED',
  'PRODUCT_UNAVAILABLE',
  'UNSUPPORTED_DELIVERY_TYPE',
  'OUT_OF_STOCK',
  'INVALID_QUANTITY',
  'INSUFFICIENT_BALANCE',
  'VALIDATION_ERROR',
]);
