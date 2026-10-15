# Provedores SMM e categorias

Disponível a partir de **1.1.0**, junto da integração Partner existente. Serviços SMM são entregues ao link informado pelo cliente e acompanhados pelo número do pedido no provedor; produtos Partner continuam com o fluxo de entrega original.

## Configurar e importar

1. Acesse como proprietário **Provedores SMM → Novo provedor**. Informe nome, URL HTTPS pública da API, chave e moeda real da conta (USD ou BRL). MachineSMM publica o endpoint `https://machinesmm.com/api/v2` na [documentação oficial](https://machinesmm.com/api). Outros provedores precisam seguir esse contrato API v2; variantes não foram homologadas automaticamente.
2. Clique em **Testar conexão**. O teste consulta o saldo, sem criar pedido, e confere a moeda. A chave é criptografada e não volta para o navegador; deixe o campo vazio ao editar para conservar a chave existente.
3. Em **Categorias**, crie os nomes, descrições, ordem e visibilidade que deseja no WhatsApp. Ocultar uma categoria impede novas compras dos seus serviços. Uma categoria em uso precisa ter os produtos movidos antes de ser excluída.
4. No provedor, clique em **Importar serviços**. Pesquise, selecione e escolha uma categoria da loja, ou mantenha as categorias do catálogo externo. A importação aceita até 100 serviços por operação. Tipos incompatíveis aparecem desabilitados.
5. Em **Produtos → Editar**, personalize nome/descrição, categoria, preço e disponibilidade. Serviços novos chegam sem autorização de revenda. Autorize somente depois de revisar as condições e financiar o saldo da conta no provedor.

O nome e a descrição locais são os textos apresentados ao cliente. A sincronização conserva apresentação, categoria escolhida, preços e autorização locais; atualiza custo, limites e disponibilidade externos. Não importa itens novos nem restaura os excluídos. Reimportar explicitamente um produto excluído conserva sua apresentação/preço e exige nova autorização. Cada provedor possui sua própria chave e namespace de serviços/pedidos, mesmo quando IDs externos coincidem.

## Tipos avulsos

| Tipo API v2 | Dados solicitados pelo bot | Base do preço |
| --- | --- | --- |
| Default | Link e quantidade | 1.000 unidades |
| Package | Link; um pacote por pedido | Pacote |
| Custom Comments | Link e comentários separados por linha; quantidade calculada pelas linhas | 1.000 comentários |
| Comment Likes | Link, quantidade e usuário do comentário | 1.000 unidades |
| Poll | Link, quantidade e número da alternativa | 1.000 votos |

Mínimo/máximo são conferidos antes da reserva e novamente antes do envio. Assinaturas automáticas, agendamento recorrente, drip-feed e outros tipos não fazem parte deste fluxo. Os indicadores externos de refill/cancel são armazenados como metadados; esta versão não envia solicitações de refill/cancel ao provedor.

## Preço e saldo

Para os tipos por mil, **preço manual, margem fixa e promoção no editor representam 1.000 unidades**. Exemplo: preço de venda R$ 10 por mil e quantidade 250 resulta em R$ 2,50. O total é arredondado ao centavo depois da multiplicação; o bot não cobra R$ 10 por cada unidade. Package tem quantidade 1 e preço por pacote.

Custos USD usam uma cotação USD/BRL válida e congelada no pedido. Custos BRL dispensam cotação USD. Divergência da moeda da conta bloqueia a operação. Não existe conversão presumida de USDT. O fornecedor exige saldo próprio, separado da carteira do cliente. O saldo do cliente fica reservado enquanto o pedido aguarda execução.

## Acompanhar e resolver pedidos

O worker consulta pedidos enviados em intervalos de pelo menos 60 segundos por pedido, respeitando o limite de consultas configurado no provedor. No admin, **Pedidos → Detalhes**, confira provedor, destino, número externo, status e unidades restantes. **Consultar status SMM** antecipa uma consulta manual. Desativar o provedor impede novas vendas e mantém o acompanhamento dos pedidos já enviados.

Conclusão captura o saldo reservado e avisa o cliente. Resultado parcial devolve à carteira a fração não entregue, com arredondamento para baixo ao centavo. Cancelamento/reembolso integral confirmado com cobrança zero devolve a reserva toda. Resultados incompatíveis com quantidade/moeda/cobrança ficam em revisão. O painel considera devoluções ao calcular receita e lucro. Um estorno manual após entrega parcial devolve apenas a parcela ainda não reembolsada.

O contrato API v2 não oferece chave de idempotência para `add`. Se o envio perde a resposta, o sistema **não repete a compra** e conserva a reserva em revisão. O proprietário deve conferir o painel do provedor:

- Se o pedido existe, use **Vincular pedido existente**, informando o número e confirmando serviço, link e quantidade. O sistema consulta esse pedido e retoma o acompanhamento, sem novo `add`.
- Se confirmou que não existe, use **Liberar reserva após conferência**, com justificativa e confirmação explícita. Isso encerra o pedido local e devolve a reserva uma única vez. O cliente pode iniciar uma nova compra.

Ambas as ações são auditadas. Não libere reserva enquanto a existência do pedido externo permanecer incerta.

## Atualização e verificação

```bash
sudo bash /opt/revenda-whatsapp/scripts/update.sh v1.1.0
```

O updater cria backup e conserva banco, `.env`, credenciais, sessões e configurações. A migration `202610150006_smm_categories` cria as tabelas SMM/categorias e associa produtos Partner às categorias equivalentes às anteriores, preservando os registros e regras de venda. Nenhum provedor SMM é criado com chave de exemplo.

Os testes automatizados usam APIs externas simuladas. Após cadastrar sua chave, confira **Testar conexão**, importação de um serviço e um pedido pequeno autorizado na sua própria conta antes de abrir o catálogo aos clientes. Não foi realizada compra real nem acessada a VPS pelo assistente.
