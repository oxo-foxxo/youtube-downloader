import { useEffect, useRef, useState } from 'react';
import type { SessionStatus } from '../shared/contracts.js';
import type { ApiClient } from './api.js';
import { LoginDialog } from './components/LoginDialog.js';
import { Icon } from './components/Icon.js';
import { messageOf } from './format.js';

type PanelState = SessionStatus['state'] | 'loading';
const labels: Record<PanelState, { title: string; description: string }> = {
  loading: { title: 'Аккаунт YouTube', description: 'Проверяем подключение…' },
  connected: { title: 'YouTube подключён', description: 'Сессия сохранена на этом компьютере' },
  disconnected: {
    title: 'Аккаунт YouTube',
    description: 'Войдите, если YouTube запрашивает подтверждение',
  },
  expired: { title: 'Войдите в YouTube снова', description: 'Сессия истекла или требует проверки' },
  unavailable: {
    title: 'Аккаунт YouTube',
    description: 'Браузер входа пока недоступен. Попробуйте ещё раз',
  },
};

export function SessionPanel({ api }: { api: NonNullable<ApiClient['session']> }) {
  const loginButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<PanelState>('loading');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.status();
        if (active) setState(result.state);
      } catch {
        if (active) setState('unavailable');
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);

  async function action(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  const showBrowser = () =>
    action(async () => {
      await api.open();
      setOpen(true);
    });
  const logout = () =>
    action(async () => {
      await api.logout();
      setState('disconnected');
      setOpen(false);
    });
  const confirm = () =>
    action(async () => {
      const result = await api.confirm();
      setState(result.state);
      if (result.state === 'connected') setOpen(false);
      else setError('Вход пока не завершён. Завершите его в окне выше и нажмите «Я вошёл»');
    });

  return (
    <>
      <div className={`session-bar session-${state}`}>
        <div className="session-icon">
          <Icon name={state === 'connected' ? 'check' : 'play'} />
        </div>
        <div className="session-copy">
          <strong>{labels[state].title}</strong>
          <small>{labels[state].description}</small>
        </div>
        <div className="session-actions">
          <button
            type="button"
            ref={loginButton}
            className="secondary"
            disabled={busy || state === 'loading'}
            onClick={() => void showBrowser()}
          >
            {state === 'connected' ? 'Открыть YouTube' : 'Войти в YouTube'}
            <Icon name="arrow" />
          </button>
          {(state === 'connected' || state === 'expired') && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              title="Выйти и отменить незавершённые загрузки"
              onClick={() => void logout()}
            >
              Выйти
            </button>
          )}
        </div>
      </div>
      {error && !open && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <LoginDialog
          returnFocus={loginButton.current}
          busy={busy}
          error={error}
          onClose={() => setOpen(false)}
          onConfirm={() => void confirm()}
        />
      )}
    </>
  );
}
