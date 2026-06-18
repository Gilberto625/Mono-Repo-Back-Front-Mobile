import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';

@Component({
  selector: 'app-backup-codes',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule
  ],
  templateUrl: './backup-codes.component.html',
  styleUrl: './backup-codes.component.css'
})
export class BackupCodesComponent implements OnInit {
  loading = false;
  backupCodes: string[] = [];
  email: string = '';

  constructor(
    private authService: AuthService,
    private router: Router,
    private modalService: ModalService
  ) {}

  ngOnInit(): void {
    // Obtener email del usuario actual
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.showMessage('Debes iniciar sesión primero', 'error');
      setTimeout(() => {
        this.router.navigate(['/login']);
      }, 500);
      return;
    }

    this.email = currentUser.email;

    // Obtener CSRF token
    this.authService.getCsrfToken().subscribe();

    // Generar códigos automáticamente al cargar
    this.generateCodes();
  }

  generateCodes(): void {
    this.loading = true;

    this.authService.generarCodigosRespaldo(this.email).subscribe({
      next: (response) => {
        this.loading = false;

        if (response.ok && response.codigos) {
          this.backupCodes = response.codigos;
          this.showMessage('Códigos de respaldo generados exitosamente', 'success');
        } else {
          this.showMessage('Error al generar códigos de respaldo', 'error');
        }
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = error.error?.error || 'Error al generar códigos de respaldo';
        this.showMessage(errorMsg, 'error');
      }
    });
  }

  downloadCodes(): void {
    if (this.backupCodes.length === 0) {
      this.showMessage('No hay códigos para descargar', 'warning');
      return;
    }

    const codesText = this.backupCodes.join('\n');
    const blob = new Blob([codesText], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'backup-codes.txt';
    link.click();
    window.URL.revokeObjectURL(url);

    this.showMessage('Códigos descargados como backup-codes.txt', 'success');
  }

  copyCodes(): void {
    if (this.backupCodes.length === 0) {
      this.showMessage('No hay códigos para copiar', 'warning');
      return;
    }

    const codesText = this.backupCodes.join('\n');
    navigator.clipboard.writeText(codesText).then(() => {
      this.showMessage('Códigos copiados al portapapeles', 'success');
    }).catch(() => {
      this.showMessage('Error al copiar los códigos', 'error');
    });
  }

  goToSecurity(): void {
    this.router.navigate(['/security']);
  }

  private showMessage(message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info'): void {
    if (type === 'error') {
      this.modalService.showError(message);
    } else if (type === 'success') {
      this.modalService.showSuccess(message);
    } else if (type === 'warning') {
      this.modalService.showWarning(message);
    } else {
      this.modalService.showInfo(message);
    }
  }
}
