import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, AbstractControl, ValidationErrors } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService, RegisterData } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule
  ],
  templateUrl: './register.component.html',
  styleUrl: './register.component.css'
})
export class RegisterComponent implements OnInit {
  readonly theme = inject(ThemeService);

  /** Paso actual del registro (1–4). */
  registerStep = 1;
  readonly totalSteps = 4;
  readonly stepTitles = [
    'Datos personales',
    'Cuenta y contacto',
    'Contraseña',
    'Seguridad y términos'
  ];

  private readonly stepFieldKeys: Record<number, string[]> = {
    1: ['nombre', 'apellidopaterno', 'apellidomaterno'],
    2: ['username', 'correo', 'telefono'],
    3: ['contrasena', 'confirmarContrasena'],
    4: ['preguntasecreta', 'respuestasecreta', 'aceptaTerminos']
  };

  registerForm!: FormGroup;
  loading = false;
  hidePassword = true;
  hideConfirmPassword = true;

  // Requisitos de contraseña
  passwordRequirements = {
    minLength: false,
    hasUpperCase: false,
    hasLowerCase: false,
    hasNumber: false,
    hasSymbol: false
  };

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private modalService: ModalService
  ) {}

  ngOnInit(): void {
    // Obtener CSRF token al iniciar
    this.authService.getCsrfToken().subscribe();

    // Crear formulario reactivo con validaciones mejoradas
    this.registerForm = this.fb.group({
      nombre: ['', [Validators.required, Validators.minLength(2), this.noWhitespaceValidator]],
      apellidopaterno: ['', [Validators.required, Validators.minLength(2), this.noWhitespaceValidator]],
      apellidomaterno: ['', [Validators.required, Validators.minLength(2), this.noWhitespaceValidator]],
      username: ['', [Validators.required, Validators.minLength(4), this.noWhitespaceValidator]],
      correo: ['', [Validators.required, Validators.email, this.noWhitespaceValidator]],
      contrasena: ['', [Validators.required, Validators.minLength(8), this.passwordStrengthValidator]],
      confirmarContrasena: ['', [Validators.required]],
      telefono: ['', [Validators.required, Validators.pattern(/^[0-9]{10}$/)]],
      preguntasecreta: ['', [Validators.required]],
      respuestasecreta: ['', [Validators.required, this.noWhitespaceValidator]],
      aceptaTerminos: [false, [Validators.requiredTrue]]
    });

    // Escuchar cambios en la contraseña para actualizar indicadores visuales
    this.registerForm.get('contrasena')?.valueChanges.subscribe(password => {
      this.checkPasswordRequirements(password);
    });
  }

  /**
   * Validador personalizado: verifica que la contraseña tenga mayúscula, minúscula, número y símbolo
   */
  passwordStrengthValidator(control: AbstractControl): ValidationErrors | null {
    const value = control.value;
    
    if (!value) {
      return null;
    }

    const hasUpperCase = /[A-Z]/.test(value);
    const hasLowerCase = /[a-z]/.test(value);
    const hasNumber = /[0-9]/.test(value);
    const hasSymbol = /[!@#$%^&*(),.?":{}|<>\[\]\\\/_+\-=~`]/.test(value);

    const passwordValid = hasUpperCase && hasLowerCase && hasNumber && hasSymbol;

    return passwordValid ? null : { 
      passwordStrength: {
        hasUpperCase,
        hasLowerCase,
        hasNumber,
        hasSymbol
      }
    };
  }

  /**
   * Validador personalizado: verifica que el campo no esté vacío ni solo contenga espacios
   */
  noWhitespaceValidator(control: AbstractControl): ValidationErrors | null {
    const value = control.value;
    
    if (!value) {
      return null; // El required se encarga de esto
    }

    const isWhitespace = (value || '').trim().length === 0;
    return isWhitespace ? { whitespace: true } : null;
  }

  /**
   * Actualiza los indicadores visuales de requisitos de contraseña
   */
  checkPasswordRequirements(password: string): void {
    this.passwordRequirements.minLength = password.length >= 8;
    this.passwordRequirements.hasUpperCase = /[A-Z]/.test(password);
    this.passwordRequirements.hasLowerCase = /[a-z]/.test(password);
    this.passwordRequirements.hasNumber = /[0-9]/.test(password);
    this.passwordRequirements.hasSymbol = /[!@#$%^&*(),.?":{}|<>\[\]\\\/_+\-=~`]/.test(password);
  }

  /**
   * Verifica si todos los requisitos de contraseña se cumplen
   */
  get allRequirementsMet(): boolean {
    return Object.values(this.passwordRequirements).every(req => req);
  }

  /**
   * Toggle para mostrar/ocultar contraseña
   */
  togglePasswordVisibility(): void {
    this.hidePassword = !this.hidePassword;
  }

  /**
   * Toggle para mostrar/ocultar confirmación de contraseña
   */
  toggleConfirmPasswordVisibility(): void {
    this.hideConfirmPassword = !this.hideConfirmPassword;
  }

  get stepTitle(): string {
    return this.stepTitles[this.registerStep - 1] ?? '';
  }

  private markStepFieldsTouched(step: number): void {
    const keys = this.stepFieldKeys[step] ?? [];
    for (const key of keys) {
      this.registerForm.get(key)?.markAsTouched();
    }
  }

  private isStepValid(step: number): boolean {
    const keys = this.stepFieldKeys[step] ?? [];
    for (const key of keys) {
      const c = this.registerForm.get(key);
      if (!c || c.invalid) {
        return false;
      }
    }
    if (step === 3) {
      const p = this.registerForm.value.contrasena;
      const c = this.registerForm.value.confirmarContrasena;
      if (p !== c) {
        return false;
      }
      if (!this.allRequirementsMet) {
        return false;
      }
    }
    return true;
  }

  prevStep(): void {
    if (this.registerStep > 1) {
      this.registerStep -= 1;
    }
  }

  nextStep(): void {
    if (this.loading) {
      return;
    }
    this.markStepFieldsTouched(this.registerStep);
    if (!this.isStepValid(this.registerStep)) {
      if (this.registerStep === 3) {
        const p = this.registerForm.value.contrasena;
        const c = this.registerForm.value.confirmarContrasena;
        if (p !== c) {
          this.showMessage('Las contraseñas no coinciden', 'error');
          return;
        }
        if (!this.allRequirementsMet) {
          this.showMessage(
            'La contraseña debe cumplir todos los requisitos (8+ caracteres, mayúscula, minúscula, número y símbolo).',
            'error'
          );
          return;
        }
      }
      this.showMessage('Completa correctamente los campos de este paso para continuar.', 'error');
      return;
    }
    if (this.registerStep < this.totalSteps) {
      this.registerStep += 1;
    }
  }

  onSubmit(): void {
    if (this.registerStep !== this.totalSteps) {
      return;
    }

    // Marcar todos los campos como touched para mostrar errores
    Object.keys(this.registerForm.controls).forEach(key => {
      this.registerForm.get(key)?.markAsTouched();
    });

    if (!this.registerForm.get('aceptaTerminos')?.value) {
      this.showMessage('Debes aceptar los Términos y Condiciones y el Aviso de Privacidad para continuar.', 'error');
      return;
    }

    // Validar que el formulario sea válido
    if (this.registerForm.invalid) {
      this.showMessage('Por favor completa todos los campos correctamente', 'error');
      return;
    }

    // Validar que las contraseñas coincidan
    if (this.registerForm.value.contrasena !== this.registerForm.value.confirmarContrasena) {
      this.showMessage('Las contraseñas no coinciden', 'error');
      return;
    }

    // Validar que la contraseña cumpla con todos los requisitos
    if (!this.allRequirementsMet) {
      this.showMessage('La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula, un número y un carácter especial', 'error');
      return;
    }

    // Validar que no haya campos con solo espacios en blanco
    const formValues = this.registerForm.value;
    for (const key in formValues) {
      if (typeof formValues[key] === 'string' && formValues[key].trim() === '') {
        this.showMessage('No se permiten campos vacíos o solo con espacios', 'error');
        return;
      }
    }

    // Asegura que el registro público no reutilice una sesión previa (ej. barbero/admin).
    this.authService.logout();
    this.loading = true;

    // Obtener CSRF token antes de registrar
    this.authService.getCsrfToken().subscribe({
      next: () => {
        // Preparar datos sin el campo confirmarContrasena y trimear valores
        const { confirmarContrasena, ...registerData } = this.registerForm.value;
        
        // Limpiar espacios en blanco de los campos de texto
        const cleanedData = {
          nombre: registerData.nombre.trim(),
          apellidopaterno: registerData.apellidopaterno.trim(),
          apellidomaterno: registerData.apellidomaterno.trim(),
          username: registerData.username.trim(),
          correo: registerData.correo.trim(),
          contrasena: registerData.contrasena,
          telefono: registerData.telefono.trim(),
          preguntasecreta: registerData.preguntasecreta,
          respuestasecreta: registerData.respuestasecreta.trim(),
          aceptaTerminos: !!registerData.aceptaTerminos
        };

        console.log('Datos de registro:', cleanedData);

        this.authService.register(cleanedData as RegisterData).subscribe({
          next: (response) => {
            this.loading = false;
            
            // Verificar si el correo se envió o está en modo prueba
            if (response.email_enviado === false) {
              let mensaje = 'Usuario creado exitosamente. ';
              
              if (response.codigo_otp) {
                // Modo prueba: mostrar el código OTP
                mensaje += `Código OTP para verificación: ${response.codigo_otp}. ` +
                          'Este código expira en 5 minutos.';
                console.log('🔑 Código OTP (modo prueba):', response.codigo_otp);
              } else {
                mensaje += 'Hubo un problema al enviar el correo. ' +
                          'Revisa los logs del servidor o contacta al administrador.';
              }
              
              this.showMessage(mensaje, response.codigo_otp ? 'info' : 'error');
            } else {
              this.showMessage('Código OTP enviado a tu correo. Revisa tu bandeja de entrada.', 'success');
            }

            // Guardar el correo en localStorage para poder reenviar código
            localStorage.setItem('registerEmail', cleanedData.correo);
            
            // Si hay código OTP en modo prueba, guardarlo también
            if (response.codigo_otp) {
              localStorage.setItem('testOTP', response.codigo_otp);
            }

            // Navegar a la página de verificación 2FA con el tempToken después de cerrar el modal
            // Solo si tenemos un tempToken (incluso si el correo falló)
            if (response.tempToken) {
              setTimeout(() => {
                this.router.navigate(['/verify-2fa'], {
                  state: {
                    tempToken: response.tempToken,
                    type: 'register',
                    destination: response.destino || cleanedData.correo,
                    codigoOTP: response.codigo_otp || null  // Pasar código si está en modo prueba
                  }
                });
              }, 500);
            }
          },
          error: (error) => {
            this.loading = false;
            console.error('Error completo en registro:', error);
            
            let errorMsg = 'Error al registrar usuario';
            
            if (error.status === 0) {
              errorMsg = 'Error de conexión. Verifica que el backend esté disponible.';
            } else if (error.status === 404) {
              errorMsg = 'Endpoint no encontrado. Verifica la configuración del backend.';
            } else if (error.status === 400) {
              errorMsg = error.error?.error || 'Datos inválidos. Verifica que todos los campos estén correctos.';
            } else if (error.status === 409) {
              errorMsg = error.error?.error || 'El usuario, correo o teléfono ya está registrado.';
            } else if (error.status === 500) {
              if (error.error?.error?.includes('correo') || error.error?.error?.includes('email')) {
                errorMsg = 'Error al enviar el correo de verificación. Por favor, intenta más tarde.';
              } else {
                errorMsg = 'Error del servidor. Por favor, intenta más tarde.';
              }
            } else if (error.error?.error) {
              errorMsg = error.error.error;
            } else if (error.error?.message) {
              errorMsg = error.error.message;
            } else if (error.message) {
              errorMsg = error.message;
            }
            
            this.showMessage(errorMsg, 'error');
          }
        });
      },
      error: (csrfError) => {
        this.loading = false;
        console.error('Error obteniendo CSRF token:', csrfError);
        this.showMessage('Error de conexión con el servidor. Por favor, intenta de nuevo.', 'error');
      }
    });
  }

  private showMessage(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    if (type === 'error') {
      this.modalService.showError(message);
    } else if (type === 'success') {
      this.modalService.showSuccess(message);
    } else {
      this.modalService.showInfo(message);
    }
  }
}

