import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, AbstractControl, ValidationErrors } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule
  ],
  templateUrl: './reset-password.component.html',
  styleUrl: './reset-password.component.css'
})
export class ResetPasswordComponent implements OnInit {
  readonly theme = inject(ThemeService);

  resetForm!: FormGroup;
  loading = false;
  tempToken: string = '';
  hidePassword = true;
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
    // Obtener tempToken del localStorage
    this.tempToken = localStorage.getItem('recoveryTempToken') || '';

    if (!this.tempToken) {
      this.showError('No se encontró token de recuperación. Por favor, solicita uno nuevo.');
      setTimeout(() => {
        this.router.navigate(['/forgot-password']);
      }, 500);
      return;
    }

    // Obtener CSRF token
    this.authService.getCsrfToken().subscribe();

    // Crear formulario con validaciones
    this.resetForm = this.fb.group({
      password: ['', [Validators.required, Validators.minLength(8), this.passwordStrengthValidator]],
      confirmPassword: ['', [Validators.required]]
    });

    // Escuchar cambios en la contraseña para validar requisitos
    this.resetForm.get('password')?.valueChanges.subscribe(password => {
      this.checkPasswordRequirements(password);
    });
  }

  /**
   * Validador personalizado: verifica que la contraseña tenga mayúscula, minúscula y número
   */
  passwordStrengthValidator(control: AbstractControl): ValidationErrors | null {
    const value = control.value;
    
    if (!value) {
      return null;
    }

    const hasUpperCase = /[A-Z]/.test(value);
    const hasLowerCase = /[a-z]/.test(value);
    const hasNumber = /[0-9]/.test(value);

    const passwordValid = hasUpperCase && hasLowerCase && hasNumber;

    return passwordValid ? null : { 
      passwordStrength: {
        hasUpperCase,
        hasLowerCase,
        hasNumber
      }
    };
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

  togglePasswordVisibility(): void {
    this.hidePassword = !this.hidePassword;
  }

  toggleConfirmPasswordVisibility(): void {
    this.hideConfirmPassword = !this.hideConfirmPassword;
  }

  onSubmit(): void {
    // Marcar todos los campos como touched para mostrar errores
    Object.keys(this.resetForm.controls).forEach(key => {
      this.resetForm.get(key)?.markAsTouched();
    });

    if (this.resetForm.invalid) {
      this.showError('Por favor completa todos los campos correctamente');
      return;
    }

    const password = this.resetForm.value.password;
    const confirmPassword = this.resetForm.value.confirmPassword;

    if (password !== confirmPassword) {
      this.showError('Las contraseñas no coinciden');
      return;
    }

    if (!this.allRequirementsMet) {
      this.showError('La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número');
      return;
    }

    this.loading = true;

    // Determinar qué método usar según el origen
    const recoveryMethod = localStorage.getItem('recoveryMethod') || 'secret';
    
    let updateObservable;
    if (recoveryMethod === 'otp') {
      // Usar el método OTP
      updateObservable = this.authService.actualizarContrasenaOTP(this.tempToken, password);
    } else {
      // Usar el método tradicional de restablecer contraseña
      updateObservable = this.authService.restablecerContrasena(this.tempToken, password);
    }

    updateObservable.subscribe({
      next: (response) => {
        this.loading = false;
        if (response.ok) {
          this.showSuccess('¡Contraseña actualizada exitosamente!');
          
          // Limpiar localStorage
          localStorage.removeItem('recoveryTempToken');
          localStorage.removeItem('recoveryEmail');
          localStorage.removeItem('recoveryMethod');

          // Redirigir al login después de cerrar el modal
          setTimeout(() => {
            this.router.navigate(['/login']);
          }, 500);
        }
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = error.error?.error || error.error?.message || 'Error al actualizar contraseña';
        this.showError(errorMsg);
      }
    });
  }

  private showError(message: string): void {
    this.modalService.showError(message);
  }

  private showSuccess(message: string): void {
    this.modalService.showSuccess(message);
  }
}
