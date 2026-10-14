import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Decimal } from 'decimal.js';
import {
  LayoutDashboard,
  Package,
  Users,
  ShoppingBag,
  Wallet,
  MessageCircle,
  Settings,
  ScrollText,
  Shield,
  LogOut,
  Moon,
  Sun,
  Menu,
  X,
  RefreshCw,
  ChevronRight,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
  Store,
  Search,
  LoaderCircle,
  Plus,
} from 'lucide-react';
import { api, HttpError, type Row } from './api';
import './style.css';
import './filters.css';
import './theme.css';
import './glow';
import { EditorDialog, ProductFields } from './editor';
import { EvolutionActivation, activationReturn } from './evolution-activation';
const brl = (v: unknown) => `R$ ${new Decimal(String(v ?? 0)).toFixed(2).replace('.', ',')}`;
const usd = (v: unknown) => `US$ ${new Decimal(String(v ?? 0)).toFixed(2).replace('.', ',')}`;
const date = (v: unknown) => (v ? new Date(String(v)).toLocaleString('pt-BR') : '—');
const statusLabels: Record<string, string> = {
  RESERVED: 'Reservado',
  PROCESSING: 'Processando',
  UNKNOWN: 'Resultado incerto',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  REVIEW: 'Revisão manual',
  REFUNDED: 'Estornado',
  CREATING: 'Criando cobrança',
  PENDING: 'Pendente',
  APPROVED: 'Aprovado',
  EXPIRED: 'Expirado',
  CANCELLED: 'Cancelado',
  SENT: 'Enviado',
  SENDING: 'Enviando',
  open: 'Conectado',
  close: 'Desconectado',
  connecting: 'Conectando',
  error: 'Erro',
};
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${['COMPLETED', 'APPROVED', 'SENT', 'open'].includes(value) ? 'success' : ['UNKNOWN', 'REVIEW', 'FAILED', 'error'].includes(value) ? 'danger' : 'neutral'}`}
    >
      <i />
      {statusLabels[value] ?? value}
    </span>
  );
}
const navigation = [
  { id: 'dashboard', label: 'Visão geral', icon: LayoutDashboard },
  { id: 'products', label: 'Produtos', icon: Package },
  { id: 'customers', label: 'Clientes', icon: Users },
  { id: 'orders', label: 'Pedidos', icon: ShoppingBag },
  { id: 'payments', label: 'Depósitos Pix', icon: Wallet },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { id: 'settings', label: 'Configurações', icon: Settings },
  { id: 'logs', label: 'Logs e auditoria', icon: ScrollText },
  { id: 'admins', label: 'Administradores', icon: Shield },
];
const names: Record<string, string> = Object.fromEntries(navigation.map((x) => [x.id, x.label]));
function Field({
  label,
  name,
  type = 'text',
  defaultValue = '',
  required = false,
  placeholder,
  children,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: any;
  required?: boolean;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children ?? (
        <input
          name={name}
          type={type}
          defaultValue={defaultValue ?? ''}
          required={required}
          placeholder={placeholder}
          autoComplete={type === 'password' ? 'new-password' : 'off'}
          step={type === 'number' ? 'any' : undefined}
        />
      )}
    </label>
  );
}
function Toggle({ label, name, checked }: { label: string; name: string; checked: boolean }) {
  return (
    <label className="toggle">
      <input name={name} type="checkbox" defaultChecked={checked} />
      <span>{label}</span>
    </label>
  );
}
function Login({ onLogin, onError }: { onLogin: (a: Row) => void; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-brand">
        <div className="logo">
          <Store size={24} />
        </div>
        <b>Revenda</b>
        <span>Operação conectada.</span>
      </div>
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          try {
            const r = await api('/auth/login', 'POST', {
              email: f.get('email'),
              password: f.get('password'),
            });
            onLogin(r.admin);
          } catch (err) {
            onError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">PAINEL ADMINISTRATIVO</span>
        <h1>Bem-vindo de volta</h1>
        <p>Acesse a operação da sua loja.</p>
        <Field label="E-mail" name="email" type="email" required />
        <Field label="Senha" name="password" type="password" required />
        <button className="primary" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <>
              Entrar <ArrowUpRight size={18} />
            </>
          )}
        </button>
        <small>Use a conta criada durante a instalação.</small>
      </form>
      <footer>Revenda · WhatsApp & Partner API</footer>
    </main>
  );
}
function App() {
  const [admin, setAdmin] = useState<Row | null>(null),
    [booting, setBooting] = useState(true),
    [page, setPage] = useState(activationReturn ? 'whatsapp' : 'dashboard'),
    [sidebar, setSidebar] = useState(false),
    [dark, setDark] = useState(localStorage.getItem('theme') !== 'light'),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(1),
    [modal, setModal] = useState<{ type: string; row?: Row } | null>(null),
    [detail, setDetail] = useState<Row | null>(null),
    [messages, setMessages] = useState<Row[]>([]),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(null),
    [qr, setQr] = useState<Row | null>(null),
    [logTab, setLogTab] = useState('logs');
  const canConfigure = admin?.role === 'OWNER',
    canOperate = admin?.role !== 'VIEWER';
  const loadSequence = useRef(0);
  const [filter, setFilter] = useState(''),
    [chartDays, setChartDays] = useState('30');
  const [gatewayDraft, setGatewayDraft] = useState<string | null>(null);
  const report = useCallback((e: unknown) => {
    if (e instanceof HttpError && e.status === 401) setAdmin(null);
    setToast({ message: e instanceof Error ? e.message : String(e), error: true });
  }, []);
  const notify = (message: string) => setToast({ message, error: false });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    void api('/auth/me')
      .then((r) => setAdmin(r.admin))
      .catch(() => {})
      .finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(async () => {
    if (!admin) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const path =
        page === 'dashboard'
          ? `/dashboard?days=${chartDays}`
          : ['whatsapp', 'settings', 'admins'].includes(page)
            ? `/${page}`
            : page === 'logs'
              ? `/${logTab}?page=${offset}`
              : `/${page}?page=${offset}&search=${encodeURIComponent(query)}${page === 'products' ? `&filter=${filter}` : page === 'orders' && filter ? `&status=${filter}` : ''}`;
      const result = await api(path);
      if (sequence === loadSequence.current) setData(result);
    } catch (e) {
      if (sequence === loadSequence.current) report(e);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [admin, page, query, offset, logTab, report, filter, chartDays]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  async function act(path: string, method = 'POST', body?: unknown, message = 'Alteração salva.') {
    setBusy(true);
    try {
      const result = await api(path, method, body);
      notify(message);
      await load();
      return result;
    } catch (e) {
      report(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function open(type: string, row?: Row) {
    setToast(null);
    setDetail(null);
    setMessages([]);
    setQr(null);
    setModal({ type, row });
    if (type === 'customer' && row) void api(`/customers/${row.id}`).then(setDetail).catch(report);
    if (type === 'order' && row) void api(`/orders/${row.id}`).then(setDetail).catch(report);
  }
  function go(id: string) {
    setGatewayDraft(null);
    loadSequence.current++;
    setData(null);
    setPage(id);
    setSearch('');
    setQuery('');
    setFilter('');
    setOffset(1);
    setSidebar(false);
    setModal(null);
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form),
      type = modal?.type,
      row = modal?.row;
    const get = (key: string) => String(f.get(key) ?? '');
    try {
      if (type === 'product' && row) {
        const payload: Row = {
          active: f.has('active'),
          visible: f.has('visible'),
          authorizedResale: f.has('authorizedResale'),
          markupPercent: get('markupPercent'),
          fixedMargin: get('fixedMargin'),
          manualPrice: get('manualPrice') || null,
          promoPrice: get('promoPrice') || null,
          promoUntil: get('promoUntil') ? new Date(get('promoUntil')).toISOString() : null,
          roundingStep: get('roundingStep'),
          volumeDiscountPercent: get('volumeDiscountPercent'),
          volumeMinQuantity: Number(get('volumeMinQuantity')),
        };
        await act(`/products/${encodeURIComponent(row.slug)}`, 'PATCH', payload);
      }
      if (type === 'balance' && row)
        await act(`/customers/${row.id}/balance`, 'POST', {
          amount: get('amount'),
          reason: get('reason'),
          key: crypto.randomUUID(),
        });
      if (type === 'instance')
        await act('/whatsapp', 'POST', {
          name: get('name'),
          ...(get('number') ? { number: get('number') } : {}),
        });
      if (type === 'resend' && row)
        await act(
          `/deliveries/${row.id}/resend`,
          'POST',
          { reason: get('reason') },
          'Reenvio autorizado para o comprador original.',
        );
      if (type === 'refund' && row)
        await act(`/orders/${row.id}/refund`, 'POST', { reason: get('reason') });
      if (type === 'rate')
        await act('/exchange/manual', 'POST', {
          usdBrl: get('usdBrl'),
          validHours: Number(get('validHours')),
          reason: get('reason'),
        });
      if (type === 'admin')
        await act('/admins', 'POST', {
          email: get('email'),
          password: get('password'),
          role: get('role'),
        });
      if (type === 'editAdmin' && row)
        await act(`/admins/${row.id}`, 'PATCH', {
          disabled: f.has('disabled'),
          role: get('role'),
          ...(get('password') ? { password: get('password') } : {}),
        });
      setModal(null);
    } catch {}
  }
  const rows: Row[] = data?.data ?? (Array.isArray(data) ? data : []);
  const table = (headers: string[], render: (row: Row) => React.ReactNode) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id ?? row.slug ?? i}>{render(row)}</tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="empty">
          <Package size={32} />
          <h3>Nenhum registro encontrado</h3>
          <p>
            {page === 'products'
              ? 'Configure a Partner API e sincronize o catálogo.'
              : 'Os registros aparecerão conforme sua operação avançar.'}
          </p>
        </div>
      )}
    </div>
  );
  if (booting)
    return (
      <div className="full-loading">
        <LoaderCircle className="spin" /> Carregando sessão…
      </div>
    );
  return (
    <>
      {toast && (
        <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>
          {toast.error ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Fechar aviso">
            <X size={16} />
          </button>
        </div>
      )}
      {!admin ? (
        <Login
          onLogin={(a) => {
            setAdmin(a);
            go(activationReturn ? 'whatsapp' : 'dashboard');
          }}
          onError={report}
        />
      ) : (
        <div className="shell">
          <a className="skip-link" href="#main">
            Ir para o conteúdo
          </a>
          {sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
          <aside className={sidebar ? 'sidebar visible' : 'sidebar'}>
            <a className="brand" onClick={() => go('dashboard')}>
              <div className="logo">
                <Store size={21} />
              </div>
              <div>
                <b>Revenda</b>
                <small>CENTRAL DE OPERAÇÕES</small>
              </div>
            </a>
            <div className="sidebar-account">
              <div className="avatar">{String(admin.email).slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{String(admin.email).split('@')[0]}</strong>
                <small>
                  {admin.role === 'OWNER'
                    ? 'Administrador'
                    : admin.role === 'OPERATOR'
                      ? 'Operador'
                      : 'Somente leitura'}
                </small>
              </div>
              <ChevronRight size={14} />
            </div>
            <span className="nav-label">ADMINISTRAÇÃO</span>
            <nav>
              {navigation
                .filter((n) => canConfigure || !['settings', 'logs', 'admins'].includes(n.id))
                .map((n) => (
                  <button
                    key={n.id}
                    className={page === n.id ? 'active' : ''}
                    aria-current={page === n.id ? 'page' : undefined}
                    onClick={() => go(n.id)}
                  >
                    <n.icon size={19} />
                    <span>{n.label}</span>
                    {page === n.id && <ChevronRight size={15} />}
                  </button>
                ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="security">
                <Shield size={18} />
                <div>
                  <b>Sessão protegida</b>
                  <small>
                    {admin.role === 'OWNER'
                      ? 'Proprietário'
                      : admin.role === 'OPERATOR'
                        ? 'Operador'
                        : 'Leitura'}
                  </small>
                </div>
              </div>
              <button
                className="logout"
                onClick={() =>
                  void act('/auth/logout')
                    .then(() => setAdmin(null))
                    .catch(() => {})
                }
              >
                <LogOut size={17} /> Sair da conta
              </button>
            </div>
          </aside>
          <div className="workspace">
            <header>
              <button
                className="mobile-menu icon-btn"
                aria-label="Abrir menu"
                onClick={() => setSidebar(!sidebar)}
              >
                <Menu size={20} />
              </button>
              <div className="breadcrumb">
                Administração <ChevronRight size={14} />
                <strong>{names[page]}</strong>
              </div>
              <div className="header-right">
                <button
                  className="icon-btn"
                  onClick={() => setDark(!dark)}
                  aria-label="Alternar tema"
                >
                  {dark ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <div className="avatar">{String(admin.email).slice(0, 1).toUpperCase()}</div>
                <span className="admin-email">{admin.email}</span>
              </div>
            </header>
            <main className="content" key={page} id="main">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">SUA OPERAÇÃO, EM UM SÓ LUGAR</span>
                  <h1>{names[page]}</h1>
                  <p>
                    {page === 'dashboard'
                      ? 'Acompanhe vendas, clientes e a saúde da sua loja.'
                      : page === 'products'
                        ? 'Gerencie seu catálogo e as regras de revenda.'
                        : page === 'whatsapp'
                          ? 'Conecte sua loja e acompanhe o atendimento.'
                          : 'Consulte e gerencie os registros da operação.'}
                  </p>
                </div>
                <div className="heading-actions">
                  <button className="secondary" onClick={() => void load()} disabled={loading}>
                    <RefreshCw size={16} className={loading ? 'spin' : ''} /> Atualizar
                  </button>
                  {page === 'products' && canOperate && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void act('/products/sync').catch(() => {})}
                    >
                      <RefreshCw size={16} /> Sincronizar catálogo
                    </button>
                  )}
                  {page === 'whatsapp' && canConfigure && (
                    <button className="primary" onClick={() => open('instance')}>
                      <Plus size={17} /> Nova instância
                    </button>
                  )}
                  {page === 'admins' && canConfigure && (
                    <button className="primary" onClick={() => open('admin')}>
                      <Plus size={17} /> Administrador
                    </button>
                  )}
                </div>
              </div>
              {loading && !data ? (
                <div className="loading-panel">
                  <LoaderCircle className="spin" /> Consultando dados…
                </div>
              ) : !data ? (
                <div className="empty">
                  <AlertCircle />
                  <p>Não foi possível carregar os dados.</p>
                  <button className="secondary" onClick={() => void load()}>
                    Tentar novamente
                  </button>
                </div>
              ) : (
                <>
                  {page === 'dashboard' && (
                    <>
                      <div className="metrics">
                        {[
                          {
                            label: 'Faturamento',
                            value: brl(data.revenue),
                            icon: Wallet,
                            caption: 'Pedidos concluídos',
                          },
                          {
                            label: 'Lucro bruto realizado',
                            value: brl(data.profit),
                            icon: ArrowUpRight,
                            caption: `Estimado: ${brl(data.estimatedProfit)}`,
                          },
                          {
                            label: 'Pedidos concluídos',
                            value: data.completed,
                            icon: ShoppingBag,
                            caption: `${data.pending} aguardando conclusão`,
                          },
                          {
                            label: 'Clientes',
                            value: data.customers,
                            icon: Users,
                            caption: 'Contas na loja',
                          },
                        ].map((m) => (
                          <article className="metric" key={m.label}>
                            <div className="metric-top">
                              <span>{m.label}</span>
                              <m.icon size={19} />
                            </div>
                            <strong>{m.value}</strong>
                            <small>{m.caption}</small>
                          </article>
                        ))}
                      </div>
                      <div className="dashboard-grid">
                        <section className="card chart-card">
                          <div className="card-title">
                            <div>
                              <h2>Vendas nos últimos {chartDays} dias</h2>
                              <p>Faturamento diário em reais</p>
                            </div>
                            <span className="tag">{chartDays} dias</span>
                          </div>
                          {data.chart.length ? (
                            <div className="bars">
                              {data.chart.map((r: Row) => (
                                <div
                                  className="bar-column"
                                  key={r.day}
                                  title={`${r.day}: ${brl(r.revenue)}`}
                                >
                                  <span>{brl(r.revenue)}</span>
                                  <div
                                    className="bar"
                                    style={{
                                      height: `${Math.max(3, (Number(r.revenue) / Math.max(...data.chart.map((x: Row) => Number(x.revenue)), 1)) * 180)}px`,
                                    }}
                                  />
                                  <small>{String(r.day).slice(5).replace('-', '/')}</small>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="chart-empty">
                              <ShoppingBag size={30} />
                              <h3>As primeiras vendas começam aqui</h3>
                              <p>Conecte o WhatsApp, configure a cotação e ative os produtos.</p>
                            </div>
                          )}
                          <div className="chart-footer">
                            <span>{data.orders} pedidos registrados</span>
                            <button className="text-btn" onClick={() => go('orders')}>
                              Ver pedidos <ArrowUpRight size={15} />
                            </button>
                          </div>
                        </section>
                        <section className="card">
                          <div className="card-title">
                            <div>
                              <h2>Conexões da loja</h2>
                              <p>Disponibilidade dos serviços</p>
                            </div>
                            <span className="service-dot" />
                          </div>
                          {['database', 'redis', 'worker'].map((key) => (
                            <div className="service-row" key={key}>
                              <span>
                                {
                                  (
                                    {
                                      database: 'Banco de dados',
                                      redis: 'Redis e filas',
                                      worker: 'Worker de processamento',
                                    } as Record<string, string>
                                  )[key]
                                }
                              </span>
                              <Badge value={data.services[key] ? 'open' : 'close'} />
                            </div>
                          ))}
                          <div className="partner-card">
                            <Package size={21} />
                            <div>
                              <small>Saldo do fornecedor</small>
                              <strong>
                                {data.partnerBalance
                                  ? usd(data.partnerBalance.balance)
                                  : 'Não disponível'}
                              </strong>
                            </div>
                          </div>
                          <div className="service-row">
                            <span>Depósitos confirmados</span>
                            <b>{brl(data.deposits)}</b>
                          </div>
                        </section>
                      </div>
                      <section className="card">
                        <div className="card-title">
                          <div>
                            <h2>WhatsApp</h2>
                            <p>Instâncias conectadas à operação</p>
                          </div>
                          <button className="text-btn" onClick={() => go('whatsapp')}>
                            Gerenciar <ArrowUpRight size={15} />
                          </button>
                        </div>
                        {data.instances.length ? (
                          data.instances.map((r: Row) => (
                            <div className="service-row" key={r.name}>
                              <span>
                                <MessageCircle size={17} /> {r.name} {r.phone && `· +${r.phone}`}
                              </span>
                              <Badge value={r.state} />
                            </div>
                          ))
                        ) : (
                          <p className="muted">
                            Nenhuma instância cadastrada. Crie uma conexão para começar.
                          </p>
                        )}
                      </section>
                    </>
                  )}
                  {page === 'dashboard' && (
                    <section className="card period-control">
                      <label className="inline-form">
                        Período do gráfico
                        <select
                          aria-label="Período do gráfico"
                          value={chartDays}
                          onChange={(e) => setChartDays(e.target.value)}
                        >
                          <option value="7">7 dias</option>
                          <option value="30">30 dias</option>
                          <option value="90">90 dias</option>
                          <option value="365">1 ano</option>
                        </select>
                      </label>
                      {data.review > 0 && (
                        <button
                          className="text-btn"
                          onClick={() => {
                            go('orders');
                            setFilter('REVIEW');
                          }}
                        >
                          <AlertCircle size={16} />
                          {data.review} pedido(s) precisam de revisão manual
                        </button>
                      )}
                      {canConfigure && data.failedEvents > 0 && (
                        <button
                          className="text-btn"
                          onClick={() => {
                            go('logs');
                            setLogTab('events');
                          }}
                        >
                          <AlertCircle size={16} />
                          {data.failedEvents} evento(s) precisam de revisão
                        </button>
                      )}
                    </section>
                  )}
                  {['products', 'customers', 'orders', 'payments'].includes(page) && (
                    <section className="card list-card">
                      <div className="list-toolbar">
                        <div className="search">
                          <Search size={17} />
                          <input
                            placeholder={
                              page === 'payments'
                                ? 'Depósitos da operação'
                                : 'Buscar por nome, número ou código…'
                            }
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            disabled={page === 'payments'}
                          />
                        </div>
                        {['products', 'orders'].includes(page) && (
                          <select
                            className="list-filter"
                            aria-label="Filtrar registros"
                            value={filter}
                            onChange={(e) => {
                              setFilter(e.target.value);
                              setOffset(1);
                            }}
                          >
                            <option value="">Todos</option>
                            {page === 'products' ? (
                              <>
                                <option value="available">Disponíveis para venda</option>
                                <option value="unavailable">Sem estoque / indisponíveis</option>
                                <option value="unauthorized">Aguardando autorização</option>
                              </>
                            ) : (
                              Object.entries(statusLabels)
                                .filter(([key]) =>
                                  [
                                    'RESERVED',
                                    'PROCESSING',
                                    'UNKNOWN',
                                    'COMPLETED',
                                    'FAILED',
                                    'REVIEW',
                                    'REFUNDED',
                                  ].includes(key),
                                )
                                .map(([key, label]) => (
                                  <option key={key} value={key}>
                                    {label}
                                  </option>
                                ))
                            )}
                          </select>
                        )}
                        <span className="muted">{data.total} registros</span>
                      </div>
                      {page === 'products' &&
                        table(
                          [
                            'Produto',
                            'Fornecedor',
                            'Custo USD',
                            'Estoque',
                            'Venda / lucro estimado',
                            '',
                          ],
                          (r) => (
                            <>
                              <td>
                                <b>{r.name}</b>
                                <small>{r.slug}</small>
                              </td>
                              <td>{r.provider.name}</td>
                              <td>
                                {usd(r.costUsd)}
                                <small>Catálogo: {usd(r.catalogPriceUsd)}</small>
                              </td>
                              <td>
                                {r.stock}
                                <small>Máx. {r.maxQuantity}</small>
                              </td>
                              <td>
                                <Badge
                                  value={
                                    r.available && r.active && r.visible && r.authorizedResale
                                      ? 'open'
                                      : 'close'
                                  }
                                />
                                <small>
                                  {r.quote
                                    ? `${brl(r.quote.unitSaleBrl)} · Lucro ${brl(r.quote.estimatedProfitBrl)}`
                                    : 'Configure a cotação'}{' '}
                                  · {r.markupPercent}% {!r.authorizedResale && '· Revenda pendente'}
                                </small>
                              </td>
                              <td>
                                {canConfigure && (
                                  <button className="text-btn" onClick={() => open('product', r)}>
                                    Editar <ChevronRight size={15} />
                                  </button>
                                )}
                              </td>
                            </>
                          ),
                        )}
                      {page === 'customers' &&
                        table(
                          ['Cliente', 'WhatsApp', 'Saldo disponível', 'Reservado', 'Pedidos', ''],
                          (r) => (
                            <>
                              <td>
                                <b>{r.name}</b>
                                <small>
                                  {r.blocked
                                    ? 'Conta bloqueada'
                                    : r.humanUntil && new Date(r.humanUntil) > new Date()
                                      ? 'Atendimento humano'
                                      : 'Conta ativa'}
                                </small>
                              </td>
                              <td>+{r.phone}</td>
                              <td>{brl(r.wallet?.available)}</td>
                              <td>{brl(r.wallet?.reserved)}</td>
                              <td>{r._count.orders}</td>
                              <td>
                                <button className="text-btn" onClick={() => open('customer', r)}>
                                  Abrir <ChevronRight size={15} />
                                </button>
                              </td>
                            </>
                          ),
                        )}
                      {page === 'orders' &&
                        table(['Pedido', 'Cliente', 'Produto', 'Valor', 'Status', ''], (r) => (
                          <>
                            <td>
                              <b>#{r.id.slice(0, 8)}</b>
                              <small>{date(r.createdAt)}</small>
                            </td>
                            <td>
                              {r.customer.name}
                              <small>+{r.customer.phone}</small>
                            </td>
                            <td>
                              {r.items[0]?.name}
                              <small>{r.items[0]?.quantity} unidade(s)</small>
                            </td>
                            <td>
                              {brl(r.totalBrl)}
                              <small>
                                Lucro: {r.grossProfitBrl ? brl(r.grossProfitBrl) : 'Pendente'}
                              </small>
                            </td>
                            <td>
                              <Badge value={r.status} />
                            </td>
                            <td>
                              <button className="text-btn" onClick={() => open('order', r)}>
                                Detalhes <ChevronRight size={15} />
                              </button>
                            </td>
                          </>
                        ))}
                      {page === 'payments' &&
                        table(
                          ['Cobrança', 'Cliente', 'Valor', 'Gateway', 'Status', 'Data'],
                          (r) => (
                            <>
                              <td>
                                <b>#{r.id.slice(0, 8)}</b>
                                <small>{r.gatewayId ?? 'Aguardando referência'}</small>
                              </td>
                              <td>
                                {r.customer.name}
                                <small>+{r.customer.phone}</small>
                              </td>
                              <td>{brl(r.amountBrl)}</td>
                              <td>{r.gateway}</td>
                              <td>
                                <Badge value={r.status} />
                              </td>
                              <td>
                                {date(r.createdAt)}
                                <small>Vence: {date(r.expiresAt)}</small>
                              </td>
                            </>
                          ),
                        )}
                      <div className="pagination">
                        <span>
                          Página {offset} de {Math.max(1, Math.ceil(data.total / 25))}
                        </span>
                        <div>
                          <button
                            className="secondary"
                            disabled={offset === 1}
                            onClick={() => setOffset(offset - 1)}
                          >
                            Anterior
                          </button>
                          <button
                            className="secondary"
                            disabled={offset * 25 >= data.total}
                            onClick={() => setOffset(offset + 1)}
                          >
                            Próxima
                          </button>
                        </div>
                      </div>
                    </section>
                  )}
                  {page === 'whatsapp' && (
                    <>
                      {canConfigure && <EvolutionActivation />}
                      <div className="instance-grid">
                        {rows.length ? (
                          rows.map((r) => (
                            <section className="card instance" key={r.name}>
                              <div className="card-title">
                                <div className="instance-title">
                                  <div className="whatsapp-icon">
                                    <MessageCircle size={25} />
                                  </div>
                                  <div>
                                    <h2>{r.name}</h2>
                                    <p>{r.phone ? `+${r.phone}` : 'Número ainda não conectado'}</p>
                                  </div>
                                </div>
                                <Badge value={r.state} />
                              </div>
                              <div className="service-row">
                                <span>Atendimento automático</span>
                                <b>{r.botEnabled ? 'Ativo' : 'Pausado'}</b>
                              </div>
                              <div className="instance-actions">
                                {canOperate && (
                                  <>
                                    <button className="primary" onClick={() => open('connect', r)}>
                                      Conectar WhatsApp
                                    </button>
                                    <button
                                      className="secondary"
                                      onClick={() =>
                                        void act(`/whatsapp/${r.name}/restart`).catch(() => {})
                                      }
                                    >
                                      Reconectar
                                    </button>
                                    <button
                                      className="secondary"
                                      onClick={() =>
                                        void act(`/whatsapp/${r.name}`, 'PATCH', {
                                          botEnabled: !r.botEnabled,
                                        }).catch(() => {})
                                      }
                                    >
                                      {r.botEnabled ? 'Pausar bot' : 'Ativar bot'}
                                    </button>
                                  </>
                                )}
                                <button
                                  className="secondary"
                                  onClick={() =>
                                    void api(`/whatsapp/${r.name}/state`)
                                      .then(() => load())
                                      .catch(report)
                                  }
                                >
                                  Consultar conexão
                                </button>
                              </div>
                            </section>
                          ))
                        ) : (
                          <section className="card empty">
                            <MessageCircle size={36} />
                            <h3>Conecte sua primeira instância</h3>
                            <p>Crie a instância e escaneie o QR Code no WhatsApp.</p>
                            {canConfigure && (
                              <button className="primary" onClick={() => open('instance')}>
                                Criar instância
                              </button>
                            )}
                          </section>
                        )}
                      </div>
                    </>
                  )}
                  {page === 'settings' && (
                    <div className="settings-grid">
                      <section className="card">
                        <div className="card-title">
                          <div>
                            <h2>Identidade e atendimento</h2>
                            <p>Personalize a experiência dos clientes.</p>
                          </div>
                        </div>
                        <form
                          className="stack"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            try {
                              await act('/settings', 'PUT', {
                                'store.name': f.get('store'),
                                'human.hours': f.get('hours'),
                                'messages.welcome': f.get('welcome'),
                                'bot.messageStyle': f.get('messageStyle'),
                                'bot.activationKeywords': String(f.get('activationKeywords') ?? '')
                                  .split(/[,\n]/)
                                  .map((v) => v.trim())
                                  .filter(Boolean),
                              });
                            } catch {}
                          }}
                        >
                          <Field
                            name="store"
                            label="Nome da loja"
                            defaultValue={data.values['store.name'] ?? 'Nossa loja'}
                          />
                          <Field
                            name="hours"
                            label="Horários do suporte humano"
                            defaultValue={
                              data.values['human.hours'] ??
                              'Atendimento conforme disponibilidade da equipe.'
                            }
                          />
                          <Field
                            name="activationKeywords"
                            label="Palavras-chave para iniciar o bot"
                            defaultValue={(
                              data.values['bot.activationKeywords'] ?? [
                                'oi',
                                'olá',
                                'menu',
                                'início',
                                'suporte',
                                'atendente',
                                'humano',
                              ]
                            ).join(', ')}
                          />
                          <Field name="messageStyle" label="Formato do atendimento no WhatsApp">
                            <select
                              name="messageStyle"
                              defaultValue={data.values['bot.messageStyle'] ?? 'interactive'}
                            >
                              <option value="interactive">
                                Menu em lista e botões de confirmação
                              </option>
                              <option value="text">Menu em texto</option>
                            </select>
                          </Field>
                          <small>
                            Menu principal, carteira, categorias e produtos em listas. Botões para
                            confirmar a compra. A exibição depende da Evolution e do WhatsApp; se a
                            API rejeitar o formato, o atendimento continua em texto.
                          </small>
                          <small className="muted">
                            Separe palavras ou frases por vírgula. O bot inicia somente no privado
                            quando a mensagem corresponde a uma delas, ignorando maiúsculas e
                            acentos. Depois de iniciado, o cliente pode navegar pelas opções. Deixar
                            vazio impede iniciar novas conversas.
                          </small>
                          <Field name="welcome" label="Mensagem de boas-vindas">
                            <textarea
                              name="welcome"
                              rows={9}
                              defaultValue={
                                data.values['messages.welcome'] ??
                                '🛍️ Bem-vindo à {loja}, {nome}!\n\n1 - Ver produtos\n2 - Meu saldo\n3 - Adicionar saldo\n4 - Meus pedidos\n5 - Suporte\n6 - Minha conta'
                              }
                            />
                          </Field>
                          <small className="muted">
                            Placeholders: {'{nome}, {loja}, {produto}, {valor}, {pedido}'}
                          </small>
                          <button className="primary" disabled={busy}>
                            Salvar atendimento
                          </button>
                        </form>
                      </section>
                      <div className="stack">
                        <section className="card">
                          <div className="card-title">
                            <div>
                              <h2>Integrações</h2>
                              <p>Os segredos são armazenados com criptografia.</p>
                            </div>
                          </div>
                          <form
                            className="stack"
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const form = e.currentTarget;
                              const f = new FormData(form);
                              const payload: Row = {
                                'pix.gateway': f.get('gateway'),
                                'pix.expayStoreId': f.get('expayStore') || '',
                              };
                              for (const [field, key] of [
                                ['partner', 'secret.partnerKey'],
                                ['expayKey', 'secret.expayApiKey'],
                                ['token', 'secret.mpToken'],
                                ['webhook', 'secret.mpWebhookSecret'],
                              ])
                                if (f.get(field)) payload[key] = f.get(field);
                              try {
                                await act(
                                  '/settings',
                                  'PUT',
                                  payload,
                                  'Integrações salvas. As chaves ficam ocultas e não precisam ser digitadas novamente.',
                                );
                                for (const name of ['partner', 'expayKey', 'token', 'webhook']) {
                                  const input = form.elements.namedItem(name);
                                  if (input instanceof HTMLInputElement) input.value = '';
                                }
                              } catch {}
                            }}
                          >
                            <div className="integration-note">
                              <Shield size={18} />
                              <p>
                                As chaves salvas ficam ocultas.{' '}
                                <strong>“Configurada” confirma que a chave está armazenada.</strong>{' '}
                                Deixe o campo vazio para manter a chave atual; preencha somente para
                                substituí-la.
                              </p>
                            </div>
                            <Field
                              name="partner"
                              type="password"
                              label={`Partner API key ${data.secrets['secret.partnerKey'] || data.environment.partnerKey ? '· Configurada' : '· Pendente'}`}
                              placeholder={
                                data.secrets['secret.partnerKey'] || data.environment.partnerKey
                                  ? 'Chave salva — preencha apenas para substituir'
                                  : 'Cole sua chave da Partner API'
                              }
                            />
                            <Field name="gateway" label="Gateway Pix">
                              <select
                                name="gateway"
                                value={gatewayDraft ?? data.values['pix.gateway'] ?? 'disabled'}
                                onChange={(e) => setGatewayDraft(e.target.value)}
                              >
                                <option value="disabled">Desativado</option>
                                <option value="expay">Expay Brasil</option>
                                <option value="mercadopago">Mercado Pago</option>
                              </select>
                            </Field>
                            <div
                              className="gateway-fields stack"
                              hidden={(gatewayDraft ?? data.values['pix.gateway']) !== 'expay'}
                            >
                              <Field
                                name="expayKey"
                                type="password"
                                label={`Chave de API Expay ${data.secrets['secret.expayApiKey'] || data.environment.expayApiKey ? '· Configurada' : '· Pendente'}`}
                                placeholder={
                                  data.secrets['secret.expayApiKey'] || data.environment.expayApiKey
                                    ? 'Chave salva — preencha apenas para substituir'
                                    : 'Cole sua chave de API Expay'
                                }
                              />
                              <Field
                                name="expayStore"
                                label="ID da loja Expay (opcional)"
                                defaultValue={
                                  data.values['pix.expayStoreId'] ??
                                  data.environment.expayStoreId ??
                                  ''
                                }
                              />
                              <p className="muted">
                                Na Expay, configure o webhook da loja em /webhooks/pix/expay. O
                                sistema também consulta os pagamentos automaticamente. Deixe chaves
                                vazias para manter as credenciais.
                              </p>
                            </div>
                            <div
                              className="gateway-fields stack"
                              hidden={
                                (gatewayDraft ?? data.values['pix.gateway']) !== 'mercadopago'
                              }
                            >
                              <Field
                                name="token"
                                type="password"
                                label={`Access Token ${data.secrets['secret.mpToken'] || data.environment.mpToken ? '· Configurado' : '· Pendente'}`}
                                placeholder={
                                  data.secrets['secret.mpToken'] || data.environment.mpToken
                                    ? 'Token salvo — preencha apenas para substituir'
                                    : 'Cole o Access Token do Mercado Pago'
                                }
                              />
                              <Field
                                name="webhook"
                                type="password"
                                label={`Segredo de webhook ${data.secrets['secret.mpWebhookSecret'] || data.environment.mpWebhookSecret ? '· Configurado' : '· Pendente'}`}
                                placeholder={
                                  data.secrets['secret.mpWebhookSecret'] ||
                                  data.environment.mpWebhookSecret
                                    ? 'Segredo salvo — preencha apenas para substituir'
                                    : 'Cole o segredo de webhook do Mercado Pago'
                                }
                              />
                              <p className="muted">
                                Configure a URL de webhook no Mercado Pago: /webhooks/pix. Deixe os
                                campos secretos vazios para manter as credenciais.
                              </p>
                            </div>
                            <button className="primary" disabled={busy}>
                              Salvar integrações
                            </button>
                          </form>
                        </section>
                        <section className="card">
                          <div className="card-title">
                            <div>
                              <h2>Cotação USD / BRL</h2>
                              <p>Nenhuma cotação fictícia é aplicada.</p>
                            </div>
                          </div>
                          <form
                            className="inline-form"
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const f = new FormData(e.currentTarget);
                              try {
                                await act('/settings', 'PUT', {
                                  'exchange.provider': f.get('provider'),
                                });
                              } catch {}
                            }}
                          >
                            <select
                              name="provider"
                              defaultValue={data.values['exchange.provider'] ?? 'manual'}
                            >
                              <option value="manual">Cotação manual</option>
                              <option value="bcb">BCB · PTAX venda</option>
                            </select>
                            <button className="secondary" disabled={busy}>
                              Salvar
                            </button>
                          </form>
                          <div className="instance-actions">
                            <button className="secondary" onClick={() => open('rate')}>
                              Definir cotação manual
                            </button>
                            <button
                              className="secondary"
                              onClick={() => void act('/exchange/refresh').catch(() => {})}
                            >
                              Consultar BCB
                            </button>
                          </div>
                          <div className="rate-history">
                            {data.rates.map((r: Row) => (
                              <div className="service-row" key={r.id}>
                                <span>
                                  R$ {r.usdBrl}
                                  <small>
                                    {r.source.startsWith('manual:') ? 'Manual' : 'BCB PTAX'}
                                  </small>
                                </span>
                                <span className="muted">Válida até {date(r.expiresAt)}</span>
                              </div>
                            ))}
                          </div>
                          <p className="muted">
                            Backups diários e retenção são configurados pelo instalador. Consulte
                            docs/OPERACAO.md para restauração.
                          </p>
                        </section>
                      </div>
                    </div>
                  )}
                  {page === 'settings' && (
                    <section className="card">
                      <div className="card-title">
                        <div>
                          <h2>Mensagens automáticas</h2>
                          <p>
                            Edite as mensagens de cada etapa. Os menus e dados financeiros são
                            acrescentados pelo sistema.
                          </p>
                        </div>
                      </div>
                      <form
                        className="stack"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          try {
                            await act('/settings', 'PUT', Object.fromEntries(f.entries()));
                          } catch {}
                        }}
                      >
                        <div className="form-grid">
                          {data.templates.map((t: Row) => (
                            <Field key={t.key} name={`messages.${t.key}`} label={t.label}>
                              <textarea
                                name={`messages.${t.key}`}
                                rows={4}
                                defaultValue={t.text}
                                required
                              />
                            </Field>
                          ))}
                        </div>
                        <small className="muted">
                          Placeholders permitidos: {'{nome}, {loja}, {produto}, {valor}, {pedido}'}.
                          Utilize somente os campos disponíveis em cada etapa.
                        </small>
                        <button className="primary" disabled={busy}>
                          Salvar mensagens
                        </button>
                      </form>
                    </section>
                  )}
                  {page === 'logs' && (
                    <section className="card list-card">
                      <div className="tabs">
                        <button
                          className={logTab === 'logs' ? 'active' : ''}
                          onClick={() => setLogTab('logs')}
                        >
                          Requisições de API
                        </button>
                        <button
                          className={logTab === 'audit' ? 'active' : ''}
                          onClick={() => setLogTab('audit')}
                        >
                          Auditoria administrativa
                        </button>
                        <button
                          className={logTab === 'events' ? 'active' : ''}
                          onClick={() => setLogTab('events')}
                        >
                          Eventos em revisão
                        </button>
                      </div>
                      {logTab === 'logs'
                        ? table(
                            ['Serviço', 'Rota', 'Status', 'Código', 'Request ID', 'Data'],
                            (r) => (
                              <>
                                <td>{r.service}</td>
                                <td>
                                  {r.method} {r.route}
                                </td>
                                <td>
                                  {r.status ?? '—'}
                                  <small>{r.durationMs} ms</small>
                                </td>
                                <td>{r.code ?? '—'}</td>
                                <td>{r.requestId ?? '—'}</td>
                                <td>{date(r.createdAt)}</td>
                              </>
                            ),
                          )
                        : logTab === 'audit'
                          ? table(['Ação', 'Responsável', 'Registro', 'Dados', 'Data'], (r) => (
                              <>
                                <td>{r.action}</td>
                                <td>{String(r.actorId).slice(0, 12)}</td>
                                <td>{String(r.target).slice(0, 20)}</td>
                                <td>
                                  <code>{JSON.stringify(r.metadata)}</code>
                                </td>
                                <td>{date(r.createdAt)}</td>
                              </>
                            ))
                          : table(['Evento', 'Origem', 'Tentativas', 'Erro', 'Data', ''], (r) => (
                              <>
                                <td>{r.id.slice(0, 8)}</td>
                                <td>{r.source}</td>
                                <td>{r.attempts}</td>
                                <td>{r.errorCode}</td>
                                <td>{date(r.failedAt)}</td>
                                <td>
                                  <button
                                    className="text-btn"
                                    disabled={busy}
                                    onClick={() =>
                                      void act(`/events/${r.id}/retry`).catch(() => {})
                                    }
                                  >
                                    Reprocessar
                                  </button>
                                </td>
                              </>
                            ))}
                      <div className="pagination">
                        <button
                          className="secondary"
                          disabled={offset === 1}
                          onClick={() => setOffset(offset - 1)}
                        >
                          Anterior
                        </button>
                        <button
                          className="secondary"
                          disabled={rows.length < 25}
                          onClick={() => setOffset(offset + 1)}
                        >
                          Próxima
                        </button>
                      </div>
                    </section>
                  )}
                  {page === 'admins' && (
                    <section className="card list-card">
                      {table(['E-mail', 'Permissão', 'Status', 'Criado em', ''], (r) => (
                        <>
                          <td>{r.email}</td>
                          <td>{r.role}</td>
                          <td>{r.disabled ? 'Desativado' : 'Ativo'}</td>
                          <td>{date(r.createdAt)}</td>
                          <td>
                            {r.id !== admin.id && (
                              <button className="text-btn" onClick={() => open('editAdmin', r)}>
                                Gerenciar
                              </button>
                            )}
                          </td>
                        </>
                      ))}
                    </section>
                  )}
                </>
              )}
              <footer className="content-footer">
                <span>Revenda · Central de operações</span>
                <span>Valores financeiros em BRL · Fornecedor em USD</span>
              </footer>
            </main>
          </div>
          {modal && (
            <EditorDialog
              key={modal.type + (modal.row?.id ?? modal.row?.slug ?? modal.row?.name ?? '')}
              title={
                (
                  {
                    product: 'Regras de venda',
                    customer: 'Cliente',
                    order: 'Detalhes do pedido',
                    balance: 'Ajuste de carteira',
                    instance: 'Nova instância',
                    connect: 'Conectar WhatsApp',
                    resend: 'Reenviar entrega',
                    refund: 'Estornar pedido',
                    rate: 'Cotação manual',
                    admin: 'Novo administrador',
                    editAdmin: 'Gerenciar administrador',
                  } as Record<string, string>
                )[modal.type] ?? 'Detalhes'
              }
              description={
                modal.type === 'product'
                  ? 'Personalize preços, ofertas e disponibilidade do produto.'
                  : modal.type === 'connect'
                    ? 'Conecte o número da sua loja ao atendimento.'
                    : 'Consulte os detalhes e gerencie sua operação.'
              }
              icon={
                modal.type === 'product'
                  ? Package
                  : ['customer', 'admin', 'editAdmin'].includes(modal.type)
                    ? Users
                    : ['instance', 'connect'].includes(modal.type)
                      ? MessageCircle
                      : ['balance', 'rate', 'refund'].includes(modal.type)
                        ? Wallet
                        : ShoppingBag
              }
              wide={modal.type === 'product'}
              onClose={() => setModal(null)}
              busy={busy}
              error={toast?.error ? toast.message : undefined}
            >
              {['customer', 'order'].includes(modal.type) ? (
                !detail ? (
                  <div className="loading-panel">
                    <LoaderCircle className="spin" /> Carregando…
                  </div>
                ) : modal.type === 'customer' ? (
                  <div className="stack">
                    <div className="detail-title">
                      <h3>{detail.name}</h3>
                      <p>+{detail.phone}</p>
                    </div>
                    <div className="mini-metrics">
                      <div>
                        <small>Disponível</small>
                        <b>{brl(detail.wallet?.available)}</b>
                      </div>
                      <div>
                        <small>Reservado</small>
                        <b>{brl(detail.wallet?.reserved)}</b>
                      </div>
                    </div>
                    <div className="instance-actions">
                      {canConfigure && (
                        <button className="secondary" onClick={() => open('balance', detail)}>
                          Ajustar saldo
                        </button>
                      )}
                      {canOperate && (
                        <>
                          <button
                            className="secondary"
                            onClick={() =>
                              void act(`/customers/${detail.id}`, 'PATCH', {
                                blocked: !detail.blocked,
                              })
                                .then(() => setModal(null))
                                .catch(() => {})
                            }
                          >
                            {detail.blocked ? 'Desbloquear' : 'Bloquear'}
                          </button>
                          <button
                            className="secondary"
                            onClick={() =>
                              void act(`/customers/${detail.id}`, 'PATCH', { humanUntil: null })
                                .then(() => setModal(null))
                                .catch(() => {})
                            }
                          >
                            Liberar automação
                          </button>
                          <button
                            className="secondary"
                            onClick={() =>
                              void api<Row[]>(`/messages/${detail.id}`)
                                .then(setMessages)
                                .catch(report)
                            }
                          >
                            Histórico de mensagens
                          </button>
                        </>
                      )}
                    </div>
                    <h3>Movimentações financeiras</h3>
                    <div className="compact-list">
                      {detail.wallet?.entries.map((r: Row) => (
                        <div key={r.id}>
                          <span>
                            {r.kind}
                            <small>
                              {r.reason} · {date(r.createdAt)}
                            </small>
                          </span>
                          <b>{brl(r.availableDelta)}</b>
                        </div>
                      ))}
                    </div>
                    <h3>Pedidos</h3>
                    <div className="compact-list">
                      {detail.orders.map((r: Row) => (
                        <button className="service-row" key={r.id} onClick={() => open('order', r)}>
                          #{r.id.slice(0, 8)} <Badge value={r.status} />
                        </button>
                      ))}
                    </div>
                    {messages.length > 0 && (
                      <>
                        <h3>Mensagens</h3>
                        <div className="message-history">
                          {messages.map((r) => (
                            <div key={r.id} className={r.direction === 'OUT' ? 'out' : 'in'}>
                              <small>
                                {date(r.createdAt)} · {statusLabels[r.status]}
                              </small>
                              <p>{r.text}</p>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                    {canOperate && (
                      <form
                        className="stack"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          try {
                            await act(
                              `/messages/${detail.id}`,
                              'POST',
                              { instanceName: f.get('instanceName'), text: f.get('text') },
                              'Mensagem enfileirada.',
                            );
                            setModal(null);
                          } catch {}
                        }}
                      >
                        <h3>Responder como atendente</h3>
                        <Field name="instanceName" label="Instância WhatsApp" required />
                        <Field name="text" label="Mensagem">
                          <textarea name="text" rows={3} required />
                        </Field>
                        <button className="primary" disabled={busy}>
                          Enviar ao cliente
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                  <div className="stack">
                    <div className="detail-title">
                      <h3>#{detail.id.slice(0, 8)}</h3>
                      <Badge value={detail.status} />
                      <p>
                        {detail.customer.name} · +{detail.customer.phone}
                      </p>
                    </div>
                    <dl className="detail-grid">
                      <div>
                        <dt>Total</dt>
                        <dd>{brl(detail.totalBrl)}</dd>
                      </div>
                      <div>
                        <dt>Custo realizado</dt>
                        <dd>{detail.actualCostUsd ? usd(detail.actualCostUsd) : 'Pendente'}</dd>
                      </div>
                      <div>
                        <dt>Cotação utilizada</dt>
                        <dd>R$ {detail.usdBrl}</dd>
                      </div>
                      <div>
                        <dt>Lucro bruto</dt>
                        <dd>{detail.grossProfitBrl ? brl(detail.grossProfitBrl) : 'Pendente'}</dd>
                      </div>
                      <div>
                        <dt>Pedido externo</dt>
                        <dd>{detail.externalOrderCode ?? 'Aguardando'}</dd>
                      </div>
                      <div>
                        <dt>Erro</dt>
                        <dd>{detail.errorCode ?? 'Nenhum'}</dd>
                      </div>
                    </dl>
                    <div className="instance-actions">
                      {canOperate && !detail.reservationSettled && (
                        <>
                          <button
                            className="secondary"
                            onClick={() =>
                              void act(`/orders/${detail.id}/reconcile`)
                                .then(() => setModal(null))
                                .catch(() => {})
                            }
                          >
                            Reconciliar
                          </button>
                          <button
                            className="secondary"
                            onClick={() =>
                              void act(`/orders/${detail.id}/review`)
                                .then(() => setModal(null))
                                .catch(() => {})
                            }
                          >
                            Revisão manual
                          </button>
                        </>
                      )}
                      {canConfigure && detail.status === 'COMPLETED' && (
                        <button className="secondary" onClick={() => open('refund', detail)}>
                          Estornar carteira
                        </button>
                      )}
                    </div>
                    <h3>Entregas</h3>
                    <p className="muted">
                      O conteúdo protegido é enviado somente ao número comprador.
                    </p>
                    {detail.deliveries.map((r: Row) => (
                      <div className="service-row" key={r.id}>
                        <span>
                          {r.type}
                          <small>{r.lineCode}</small>
                        </span>
                        <Badge value={r.status} />
                        {canOperate && detail.status === 'COMPLETED' && (
                          <button className="text-btn" onClick={() => open('resend', r)}>
                            Reenviar
                          </button>
                        )}
                      </div>
                    ))}
                    <h3>Tentativas de processamento</h3>
                    <div className="compact-list">
                      {detail.attempts.map((r: Row) => (
                        <div key={r.id}>
                          <span>
                            {r.operation} · {r.outcome}
                            <small>
                              {r.errorCode} {r.requestId}
                            </small>
                          </span>
                          <small>{date(r.createdAt)}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              ) : modal.type === 'connect' ? (
                <div className="stack">
                  <p>Escaneie o QR Code em WhatsApp → Dispositivos conectados.</p>
                  {qr?.base64 && (
                    <img
                      className="qr-image"
                      src={String(qr.base64)}
                      alt="QR Code para conectar WhatsApp"
                    />
                  )}
                  {qr?.pairingCode && <div className="pairing-code">{String(qr.pairingCode)}</div>}
                  <form
                    className="stack"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      setBusy(true);
                      try {
                        setQr(
                          await api(
                            `/whatsapp/${modal.row?.name}/connect`,
                            'POST',
                            f.get('number') ? { number: String(f.get('number')) } : {},
                          ),
                        );
                      } catch (err) {
                        report(err);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Field name="number" label="Número com DDI (opcional para pareamento)" />
                    <button className="primary" disabled={busy}>
                      {busy ? 'Consultando…' : 'Gerar QR Code / pareamento'}
                    </button>
                  </form>
                  <button
                    className="secondary"
                    onClick={() =>
                      void api(`/whatsapp/${modal.row?.name}/state`)
                        .then((r) => {
                          notify(statusLabels[r.state] ?? r.state);
                          void load();
                        })
                        .catch(report)
                    }
                  >
                    Verificar conexão
                  </button>
                </div>
              ) : (
                <form className="modal-form" onSubmit={submit}>
                  <div
                    className={modal.type === 'product' ? 'product-body' : 'editor-scroll stack'}
                  >
                    {modal.type === 'product' && <ProductFields row={modal.row!} />}
                    {modal.type === 'balance' && (
                      <>
                        <p>
                          Ajuste registrado em ledger e auditoria. Use valor negativo para debitar.
                        </p>
                        <Field name="amount" label="Valor do ajuste (R$)" required />
                        <Field
                          name="reason"
                          label="Justificativa (mínimo 10 caracteres)"
                          required
                        />
                      </>
                    )}
                    {modal.type === 'instance' && (
                      <>
                        <Field
                          name="name"
                          label="Identificador (letras, números, hífen)"
                          required
                        />
                        <Field name="number" label="Número com DDI (opcional)" />
                      </>
                    )}
                    {['refund', 'resend'].includes(modal.type) && (
                      <>
                        <p>
                          {modal.type === 'resend'
                            ? 'O envio será feito ao comprador original. Verifique o histórico antes de repetir uma entrega com envio incerto.'
                            : 'O valor será devolvido à carteira local. Este procedimento não reembolsa o custo pago ao fornecedor.'}
                        </p>
                        <Field
                          name="reason"
                          label="Justificativa (mínimo 10 caracteres)"
                          required
                        />
                      </>
                    )}
                    {modal.type === 'rate' && (
                      <>
                        <Field name="usdBrl" label="Valor real de 1 USD em BRL" required />
                        <Field
                          name="validHours"
                          type="number"
                          label="Validade em horas (até 168)"
                          defaultValue="24"
                          required
                        />
                        <Field
                          name="reason"
                          label="Fonte / justificativa (mínimo 10 caracteres)"
                          required
                        />
                      </>
                    )}
                    {['admin', 'editAdmin'].includes(modal.type) && (
                      <>
                        {modal.type === 'admin' && (
                          <Field name="email" type="email" label="E-mail" required />
                        )}
                        <Field
                          name="password"
                          type="password"
                          label="Senha (mínimo 14 caracteres)"
                          required={modal.type === 'admin'}
                        />
                        <Field name="role" label="Permissão">
                          <select name="role" defaultValue={modal.row?.role ?? 'OPERATOR'}>
                            <option value="OWNER">Proprietário</option>
                            <option value="OPERATOR">Operador</option>
                            <option value="VIEWER">Somente leitura</option>
                          </select>
                        </Field>
                        {modal.type === 'editAdmin' && (
                          <Toggle
                            name="disabled"
                            label="Desativar administrador"
                            checked={modal.row?.disabled}
                          />
                        )}
                      </>
                    )}
                  </div>
                  <div className="modal-actions">
                    <small>
                      <span className="required-mark">*</span> Campos obrigatórios
                    </small>
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => setModal(null)}
                    >
                      Cancelar
                    </button>
                    <button className="primary" disabled={busy}>
                      {busy ? 'Salvando…' : 'Salvar'}
                    </button>
                  </div>
                </form>
              )}
            </EditorDialog>
          )}
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
