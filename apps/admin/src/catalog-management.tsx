import { useState, type FormEvent } from 'react';
import {
  Plus,
  Settings,
  FolderTree,
  Download,
  RefreshCw,
  Trash2,
  Pencil,
  PlugZap,
} from 'lucide-react';
import { api, type Row } from './api';
import { EditorDialog } from './editor';
import { CatalogImport } from './catalog-import';

export function CatalogManagement({
  kind,
  rows,
  canEdit,
  refresh,
  onError,
}: {
  kind: 'categories' | 'smm-providers';
  rows: Row[];
  canEdit: boolean;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const providers = kind === 'smm-providers';
  const [editor, setEditor] = useState<{ row?: Row; deleting?: boolean } | null>(null);
  const [importing, setImporting] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const open = (row?: Row, deleting = false) => {
    setError('');
    setEditor({ row, deleting });
  };
  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operação não concluída.');
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget),
      get = (key: string) => String(f.get(key) ?? '');
    await perform(async () => {
      const row = editor?.row;
      if (editor?.deleting) await api(`/${kind}/${row!.id}`, 'DELETE');
      else
        await api(
          `/${kind}${row ? `/${row.id}` : ''}`,
          row ? 'PATCH' : 'POST',
          providers
            ? {
                name: get('name'),
                url: get('url'),
                apiKey: get('apiKey'),
                currency: get('currency'),
                requestsPerMinute: Number(get('requestsPerMinute')),
                active: f.has('active'),
              }
            : {
                name: get('name'),
                description: get('description'),
                sortOrder: Number(get('sortOrder')),
                active: f.has('active'),
              },
        );
      setEditor(null);
      await refresh();
    });
  }
  return (
    <>
      <section className="card stack">
        <div className="card-title">
          <div>
            <h2>{providers ? 'Provedores de serviços SMM' : 'Categorias da loja'}</h2>
            <p>
              {providers
                ? 'Conecte APIs v2, teste o saldo e importe os serviços que deseja vender.'
                : 'Escolha os nomes, a ordem e a visibilidade das categorias do WhatsApp.'}
            </p>
          </div>
          {canEdit && (
            <button className="primary" onClick={() => open()}>
              <Plus size={16} />
              {providers ? 'Novo provedor' : 'Nova categoria'}
            </button>
          )}
        </div>
        {error && !editor && (
          <div className="editor-error" role="alert">
            {error}
          </div>
        )}
        {!rows.length ? (
          <div className="empty">
            <FolderTree />
            <h3>{providers ? 'Nenhum provedor SMM cadastrado' : 'Nenhuma categoria cadastrada'}</h3>
            <p>
              {providers
                ? 'Cadastre a URL da API e sua chave para consultar o catálogo.'
                : 'Crie uma categoria e atribua os serviços em Produtos → Editar → Apresentação.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap catalog-management">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>{providers ? 'API / moeda' : 'Ordem / serviços'}</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Nome">
                      <b>{row.name}</b>
                      <small>
                        {providers
                          ? `${row._count?.products ?? 0} serviços · Chave configurada`
                          : row.description}
                      </small>
                      {balances[row.id] && <small role="status">{balances[row.id]}</small>}
                    </td>
                    <td data-label={providers ? 'API / moeda' : 'Ordem / serviços'}>
                      {providers ? (
                        <>
                          <span>{row.url}</span>
                          <small>
                            {row.currency} · {row.requestsPerMinute} consultas/min
                          </small>
                        </>
                      ) : (
                        `${row.sortOrder} · ${row._count?.products ?? 0} serviços`
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${row.active ? 'success' : 'neutral'}`}>
                        {row.active ? 'Ativo' : 'Oculto / desativado'}
                      </span>
                    </td>
                    <td data-label="Ações">
                      <div className="instance-actions">
                        {providers && canEdit && (
                          <>
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                void perform(async () => {
                                  const balance = await api<Row>(
                                    `/smm-providers/${row.id}/test`,
                                    'POST',
                                  );
                                  setBalances((v) => ({
                                    ...v,
                                    [row.id]: `Conexão válida · Saldo ${balance.currency} ${balance.balance}`,
                                  }));
                                })
                              }
                            >
                              <PlugZap size={14} />
                              Testar conexão
                            </button>
                            <button
                              className="secondary"
                              disabled={busy || !row.active}
                              onClick={() => setImporting(row)}
                            >
                              <Download size={14} />
                              Importar serviços
                            </button>
                            <button
                              className="secondary"
                              disabled={busy || !row.active}
                              onClick={() =>
                                void perform(async () => {
                                  await api(`/smm-providers/${row.id}/sync`, 'POST');
                                  await refresh();
                                })
                              }
                            >
                              <RefreshCw size={14} />
                              Sincronizar
                            </button>
                          </>
                        )}
                        {canEdit && (
                          <>
                            <button
                              className="text-btn"
                              onClick={() => open(row)}
                              aria-label={`Editar ${row.name}`}
                            >
                              <Pencil size={14} />
                              Editar
                            </button>
                            <button
                              className="text-btn danger-action"
                              onClick={() => open(row, true)}
                              aria-label={`Excluir ${row.name}`}
                            >
                              <Trash2 size={14} />
                              Excluir
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editor && (
        <EditorDialog
          title={
            editor.deleting
              ? `Excluir ${providers ? 'provedor' : 'categoria'}`
              : `${editor.row ? 'Editar' : providers ? 'Novo' : 'Nova'} ${providers ? 'provedor SMM' : 'categoria'}`
          }
          description={
            editor.deleting
              ? 'Confira o item antes de confirmar.'
              : providers
                ? 'API v2: URL HTTPS pública e chave armazenada com criptografia.'
                : 'Organize as categorias exibidas no WhatsApp.'
          }
          icon={providers ? Settings : FolderTree}
          busy={busy}
          error={error}
          onClose={() => setEditor(null)}
        >
          <form className="modal-form" onSubmit={submit}>
            <div className="editor-scroll stack">
              {editor.deleting ? (
                <>
                  <h3>{editor.row!.name}</h3>
                  <p>
                    {providers
                      ? 'Provedores com serviços ou pedidos devem ser desativados para preservar o histórico.'
                      : 'Categorias com produtos devem ser ocultadas ou ter os produtos movidos antes da exclusão.'}
                  </p>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Nome</span>
                    <input
                      name="name"
                      required
                      maxLength={100}
                      defaultValue={editor.row?.name ?? ''}
                    />
                  </label>
                  {providers ? (
                    <>
                      <label className="field">
                        <span>URL da API SMM</span>
                        <input
                          name="url"
                          type="url"
                          required
                          placeholder="https://machinesmm.com/api/v2"
                          defaultValue={editor.row?.url ?? ''}
                        />
                      </label>
                      <label className="field">
                        <span>Chave da API SMM</span>
                        <input
                          name="apiKey"
                          type="password"
                          required={!editor.row}
                          autoComplete="new-password"
                          placeholder={
                            editor.row ? 'Chave salva — preencha apenas para substituir' : ''
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Moeda da conta do provedor</span>
                        <select name="currency" defaultValue={editor.row?.currency ?? 'USD'}>
                          <option>USD</option>
                          <option>BRL</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Limite de consultas por minuto</span>
                        <input
                          name="requestsPerMinute"
                          type="number"
                          min={1}
                          max={300}
                          required
                          defaultValue={editor.row?.requestsPerMinute ?? 60}
                        />
                      </label>
                      <p className="muted">
                        Confira a moeda em Testar conexão. O catálogo SMM usa preço por 1.000
                        unidades; serviços Package usam preço por pacote.
                      </p>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>Descrição da categoria</span>
                        <textarea
                          name="description"
                          maxLength={300}
                          rows={3}
                          defaultValue={editor.row?.description ?? ''}
                        />
                      </label>
                      <label className="field">
                        <span>Ordem de exibição</span>
                        <input
                          name="sortOrder"
                          type="number"
                          required
                          min={0}
                          max={100000}
                          defaultValue={editor.row?.sortOrder ?? 0}
                        />
                      </label>
                    </>
                  )}
                  <label className="toggle">
                    <input
                      type="checkbox"
                      name="active"
                      defaultChecked={editor.row?.active ?? true}
                    />
                    <span>
                      {providers
                        ? 'Provedor ativo para novas vendas'
                        : 'Exibir categoria no WhatsApp'}
                    </span>
                  </label>
                </>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                Cancelar
              </button>
              <button
                className={editor.deleting ? 'primary delete-product-confirm' : 'primary'}
                disabled={busy}
              >
                {busy ? 'Salvando…' : editor.deleting ? 'Confirmar exclusão' : 'Salvar'}
              </button>
            </div>
          </form>
        </EditorDialog>
      )}
      {importing && (
        <CatalogImport
          smmProvider={{ id: importing.id, name: importing.name }}
          onError={onError}
          onClose={() => setImporting(null)}
          onImported={async () => {
            setImporting(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}
