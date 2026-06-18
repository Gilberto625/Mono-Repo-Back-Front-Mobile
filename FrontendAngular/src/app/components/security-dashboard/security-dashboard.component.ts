import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService, EstadoSeguridad } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';

@Component({
  selector: 'app-security-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule
  ],
  templateUrl: './security-dashboard.component.html',
  styleUrl: './security-dashboard.component.css'
})
export class SecurityDashboardComponent implements OnInit {
  loading = false;
  email: string = '';
  estadoSeguridad: EstadoSeguridad = {
    email_2fa: true,
    totp_habilitado: false,
    codigos_respaldo_disponibles: 0,
    tiene_preguntas_seguridad: false
  };

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

    // Cargar estado de seguridad
    this.loadSecurityStatus();
  }

  loadSecurityStatus(): void {
    this.loading = true;

    this.authService.obtenerEstadoSeguridad(this.email).subscribe({
      next: (estado) => {
        this.loading = false;
        this.estadoSeguridad = estado;
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = error.error?.error || 'Error al cargar estado de seguridad';
        this.showMessage(errorMsg, 'error');
        // Usar valores por defecto en caso de error
        this.estadoSeguridad = {
          email_2fa: false,
          totp_habilitado: false,
          codigos_respaldo_disponibles: 0,
          tiene_preguntas_seguridad: false
        };
      }
    });
  }

  setupTOTP(): void {
    this.router.navigate(['/setup-totp']);
  }

  generateBackupCodes(): void {
    this.router.navigate(['/backup-codes']);
  }

  changePassword(): void {
    this.router.navigate(['/change-password']);
  }

  goHome(): void {
    this.router.navigate(['/cliente']);
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
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
