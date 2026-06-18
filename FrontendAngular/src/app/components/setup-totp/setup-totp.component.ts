import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';

@Component({
  selector: 'app-setup-totp',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule
  ],
  templateUrl: './setup-totp.component.html',
  styleUrl: './setup-totp.component.css'
})
export class SetupTotpComponent implements OnInit {
  verifyForm!: FormGroup;
  loading = false;
  qrCodeUrl: SafeUrl = '';
  secretKey: string = '';
  email: string = '';
  currentStep: number = 1;

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private modalService: ModalService,
    private sanitizer: DomSanitizer
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

    // Crear formulario de verificación
    this.verifyForm = this.fb.group({
      codigo: ['', [Validators.required, Validators.pattern(/^[0-9]{6}$/)]]
    });

    // Configurar TOTP
    this.configureTOTP();
  }

  configureTOTP(): void {
    this.loading = true;

    // Nota: Este endpoint no está implementado en el backend aún
    this.authService.configurarTOTP(this.email).subscribe({
      next: (response) => {
        this.loading = false;

        // El QR viene en base64
        this.qrCodeUrl = this.sanitizer.bypassSecurityTrustUrl(response.qr_code);
        this.secretKey = response.secret;
        this.currentStep = 1; // Iniciar en el primer paso
      },
      error: (error) => {
        this.loading = false;
        // Si el endpoint no existe, mostrar mensaje informativo
        console.warn('Endpoint de TOTP no disponible');
        this.showMessage('La configuración de TOTP no está disponible en este momento. Esta funcionalidad estará disponible próximamente.', 'warning');
        // Redirigir de vuelta a seguridad después de cerrar el modal
        setTimeout(() => {
          this.router.navigate(['/security']);
        }, 2000);
      }
    });
  }

  onVerify(): void {
    if (this.verifyForm.invalid) {
      this.showMessage('Ingresa un código válido de 6 dígitos', 'error');
      return;
    }

    this.loading = true;
    const codigo = this.verifyForm.value.codigo;

    // Nota: Este endpoint no está implementado en el backend aún
    this.authService.habilitarTOTP(this.email, codigo).subscribe({
      next: (response) => {
        this.loading = false;

        if (response.ok) {
          this.showMessage('TOTP habilitado exitosamente', 'success');

          // Redirigir al dashboard de seguridad después de cerrar el modal
          setTimeout(() => {
            this.router.navigate(['/security']);
          }, 500);
        }
      },
      error: (error) => {
        this.loading = false;
        // Si el endpoint no existe, mostrar mensaje informativo
        console.warn('Endpoint de habilitar TOTP no disponible');
        this.showMessage('La habilitación de TOTP no está disponible en este momento. Esta funcionalidad estará disponible próximamente.', 'warning');
        // Redirigir de vuelta a seguridad después de cerrar el modal
        setTimeout(() => {
          this.router.navigate(['/security']);
        }, 2000);
      }
    });
  }

  copySecretKey(): void {
    navigator.clipboard.writeText(this.secretKey).then(() => {
      this.showMessage('Clave secreta copiada al portapapeles', 'success');
    }).catch(() => {
      this.showMessage('Error al copiar la clave', 'error');
    });
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
