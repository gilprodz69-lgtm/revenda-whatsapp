import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Package, Wallet, Tags, Eye, X, Shield, type LucideIcon } from 'lucide-react';
import type { Row } from './api';

export function EditorDialog({
  title,
  description,
  icon: Icon = Package,
  children,
  onClose,
  busy,
  error,
  wide,
  footer,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
  error?: string;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  const saving = useRef(busy);
  close.current = onClose;
  saving.current = busy;
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    document.body.classList.add('modal-open');
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.classList.remove('modal-open');
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(e) => {
        e.preventDefault();
        if (!saving.current) close.current();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const controls = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            'button, input, select, textarea, a[href], [tabindex]',
          ),
        ).filter(
          (el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || saving.current) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < box.left ||
          e.clientX > box.right ||
          e.clientY < box.top ||
          e.clientY > box.bottom
        )
          close.current();
      }}
    >
      <div className="modal-frame">
        <div className="modal-header">
          <span className="editor-heading-icon">
            <Icon size={21} />
          </span>
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
            <p id={`${id}-description`}>{description}</p>
          </div>
          <button
            className="icon-btn editor-close"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>
        {error && (
          <div className="editor-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-content">{children}</div>
        {footer}
      </div>
    </dialog>
  );
}

const tabs = [
  { label: 'Preços', icon: Wallet },
  { label: 'Promoções', icon: Tags },
  { label: 'Disponibilidade', icon: Eye },
  { label: 'Apresentação', icon: Package },
];
function ProductField({
  label,
  name,
  value,
  type = 'text',
  required = false,
}: {
  label: string;
  name: string;
  value?: unknown;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <span className="required-mark"> *</span>}
      </span>
      <input
        name={name}
        defaultValue={String(value ?? '')}
        type={type}
        step={type === 'number' ? 'any' : undefined}
        required={required}
        autoComplete="off"
      />
    </label>
  );
}
export function ProductFields({ row }: { row: Row }) {
  const [selected, select] = useState(0);
  const id = useId();
  const nav = useRef<HTMLDivElement>(null);
  return (
    <div
      className="editor-body"
      onInvalidCapture={(e) => {
        const input = e.target as HTMLInputElement;
        const panel = input.closest<HTMLElement>('[data-editor-section]');
        if (panel?.hidden) {
          e.preventDefault();
          select(Number(panel.dataset.editorSection));
          requestAnimationFrame(() => {
            input.focus();
            input.reportValidity();
          });
        }
      }}
    >
      <aside className="editor-nav">
        <span className="editor-nav-label">Regras do produto</span>
        <div
          role="tablist"
          aria-label="Seções do produto"
          ref={nav}
          onKeyDown={(e) => {
            const next =
              e.key === 'ArrowRight' || e.key === 'ArrowDown'
                ? (selected + 1) % tabs.length
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                  ? (selected + tabs.length - 1) % tabs.length
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? tabs.length - 1
                      : null;
            if (next === null) return;
            e.preventDefault();
            select(next);
            (nav.current?.children[next] as HTMLButtonElement)?.focus();
          }}
        >
          {tabs.map((tab, index) => (
            <button
              className="editor-tab"
              type="button"
              role="tab"
              key={tab.label}
              id={`${id}-tab-${index}`}
              aria-controls={`${id}-panel-${index}`}
              aria-selected={selected === index}
              tabIndex={selected === index ? 0 : -1}
              onClick={() => select(index)}
            >
              <tab.icon size={17} />
              {tab.label}
            </button>
          ))}
        </div>
        <div className="editor-product">
          <Package size={18} />
          <strong>{row.name}</strong>
          <small>Regras aplicadas às próximas vendas.</small>
        </div>
      </aside>
      <div className="editor-scroll">
        <section
          role="tabpanel"
          id={`${id}-panel-3`}
          aria-labelledby={`${id}-tab-3`}
          hidden={selected !== 3}
          data-editor-section="3"
        >
          <h3>Apresentação na loja</h3>
          <p className="editor-section-description">
            Estes textos aparecem no WhatsApp e são mantidos ao sincronizar o fornecedor.
          </p>
          <div className="stack">
            <label className="field">
              <span id={`${id}-name-label`}>Nome na loja</span>
              <input
                name="displayName"
                aria-labelledby={`${id}-name-label`}
                aria-describedby={`${id}-name-help`}
                defaultValue={row.displayName ?? ''}
                maxLength={150}
                placeholder={row.supplierName ?? row.name}
                autoComplete="off"
              />
              <small id={`${id}-name-help`}>Deixe vazio para usar o nome do fornecedor.</small>
            </label>
            <label className="field">
              <span id={`${id}-description-label`}>Descrição no WhatsApp</span>
              <textarea
                name="description"
                aria-labelledby={`${id}-description-label`}
                aria-describedby={`${id}-description-help`}
                defaultValue={row.description ?? ''}
                maxLength={2500}
                rows={8}
                placeholder="Escreva a descrição que seus clientes vão receber."
              />
              <small id={`${id}-description-help`}>
                Até 2.500 caracteres. A descrição do fornecedor não é enviada automaticamente.
              </small>
            </label>
          </div>
        </section>
        <section
          role="tabpanel"
          id={`${id}-panel-0`}
          aria-labelledby={`${id}-tab-0`}
          hidden={selected !== 0}
          data-editor-section="0"
        >
          <h3>Preço de venda</h3>
          <p className="editor-section-description">
            Defina suas margens ou informe um preço manual em reais.
          </p>
          <div className="form-grid">
            <ProductField
              name="markupPercent"
              label="Margem sobre custo (%)"
              value={row.markupPercent}
              required
            />
            <ProductField
              name="fixedMargin"
              label="Margem fixa por unidade (R$)"
              value={row.fixedMargin}
              required
            />
            <ProductField name="manualPrice" label="Preço manual (R$)" value={row.manualPrice} />
            <ProductField
              name="roundingStep"
              label="Passo de arredondamento (R$)"
              value={row.roundingStep}
              required
            />
          </div>
          <div className="editor-tip">
            <Wallet size={18} />
            <p>
              Deixe o preço manual vazio para calcular a venda usando custo, cotação e margens
              configuradas.
            </p>
          </div>
        </section>
        <section
          role="tabpanel"
          id={`${id}-panel-1`}
          aria-labelledby={`${id}-tab-1`}
          hidden={selected !== 1}
          data-editor-section="1"
        >
          <h3>Promoções e volume</h3>
          <p className="editor-section-description">
            Configure ofertas por prazo e descontos para compras em quantidade.
          </p>
          <div className="form-grid">
            <ProductField name="promoPrice" label="Preço promocional (R$)" value={row.promoPrice} />
            <ProductField
              name="promoUntil"
              type="datetime-local"
              label="Promoção até"
              value={
                row.promoUntil
                  ? new Date(
                      new Date(row.promoUntil).getTime() - new Date().getTimezoneOffset() * 60000,
                    )
                      .toISOString()
                      .slice(0, 16)
                  : ''
              }
            />
            <ProductField
              name="volumeDiscountPercent"
              label="Desconto por volume (%)"
              value={row.volumeDiscountPercent}
            />
            <ProductField
              name="volumeMinQuantity"
              type="number"
              label="Quantidade mínima para desconto"
              value={row.volumeMinQuantity}
            />
          </div>
        </section>
        <section
          role="tabpanel"
          id={`${id}-panel-2`}
          aria-labelledby={`${id}-tab-2`}
          hidden={selected !== 2}
          data-editor-section="2"
        >
          <h3>Disponibilidade no catálogo</h3>
          <p className="editor-section-description">
            Controle quais produtos podem aparecer no atendimento pelo WhatsApp.
          </p>
          <div className="stack permission-box">
            <label className="toggle">
              <input type="checkbox" name="active" defaultChecked={row.active} />
              <span>Produto ativo</span>
            </label>
            <label className="toggle">
              <input type="checkbox" name="visible" defaultChecked={row.visible} />
              <span>Visível no WhatsApp</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                name="authorizedResale"
                defaultChecked={row.authorizedResale}
              />
              <span>Confirmo a procedência e a autorização de revenda</span>
            </label>
          </div>
          <div className="editor-tip">
            <Shield size={18} />
            <p>
              O bot oferece somente produtos ativos, visíveis, autorizados e com estoque disponível.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
