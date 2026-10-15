import { useEffect, useState } from 'react';
import { Download, LoaderCircle, Search, Package, RefreshCw } from 'lucide-react';
import { Decimal } from 'decimal.js';
import { api, HttpError } from './api';
import { EditorDialog } from './editor';
import './catalog-import.css';

type Service = {
  slug: string;
  name: string;
  code?: string;
  provider: { key: string; name: string };
  cost: string;
  currency: string;
  canImport: boolean;
  stock: number;
  available: boolean;
  imported: boolean;
  priceBasis?: number;
  minQuantity?: number;
  unsupportedReason?: string;
};
type Catalog = {
  data: Service[];
  providers: { key: string; name: string }[];
  total: number;
  page: number;
  limit: number;
};

export function CatalogImport({
  onClose,
  onImported,
  onError,
  smmProvider,
}: {
  onClose: () => void;
  onImported: (count: number) => Promise<void>;
  onError: (error: unknown) => void;
  smmProvider?: { id: string; name: string };
}) {
  const endpoint = smmProvider ? `/smm-providers/${smmProvider.id}` : '/products';
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState(new Map<string, string>());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search, query]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      search: query,
      provider,
      page: String(page),
      limit: '25',
    });
    void api<Catalog>(`${endpoint}/catalog?${params}`)
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setCatalog(null);
        setError(err instanceof Error ? err.message : 'Não foi possível consultar o catálogo.');
        if (err instanceof HttpError && err.status === 401) onError(err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, provider, page, reload, onError, endpoint]);
  useEffect(() => {
    if (smmProvider)
      void api<{ data: { id: string; name: string }[] }>('/categories')
        .then((r) => setCategories(r.data))
        .catch(onError);
  }, [endpoint, onError]);
  const available = catalog?.data.filter((service) => !service.imported && service.canImport) ?? [];
  const allSelected =
    available.length > 0 && available.every((service) => selected.has(service.slug));
  const pages = Math.max(1, Math.ceil((catalog?.total ?? 0) / 25));
  return (
    <EditorDialog
      title="Importar serviços"
      description={
        smmProvider
          ? `Selecione serviços de ${smmProvider.name} e organize na sua loja.`
          : 'Escolha os produtos da Partner que deseja adicionar à sua loja.'
      }
      icon={Download}
      onClose={onClose}
      busy={busy}
      error={error}
      wide
      footer={
        <div className="import-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            className="primary"
            disabled={busy || loading || search !== query || !selected.size || !catalog}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await api<{ imported: number }>(`${endpoint}/import`, 'POST', {
                  slugs: [...selected.keys()],
                  ...(smmProvider && categoryId ? { categoryId } : {}),
                });
                await onImported(result.imported);
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : 'Não foi possível importar os serviços.',
                );
                if (err instanceof HttpError && err.status === 401) onError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}Importar
            selecionados ({selected.size})
          </button>
        </div>
      }
    >
      <div className="catalog-import">
        {smmProvider && (
          <label className="field">
            <span>Categoria da loja</span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={busy}
            >
              <option value="">Criar/manter categorias do catálogo</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="import-filters">
          <label className="field">
            <span>Buscar serviços</span>
            <div className="import-search">
              <Search size={17} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Nome, código ou produto..."
                disabled={busy}
              />
            </div>
          </label>
          <label className="field">
            <span>Fornecedor</span>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setPage(1);
              }}
              disabled={busy}
            >
              <option value="">Todos os fornecedores</option>
              {catalog?.providers.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="import-summary">
          <span>
            {selected.size} selecionado(s) · {catalog?.total ?? 0} serviço(s) encontrado(s)
          </span>
          <button
            className="text-btn"
            disabled={busy || loading || !available.length}
            onClick={() => {
              setSelected((current) => {
                const next = new Map(current);
                for (const service of available) {
                  if (allSelected) next.delete(service.slug);
                  else if (next.size < 100) next.set(service.slug, service.name);
                }
                return next;
              });
            }}
          >
            {allSelected ? 'Desmarcar página' : 'Selecionar página'}
          </button>
        </div>
        <div className="import-services" aria-busy={loading}>
          {loading ? (
            <div className="import-empty" role="status">
              <LoaderCircle className="spin" size={24} />
              Consultando catálogo {smmProvider ? 'SMM' : 'da Partner'}…
            </div>
          ) : !catalog?.data.length ? (
            <div className="import-empty">
              <Package size={28} />
              <strong>{error ? 'Catálogo indisponível' : 'Nenhum serviço encontrado'}</strong>
              <p>
                {error
                  ? 'Confira a integração nas Configurações e tente novamente.'
                  : 'Altere a busca ou o fornecedor para encontrar serviços.'}
              </p>
              {error && (
                <button className="secondary" onClick={() => setReload((value) => value + 1)}>
                  <RefreshCw size={15} />
                  Tentar novamente
                </button>
              )}
            </div>
          ) : (
            catalog.data.map((service) => (
              <label
                key={service.slug}
                className={`import-service${selected.has(service.slug) ? ' selected' : ''}${service.imported ? ' imported' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(service.slug)}
                  disabled={
                    busy ||
                    service.imported ||
                    !service.canImport ||
                    (!selected.has(service.slug) && selected.size >= 100)
                  }
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSelected((current) => {
                      const next = new Map(current);
                      if (checked) next.set(service.slug, service.name);
                      else next.delete(service.slug);
                      return next;
                    });
                  }}
                  aria-label={`Selecionar ${service.name}`}
                />
                <span className="import-service-name">
                  <strong>{service.name}</strong>
                  <small>
                    {service.provider.name} · {service.code || service.slug}
                    {smmProvider && ` · Mín. ${service.minQuantity ?? 0} · Máx. ${service.stock}`}
                  </small>
                </span>
                <span className="import-service-cost">
                  <b>
                    {service.currency === 'USD' ? 'US$' : service.currency}{' '}
                    {new Decimal(service.cost).toFixed(2).replace('.', ',')}
                  </b>
                  {smmProvider && (
                    <small>por {service.priceBasis === 1 ? 'pacote' : '1.000 unidades'}</small>
                  )}
                  <small>
                    {!service.canImport
                      ? (service.unsupportedReason ?? 'Moeda sem suporte para importação')
                      : service.imported
                        ? 'Já importado'
                        : service.available
                          ? smmProvider
                            ? 'Sob demanda'
                            : `${service.stock} em estoque`
                          : 'Sem estoque'}
                  </small>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="import-pagination">
          <span>
            Página {page} de {pages}
          </span>
          <div>
            <button
              className="secondary"
              disabled={busy || loading || page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Anterior
            </button>
            <button
              className="secondary"
              disabled={busy || loading || page >= pages}
              onClick={() => setPage((value) => value + 1)}
            >
              Próxima
            </button>
          </div>
        </div>
        {selected.size > 0 && (
          <details className="import-selection">
            <summary>Revisar seleção ({selected.size})</summary>
            <ul>
              {[...selected].map(([slug, name]) => (
                <li key={slug}>
                  <span>{name}</span>
                  <button
                    className="text-btn"
                    disabled={busy}
                    onClick={() =>
                      setSelected((current) => {
                        const next = new Map(current);
                        next.delete(slug);
                        return next;
                      })
                    }
                    aria-label={`Remover ${name} da seleção`}
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="import-help">
          Os serviços serão adicionados para revisão. Depois de importar, defina o preço e autorize
          a revenda em Editar → Disponibilidade. Até 100 serviços por importação.
          {smmProvider
            ? ' SMM avulso: o preço é por 1.000 unidades ou por pacote, conforme indicado. Assinaturas automáticas não são importadas.'
            : ' A importação Partner suporta USD. Serviços em USDT ou outras moedas ficam indisponíveis para seleção.'}
        </p>
      </div>
    </EditorDialog>
  );
}
