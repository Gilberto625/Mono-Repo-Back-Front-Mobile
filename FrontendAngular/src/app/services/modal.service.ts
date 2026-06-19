import { Injectable } from '@angular/core';

export interface ModalOptions {
  title?: string;
  subtitle?: string;
  message: string;
  type?: 'success' | 'error' | 'info' | 'warning';
  showCancel?: boolean;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

@Injectable({ providedIn: 'root' })
export class ModalService {
  showAlert(options: ModalOptions): void {
    const modal = this.createModal(options);
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
  }

  showSuccess(message: string, title = 'Éxito'): void {
    this.showAlert({ title, message, type: 'success' });
  }

  showError(message: string, title = 'Error'): void {
    this.showAlert({ title, message, type: 'error' });
  }

  showInfo(message: string, title = 'Información'): void {
    this.showAlert({ title, message, type: 'info' });
  }

  showWarning(message: string, title = 'Advertencia'): void {
    this.showAlert({ title, message, type: 'warning' });
  }

  showConfirm(options: ModalOptions): void {
    this.showAlert({
      ...options,
      showCancel: true,
      confirmText: options.confirmText || 'Confirmar',
      cancelText: options.cancelText || 'Cancelar'
    });
  }

  private createModal(options: ModalOptions): HTMLElement {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    const typeClass = options.type || 'info';

    const textElement = (tag: string, className: string, text: string): HTMLElement => {
      const element = document.createElement(tag);
      element.className = className;
      element.textContent = text;
      return element;
    };

    const container = document.createElement('div');
    container.className = 'modal-container';
    const header = document.createElement('div');
    header.className = `modal-header ${typeClass}`;
    header.appendChild(textElement('span', 'modal-icon', this.getIcon(typeClass)));

    const titleWrapper = document.createElement('div');
    titleWrapper.className = 'modal-title-wrapper';
    titleWrapper.appendChild(textElement('h2', 'modal-title', options.title || this.getDefaultTitle(options.type)));
    if (options.subtitle) {
      titleWrapper.appendChild(textElement('p', 'modal-subtitle', options.subtitle));
    }
    header.appendChild(titleWrapper);

    const closeButton = textElement('button', 'modal-close', '×');
    header.appendChild(closeButton);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.appendChild(textElement('p', 'modal-message', options.message));

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    let cancelButton: HTMLElement | null = null;
    if (options.showCancel) {
      cancelButton = textElement('button', 'modal-btn modal-btn-cancel', options.cancelText || 'Cancelar');
      footer.appendChild(cancelButton);
    }
    const confirmButton = textElement('button', `modal-btn modal-btn-confirm ${typeClass}`, options.confirmText || 'Aceptar');
    footer.appendChild(confirmButton);
    container.append(header, body, footer);
    modal.appendChild(container);

    closeButton.addEventListener('click', () => this.closeModal(modal));
    confirmButton.addEventListener('click', () => {
      options.onConfirm?.();
      this.closeModal(modal);
    });
    cancelButton?.addEventListener('click', () => {
      options.onCancel?.();
      this.closeModal(modal);
    });
    modal.addEventListener('click', (event) => {
      if (event.target === modal) this.closeModal(modal);
    });

    const escHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.closeModal(modal);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
    return modal;
  }

  private closeModal(modal: HTMLElement): void {
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 300);
  }

  private getIcon(type: string): string {
    const icons: Record<string, string> = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    return icons[type] || icons['info'];
  }

  private getDefaultTitle(type?: string): string {
    const titles: Record<string, string> = {
      success: 'Éxito', error: 'Error', warning: 'Advertencia', info: 'Información'
    };
    return type ? titles[type] || 'Mensaje' : 'Mensaje';
  }
}
