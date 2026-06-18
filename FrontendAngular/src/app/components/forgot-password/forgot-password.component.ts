import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule
  ],
  templateUrl: './forgot-password.component.html',
  styleUrl: './forgot-password.component.css'
})
export class ForgotPasswordComponent implements OnInit {
  readonly theme = inject(ThemeService);

  emailForm!: FormGroup;
  otpForm!: FormGroup;
  loading = false;
  step: 'email' | 'verify-otp' = 'email';
  userEmail: string = '';
  tempToken: string = '';

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private modalService: ModalService
  ) {}

  ngOnInit(): void {
    // Evita que una sesión previa "contamine" el flujo de recuperación.
    this.authService.logout();

    // Obtener CSRF token
    this.authService.getCsrfToken().subscribe();

    // Crear formulario para email
    this.emailForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]]
    });

    // Crear formulario para OTP
    this.otpForm = this.fb.group({
      codigo: ['', [Validators.required, Validators.pattern(/^[0-9]{6}$/)]]
    });
  }

  onSubmitEmail(): void {
    // Marcar como touched para mostrar errores
    Object.keys(this.emailForm.controls).forEach(key => {
      this.emailForm.get(key)?.markAsTouched();
    });

    if (this.emailForm.invalid) {
      return;
    }

    this.loading = true;
    const email = this.emailForm.value.email.trim();
    this.userEmail = email;

    // Solo método de OTP por email
    this.authService.solicitarRecuperacionOTP(email).subscribe({
      next: (response) => {
        this.loading = false;
        if (response.ok && response.tempToken) {
          this.tempToken = response.tempToken;
          this.step = 'verify-otp';
          
          // Manejar diferentes casos de respuesta
          if (response.email_enviado === false) {
            // Correo no enviado: en DEBUG el backend puede devolver codigo_otp para desarrollo local
            if (response.codigo_otp) {
              this.modalService.showInfo(
                `El servidor no pudo enviar el correo (Brevo sin configurar o error de red). ` +
                  `En modo desarrollo el código se muestra aquí para que puedas continuar: ${response.codigo_otp}. ` +
                  `En producción configura BREVO_API_KEY en el backend.`,
                'Correo no enviado'
              );
            } else if (response.error_email) {
              // Error al enviar email pero permitir continuar
              this.modalService.showWarning(
                `El correo no se pudo enviar: ${response.error_email}. Puedes continuar con el código si lo recibiste, o contacta al administrador.`,
                'Advertencia'
              );
            } else {
              // Caso genérico
              this.showSuccess('Si el correo existe, se enviará un código de recuperación.');
            }
          } else {
            // Email enviado correctamente
            this.showSuccess('Código enviado a tu correo. Revisa tu bandeja de entrada.');
          }
        } else if (response.ok && response.mensaje && !response.tempToken) {
          // Usuario no existe pero respuesta OK (por seguridad) - similar a registro
          this.showSuccess(response.mensaje);
          // No avanzar al paso de verificación OTP si no hay tempToken
        } else {
          this.showError('No se pudo procesar la solicitud. Intenta nuevamente.');
        }
      },
      error: (error) => {
        this.loading = false;
        console.error('Error en recuperación:', error);
        
        // Manejar diferentes tipos de errores
        let errorMsg = 'Error al enviar código OTP';
        
        if (error.status === 0) {
          errorMsg = 'No se pudo conectar con el servidor. Verifica tu conexión.';
        } else if (error.status === 400) {
          errorMsg = error.error?.error || 'Datos inválidos';
        } else if (error.status === 404) {
          errorMsg = 'Endpoint no encontrado. Verifica que el backend esté desplegado correctamente.';
        } else if (error.status === 500) {
          errorMsg = 'Error interno del servidor. Intenta más tarde.';
        } else if (error.error?.error) {
          errorMsg = error.error.error;
        }
        
        this.showError(errorMsg);
      }
    });
  }

  onSubmitOTP(): void {
    // Marcar como touched para mostrar errores
    Object.keys(this.otpForm.controls).forEach(key => {
      this.otpForm.get(key)?.markAsTouched();
    });

    if (this.otpForm.invalid) {
      return;
    }

    this.loading = true;
    const codigo = this.otpForm.value.codigo;

    this.authService.verificarOTPRecuperacion(this.tempToken, codigo).subscribe({
      next: (response) => {
        this.loading = false;
        if (response.ok) {
          this.showSuccess('Código verificado correctamente');
          const verifiedToken = response.tempToken || this.tempToken;
          
          // Guardar datos para reset-password
          localStorage.setItem('recoveryTempToken', verifiedToken);
          localStorage.setItem('recoveryEmail', this.userEmail);
          localStorage.setItem('recoveryMethod', 'otp');
          
          // Redirigir a cambiar contraseña después de cerrar el modal
          setTimeout(() => {
            this.router.navigate(['/reset-password']);
          }, 500);
        }
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = error.error?.error || 'Código incorrecto o expirado';
        this.showError(errorMsg);
      }
    });
  }

  onResendOTP(): void {
    if (!this.userEmail) {
      return;
    }

    this.loading = true;
    this.authService.reenviarOTPRecuperacion(this.userEmail).subscribe({
      next: (response) => {
        this.loading = false;
        if (response.ok) {
          if (response.email_enviado === false && response.codigo_otp) {
            this.modalService.showInfo(
              `No se pudo enviar el correo. Nuevo código (solo desarrollo): ${response.codigo_otp}. ` +
                `Configura Brevo (BREVO_API_KEY) en el servidor para envío real.`,
              'Correo no enviado'
            );
          } else if (response.email_enviado === false) {
            this.modalService.showWarning(
              response.mensaje || 'No se pudo enviar el correo. Intenta más tarde o revisa la configuración del servidor.',
              'Advertencia'
            );
          } else {
            this.showSuccess('Nuevo código enviado a tu correo');
          }
        }
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = error.error?.error || 'Error al reenviar código';
        this.showError(errorMsg);
      }
    });
  }

  goBack(): void {
    if (this.step === 'verify-otp') {
      this.step = 'email';
      this.otpForm.reset();
    }
  }

  private showError(message: string): void {
    this.modalService.showError(message);
  }

  private showSuccess(message: string): void {
    this.modalService.showSuccess(message);
  }
}
