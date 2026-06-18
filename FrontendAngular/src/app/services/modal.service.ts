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

@Injectable({
  providedIn: 'root'
})
export class ModalService {
  
  /**
   * Mostrar modal de alerta
   */
  showAlert(options: ModalOptions): void {
    const modal = this.createModal(options);
    document.body.appendChild(modal);
    
    // Animar entrada
    setTimeout(() => {
      modal.classList.add('show');
    }, 10);
  }

  /**
   * Mostrar modal de éxito
   */
  showSuccess(message: string, title: string = 'Éxito'): void {
    this.showAlert({
      title,
      message,
      type: 'success'
    });
  }

  /**
   * Mostrar modal de error
   */
  showError(message: string, title: string = 'Error'): void {
    this.showAlert({
      title,
      message,
      type: 'error'
    });
  }

  /**
   * Mostrar modal de información
   */
  showInfo(message: string, title: string = 'Información'): void {
    this.showAlert({
      title,
      message,
      type: 'info'
    });
  }

  /**
   * Mostrar modal de advertencia
   */
  showWarning(message: string, title: string = 'Advertencia'): void {
    this.showAlert({
      title,
      message,
      type: 'warning'
    });
  }

  /**
   * Mostrar modal de confirmación
   */
  showConfirm(options: ModalOptions): void {
    const modal = this.createModal({
      ...options,
      showCancel: true,
      confirmText: options.confirmText || 'Confirmar',
      cancelText: options.cancelText || 'Cancelar'
    });
    document.body.appendChild(modal);
    
    setTimeout(() => {
      modal.classList.add('show');
    }, 10);
  }

  /**
   * Crear elemento modal
   */
  private createModal(options: ModalOptions): HTMLElement {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    
    const icon = this.getIcon(options.type || 'info');
    const typeClass = options.type || 'info';
    
    modal.innerHTML = `
      <div class="modal-container">
        <div class="modal-header ${typeClass}">
          <span class="modal-icon">${icon}</span>
          <div class="modal-title-wrapper">
            <h2 class="modal-title">${options.title || this.getDefaultTitle(options.type)}</h2>
            ${options.subtitle ? `<p class="modal-subtitle">${options.subtitle}</p>` : ''}
          </div>
          <button class="modal-close">×</button>
        </div>
        <div class="modal-body">
          <p class="modal-message">${options.message}</p>
        </div>
        <div class="modal-footer">
          ${options.showCancel 
            ? `<button class="modal-btn modal-btn-cancel">${options.cancelText || 'Cancelar'}</button>`
            : ''
          }
          <button class="modal-btn modal-btn-confirm ${typeClass}">
            ${options.confirmText || 'Aceptar'}
          </button>
        </div>
      </div>
    `;
    
    // Agregar eventos
    const closeBtn = modal.querySelector('.modal-close');
    const confirmButton = modal.querySelector('.modal-btn-confirm');
    const cancelButton = modal.querySelector('.modal-btn-cancel');
    
    // Botón cerrar
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.closeModal(modal);
      });
    }
    
    // Botón confirmar
    if (confirmButton) {
      confirmButton.addEventListener('click', () => {
        if (options.onConfirm) {
          options.onConfirm();
        }
        this.closeModal(modal);
      });
    }
    
    // Botón cancelar
    if (cancelButton) {
      cancelButton.addEventListener('click', () => {
        if (options.onCancel) {
          options.onCancel();
        }
        this.closeModal(modal);
      });
    }
    
    // Cerrar al hacer clic fuera del modal
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModal(modal);
      }
    });
    
    // Cerrar con ESC
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal(modal);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
    
    return modal;
  }

  /**
   * Cerrar modal
   */
  private closeModal(modal: HTMLElement): void {
    modal.classList.remove('show');
    setTimeout(() => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal);
      }
    }, 300);
  }

  /**
   * Obtener icono según tipo
   */
  private getIcon(type: string): string {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✗';
      case 'warning': return '⚠';
      case 'info': return 'ℹ';
      default: return 'ℹ';
    }
  }

  /**
   * Obtener título por defecto
   */
  private getDefaultTitle(type?: string): string {
    switch (type) {
      case 'success': return 'Éxito';
      case 'error': return 'Error';
      case 'warning': return 'Advertencia';
      case 'info': return 'Información';
      default: return 'Mensaje';
    }
  }
}

