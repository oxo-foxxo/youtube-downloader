import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.js';

interface LoginDialogProps {
  returnFocus: HTMLElement | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function LoginDialog({ returnFocus, busy, error, onClose, onConfirm }: LoginDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = returnFocus ?? document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [returnFocus]);

  return createPortal(
    <dialog
      ref={dialog}
      className="login-dialog"
      aria-labelledby="login-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <span className="section-kicker">ВАШ АККАУНТ</span>
          <h2 id="login-title">Вход в YouTube</h2>
          <p>Войдите на странице Google. Сессия сохранится в локальном сервисе.</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">
          <Icon name="close" />
        </button>
      </header>
      <iframe
        title="Браузер YouTube"
        src="/login/vnc.html?autoconnect=1&resize=remote&path=login%2Fwebsockify"
        allow="clipboard-read; clipboard-write"
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="login-actions">
        <span>
          <Icon name="lock" />
          Пароль и проверку Google вводите в окне выше.
        </span>
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Проверяем…' : 'Я вошёл'}
          <Icon name="check" />
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
