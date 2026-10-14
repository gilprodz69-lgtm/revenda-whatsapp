import { useCallback, useEffect, useState } from 'react';
import { Shield, RefreshCw, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { api } from './api';

export const activationReturn = window.location.pathname === '/evolution/activate';
const returnedCode = activationReturn
  ? (new URL(window.location.href).searchParams.get('code') ?? '')
  : '';
// The callback code stays in memory; keep it out of browser history and subsequent requests.
if (activationReturn) window.history.replaceState({}, '', '/');

export function EvolutionActivation() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState(returnedCode.slice(0, 2000));
  const refresh = useCallback(async () => {
    setError('');
    try {
      const result = await api('/whatsapp/license');
      setStatus(result.status);
    } catch (e) {
      setStatus('unavailable');
      setError(e instanceof Error ? e.message : 'Não foi possível consultar a Evolution.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function register() {
    setBusy(true);
    setError('');
    try {
      const result = await api('/whatsapp/license/register', 'POST', {});
      if (result.status === 'active') setStatus('active');
      else setUrl(result.registerUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível iniciar a ativação.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card activation-card">
      <div className="card-title">
        <div className="instance-title">
          <div className="editor-heading-icon">
            <Shield size={21} />
          </div>
          <div>
            <h2>Evolution 2.4.0-rc2</h2>
            <p>Ativação da integração com o WhatsApp</p>
          </div>
        </div>
        <button
          className="icon-btn"
          type="button"
          onClick={() => void refresh()}
          aria-label="Consultar ativação"
          disabled={busy}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {status === 'active' ? (
        <div className="activation-status">
          <CheckCircle2 size={18} />
          <span>Evolution ativada. Você já pode conectar o WhatsApp.</span>
        </div>
      ) : (
        <div className="stack">
          <p>
            Esta versão exige ativação no cadastro oficial da Evolution. Suas instâncias e sessões
            permanecem salvas. Após concluir o cadastro, volte ao painel para confirmar o código
            recebido.
          </p>
          {status === 'inactive' && (
            <small>O envio de mensagens ficará pendente até a ativação.</small>
          )}
          <div className="instance-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy || status === null || status === 'unavailable'}
              onClick={() => void register()}
            >
              {busy ? 'Consultando…' : 'Iniciar ativação'}
            </button>
            {url && (
              <a className="primary" href={url} target="_blank" rel="noopener noreferrer">
                Abrir cadastro oficial <ArrowUpRight size={16} />
              </a>
            )}
          </div>
          <form
            className="activation-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api('/whatsapp/license/activate', 'POST', { code });
                setCode('');
                setUrl('');
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Não foi possível confirmar a ativação.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              <span>Código de ativação da Evolution</span>
              <input
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                minLength={6}
                maxLength={2000}
                autoComplete="off"
              />
            </label>
            <button className="primary" disabled={busy || !code.trim()}>
              Confirmar ativação
            </button>
          </form>
        </div>
      )}
      {error && (
        <p className="activation-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
