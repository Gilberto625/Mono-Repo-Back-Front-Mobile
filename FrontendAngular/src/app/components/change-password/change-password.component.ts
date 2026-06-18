import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';

@Component({
  selector: 'app-change-password',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule
  ],
  templateUrl: './change-password.component.html',
  styleUrl: './change-password.component.css'
})
export class ChangePasswordComponent implements OnInit {
  changeForm!: FormGroup;
  loading = false;
  email: string = '';
  hideCurrentPassword = true;
  hideNewPassword = true;
  hideConfirmPassword = true;

  // Requisitos de contraseña
  passwordRequirements = {
    minLength: false,
    hasUpperCase: false,
    hasLowerCase: false,
    hasNumber: false
  };

  constructor(
    private fb: FormBuilder,
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

    // Crear formulario
    this.changeForm = this.fb.group({
      currentPassword: ['', [Validators.required]],
      newPassword: ['', [Validators.required, Validators.minLength(8)]],
      confirmPassword: ['', [Validators.required]]
    });

    // Escuchar cambios en la nueva contraseña para validar requisitos
    this.changeForm.get('newPassword')?.valueChanges.subscribe(password => {
      this.checkPasswordRequirements(password);
    });
  }

  checkPasswordRequirements(password: string): void {
    this.passwordRequirements.minLength = password.length >= 8;
    this.passwordRequirements.hasUpperCase = /[A-Z]/.test(password);
    this.passwordRequirements.hasLowerCase = /[a-z]/.test(password);
    this.passwordRequirements.hasNumber = /[0-9]/.test(password);
  }

  get allRequirementsMet(): boolean {
    return Object.values(this.passwordRequirements).every(req => req);
  }

  onSubmit(): void {
    if (this.changeForm.invalid) {
      this.showMessage('Por favor completa todos los campos correctamente', 'error');
      return;
    }

    const currentPassword = this.changeForm.value.currentPassword;
    const newPassword = this.changeForm.value.newPassword;
    const confirmPassword = this.changeForm.value.confirmPassword;

    if (newPassword !== confirmPassword) {
      this.showMessage('Las contraseñas no coinciden', 'error');
      return;
    }

    if (!this.allRequirementsMet) {
      this.showMessage('La nueva contraseña no cumple con todos los requisitos', 'error');
      return;
    }

    this.loading = true;

    this.authService.cambiarContrasena(this.email, currentPassword, newPassword).subscribe({
      next: (response) => {
        this.loading = false;

        if (response.ok) {
          this.showMessage('Contraseña cambiada exitosamente', 'success');

          // Redirigir al dashboard de seguridad después de cerrar el modal
          setTimeout(() => {
            this.router.navigate(['/security']);
          }, 500);
        }
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = error.error?.error || 'Error al cambiar contraseña';
        this.showMessage(errorMsg, 'error');
      }
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
