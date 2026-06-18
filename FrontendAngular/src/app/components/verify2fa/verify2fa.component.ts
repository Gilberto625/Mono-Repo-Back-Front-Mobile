import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterModule, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-verify2fa',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule
  ],
  templateUrl: './verify2fa.component.html',
  styleUrl: './verify2fa.component.css'
})
export class Verify2faComponent implements OnInit, OnDestroy {
  readonly theme = inject(ThemeService);

  verifyForm!: FormGroup;
  loading = false;
  tempToken: string = '';
  type: 'register' | 'login' = 'register';
  destination: string = '';
  metodosDisponibles: string[] = ['email'];
  metodoSeleccionado: string = 'email';
  resendCooldown = 0;
  private resendTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private modalService: ModalService
  ) {
    // Obtener datos del state de navegación primero
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras.state as any;

    if (state) {
      this.tempToken = state.tempToken;
      this.type = state.type || 'login';
      this.destination = state.destination;
      this.metodosDisponibles = state.metodosDisponibles || ['email'];
      this.metodoSeleccionado = this.metodosDisponibles[0] || 'email';
    }

    // Si no hay state, intentar obtener de queryParams
    this.route.queryParams.subscribe(params => {
      if (params['tempToken'] && !this.tempToken) {
        this.tempToken = params['tempToken'];
        this.type = params['type'] || 'login';
        this.destination = params['destino'] || params['destination'] || '';
      }
    });
  }

  ngOnInit(): void {
    // Validar que existe un token
    if (!this.tempToken) {
      this.showMessage('No se encontró un token de verificación. Por favor, inicia el proceso de registro o login.', 'error');
      // Redirigir al login después de cerrar el modal
      setTimeout(() => {
        this.router.navigate(['/login']);
      }, 500);
      return;
    }

    // Crear formulario con validación dinámica
    this.updateFormValidation();
  }

  ngOnDestroy(): void {
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }

  private startResendCooldown(seconds = 30): void {
    this.resendCooldown = Math.max(0, seconds);
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
    this.resendTimer = setInterval(() => {
      this.resendCooldown -= 1;
      if (this.resendCooldown <= 0) {
        this.resendCooldown = 0;
        if (this.resendTimer) {
          clearInterval(this.resendTimer);
          this.resendTimer = null;
        }
      }
    }, 1000);
  }

  updateFormValidation(): void {
    const pattern = this.metodoSeleccionado === 'backup'
      ? /^[0-9]{8}$/  // 8 dígitos para backup codes
      : /^[0-9]{6}$/; // 6 dígitos para email/TOTP

    this.verifyForm = this.fb.group({
      codigo: ['', [Validators.required, Validators.pattern(pattern)]]
    });
  }

  onMetodoChange(metodo: string): void {
    this.metodoSeleccionado = metodo;
    this.updateFormValidation();
  }
  
  // Método para manejar el cambio de método desde botones HTML
  onMetodoChangeFromButton(metodo: string): void {
    this.onMetodoChange(metodo);
  }

  solicitarCodigoPorEmail(): void {
    if (this.type !== 'login') {
      this.showMessage('Esta funcionalidad solo está disponible durante el inicio de sesión', 'warning');
      return;
    }

    if (!this.tempToken) {
      this.showMessage('No se encontró el token temporal del proceso de verificación.', 'error');
      return;
    }
    if (this.resendCooldown > 0) {
      this.showMessage(`Espera ${this.resendCooldown}s antes de reenviar otro código.`, 'warning');
      return;
    }

    this.loading = true;

    this.authService.solicitarCodigoEmail(this.tempToken).subscribe({
      next: (response) => {
        this.loading = false;
        if (response?.ok) {
          this.showMessage('Nuevo código enviado a tu correo. Expira en 10 minutos.', 'success');
          this.startResendCooldown(30);
        } else {
          this.showMessage(response?.message || 'Código reenviado', 'info');
        }
        this.metodoSeleccionado = 'email';
        this.updateFormValidation();
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = this.authService.getFriendlyErrorMessage(
          error,
          'No se pudo solicitar el código por correo.'
        );
        this.showMessage(errorMsg, 'error');
      }
    });
  }

  get codigoLength(): number {
    return this.metodoSeleccionado === 'backup' ? 8 : 6;
  }

  get codigoPlaceholder(): string {
    if (this.metodoSeleccionado === 'email') return '123456';
    if (this.metodoSeleccionado === 'totp') return '123456';
    return '12345678'; // backup
  }

  get metodoTexto(): string {
    if (this.metodoSeleccionado === 'email') return 'de tu correo electrónico';
    if (this.metodoSeleccionado === 'totp') return 'de tu autenticador (Google Authenticator)';
    return 'de respaldo';
  }

  onSubmit(): void {
    if (this.verifyForm.invalid) {
      const length = this.metodoSeleccionado === 'backup' ? '8' : '6';
      this.showMessage(`Ingresa un código válido de ${length} dígitos`, 'error');
      return;
    }

    this.loading = true;
    const codigo = this.verifyForm.value.codigo;

    let verifyObservable;

    // Decidir qué método llamar según el tipo y método seleccionado
    if (this.type === 'register') {
      // OTP por correo (Brevo) para registro
      verifyObservable = this.authService.verificarOTPRegistro(this.tempToken, codigo);
    } else {
      // Para login, solo soportamos email OTP (el backend no tiene TOTP implementado)
      // El método verificarTOTPLogin no funcionará porque el backend no tiene esos endpoints
      if (this.metodoSeleccionado === 'totp' || this.metodoSeleccionado === 'backup') {
        this.showMessage('TOTP y códigos de respaldo no están disponibles. Usa el código por email.', 'warning');
        this.loading = false;
        return;
      } else {
        // Email — OTP vía Brevo
        verifyObservable = this.authService.verifyLogin2FA(this.tempToken, codigo);
      }
    }

    verifyObservable.subscribe({
      next: (response) => {
        this.loading = false;

        if (response.ok) {
          const message = this.type === 'register'
            ? '¡Registro exitoso! Ahora puedes iniciar sesión'
            : '¡Inicio de sesión exitoso!';

          this.showMessage(message, 'success');

          // Redirigir según el tipo
          if (this.type === 'register') {
            setTimeout(() => {
              if (this.authService.isAuthenticated()) {
                const rol = this.authService.getCurrentUser()?.rol;
                this.router.navigate([this.authService.getHomeRouteByRole(rol)]);
              } else {
              this.router.navigate(['/login']);
              }
            }, 500);
          } else {
            // Para login, verificar que el usuario se haya guardado y redirigir según rol
            const usuarioGuardado = this.authService.getCurrentUser();
            console.log('Usuario guardado después de verificación:', usuarioGuardado);
            console.log('Estado autenticado:', this.authService.isAuthenticated());
            
            // Esperar un momento para que se actualice el estado
            setTimeout(() => {
              if (this.authService.isAuthenticated()) {
                // Redirigir según el rol del usuario
                const rol = usuarioGuardado?.rol;
                this.router.navigate([this.authService.getHomeRouteByRole(rol)]);
              } else {
                console.error('Usuario no autenticado después de verificación');
                this.showMessage('Error: No se pudo autenticar. Por favor, intenta de nuevo.', 'error');
              }
            }, 500);
          }
        }
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = this.authService.getFriendlyErrorMessage(
          error,
          'Código incorrecto o expirado.'
        );
        this.showMessage(errorMsg, 'error');

        // Si hay demasiados intentos, redirigir
        if (error.status === 429) {
          setTimeout(() => {
            this.router.navigate(['/login']);
          }, 2000);
        }
      }
    });
  }

  /**
   * Reenviar código OTP (registro vía Brevo)
   */
  reenviarCodigoOTP(): void {
    // Necesitamos el correo del usuario, lo guardamos en localStorage durante el registro
    const correo = localStorage.getItem('registerEmail') || '';
    
    if (!correo) {
      this.showMessage('No se encontró el correo. Por favor, intenta registrarte de nuevo.', 'error');
      return;
    }
    if (this.resendCooldown > 0) {
      this.showMessage(`Espera ${this.resendCooldown}s antes de reenviar otro código.`, 'warning');
      return;
    }

    this.loading = true;

    this.authService.reenviarOTP(correo).subscribe({
      next: (response) => {
        this.loading = false;
        this.showMessage('Nuevo código enviado a tu correo. Expira en 10 minutos.', 'success');
        this.startResendCooldown(30);
      },
      error: (error) => {
        this.loading = false;
        const errorMsg = this.authService.getFriendlyErrorMessage(
          error,
          'No se pudo reenviar el código.'
        );
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
