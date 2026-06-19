import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Observable, catchError, firstValueFrom, map, of, switchMap, tap, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, UserCredential } from '@angular/fire/auth';
import { TokenService } from '../core/auth/token.service';
import { API_ENDPOINTS, apiEndpoint } from '../core/api/api-endpoints';

export interface Usuario {
  id?: number;
  email: string;
  username: string;
  nombre?: string;
  apellido?: string;
  telefono?: string;
  fecha_nacimiento?: string;
  direccion?: string;
  avatar_url?: string;
  rol?: 'cliente' | 'admin' | 'barbero' | 'secretaria';
}

export interface RegisterData {
  nombre: string;
  apellidopaterno: string;
  apellidomaterno: string;
  username: string;
  correo: string;
  contrasena: string;
  telefono: string;
  preguntasecreta: string;
  respuestasecreta: string;
  aceptaTerminos: boolean;
}

export interface LoginData {
  email: string;
  password: string;
}

interface JwtTokenResponse {
  access: string;
  refresh: string;
}

interface LoginApiResponse {
  ok?: boolean;
  requires2fa?: boolean;
  tempToken?: string;
  canal?: string;
  destino?: string;
  mensaje?: string;
  access?: string;
  refresh?: string;
  usuario?: Usuario;
}

interface BackendMeResponse {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  is_superuser: boolean;
  rol?: string;
  is_authenticated: boolean;
}

export interface EstadoSeguridad {
  email_2fa: boolean;
  totp_habilitado: boolean;
  codigos_respaldo_disponibles: number;
  tiene_preguntas_seguridad: boolean;
}

export interface Perfil2FAConfig {
  ok: boolean;
  email_2fa: boolean;
  puede_gestionar: boolean;
  motivo_bloqueo?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = environment.apiUrl;
  private csrfToken: string = '';

  // BehaviorSubject para manejar el estado del usuario
  private currentUserSubject = new BehaviorSubject<Usuario | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();

  // Estado de autenticación
  private isAuthenticatedSubject = new BehaviorSubject<boolean>(false);
  public isAuthenticated$ = this.isAuthenticatedSubject.asObservable();

  constructor(
    private http: HttpClient,
    private auth: Auth,
    private tokenService: TokenService
  ) {
    const accessToken = this.tokenService.getAccessToken();
    const storedUser = localStorage.getItem('currentUser');

    if (!accessToken || !storedUser || this.isTokenExpired(accessToken)) {
      this.logout();
      return;
    }

    try {
      const parsed = JSON.parse(storedUser) as Usuario;
      this.currentUserSubject.next({
        ...parsed,
        rol: this.normalizeRole(parsed?.rol)
      });
      this.isAuthenticatedSubject.next(true);
    } catch {
      this.logout();
    }
  }

  private isTokenExpired(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return true;
      const payload = JSON.parse(atob(parts[1]));
      const exp = Number(payload?.exp || 0);
      if (!exp) return true;
      const now = Math.floor(Date.now() / 1000);
      return exp <= now;
    } catch {
      return true;
    }
  }

  private hasValidAccessToken(): boolean {
    const token = this.tokenService.getAccessToken();
    if (!token) return false;
    return !this.isTokenExpired(token);
  }

  /**
   * Compatibilidad con flujos antiguos que esperan CSRF.
   * Con JWT no es necesario pedir token CSRF para login.
   */
  getCsrfToken(): Observable<any> {
    return of({ csrfToken: '' });
  }

  /**
   * Headers con CSRF token
   */
  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'X-CSRFToken': this.csrfToken
    });
  }

  /**
   * REGISTRO: Paso 1 - Registrar usuario y enviar código 2FA
   */
  register(data: RegisterData): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.register),
      data,
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  /**
   * REGISTRO: Paso 2 - Verificar código 2FA del registro
   */
  verifyRegister2FA(tempToken: string, codigo: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.register2faVerify),
      { tempToken, codigo },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    ).pipe(
      tap((response: any) => {
        if (response?.ok && response?.access && response?.refresh) {
          this.storeTokens({ access: response.access, refresh: response.refresh });
          this.setCurrentUser(response.usuario);
        }
      })
    );
  }

  /**
   * LOGIN: Inicio de sesión directo (sin 2FA)
   */
  login(data: LoginData): Observable<any> {
    const email = (data.email || '').trim();
    return this.http.post<LoginApiResponse>(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.login),
      { email, password: data.password }
    ).pipe(
      map((response) => {
        if (response?.requires2fa) {
          return response;
        }

        if (!response?.access || !response?.refresh) {
          throw new Error('Respuesta de login inválida.');
        }

        this.storeTokens({ access: response.access, refresh: response.refresh });

        const usuarioResp = response.usuario;
        const usuario: Usuario = {
          id: usuarioResp?.id,
          email: usuarioResp?.email || email,
          username: usuarioResp?.username || email,
          rol: this.normalizeRole(usuarioResp?.rol),
        };
        this.setCurrentUser(usuario);
        return { ok: true, usuario };
      })
    );
  }

  /**
   * LOGIN: Paso 2 - Verificar código 2FA del login
   */
  verifyLogin2FA(tempToken: string, codigo: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.login2faVerify),
      { tempToken, codigo },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    ).pipe(
      tap((response: any) => {
        if (response?.ok && response?.access && response?.refresh) {
          this.storeTokens({ access: response.access, refresh: response.refresh });
          this.setCurrentUser(response.usuario);
        }
      })
    );
  }

  /**
   * LOGIN CON GOOGLE
   */
  async loginWithGoogle(): Promise<any> {
    try {
      // Verificar que Firebase Auth esté disponible
      if (!this.auth) {
        throw new Error('Firebase Auth no está disponible. Verifica la configuración.');
      }

      // Cerrar sesión Firebase previa para forzar selector de cuenta siempre.
      await this.clearFirebaseSession();

      // Autenticar con Google usando Firebase
      const provider = new GoogleAuthProvider();
      
      // Forzar selector de cuenta: siempre mostrar opción de elegir cuenta o agregar cuenta
      provider.setCustomParameters({
        prompt: 'select_account'  // Fuerza mostrar selector de cuenta
      });
      
      const result: UserCredential = await signInWithPopup(this.auth, provider);

      // Obtener el ID token de Firebase
      // Fuerza token fresco para evitar "token inválido o expirado" por cache local.
      const idToken = await result.user.getIdToken(true);

      // Obtener CSRF token antes de enviar al backend
      await firstValueFrom(this.getCsrfToken());

      // Enviar el token al backend Django
      const response = await firstValueFrom(
        this.http.post(
          apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.loginGoogle),
          { idToken },
          {
            headers: this.getHeaders(),
            withCredentials: true
          }
        ).pipe(
          tap((response: any) => {
            if (response.ok) {
              if (response.access && response.refresh) {
                this.storeTokens({ access: response.access, refresh: response.refresh });
              }
              this.setCurrentUser(response.usuario);
            }
          })
        )
      );

      return response;

    } catch (error: any) {
      // Manejo específico de errores de Firebase
      if (error?.code === 'auth/unauthorized-domain') {
        const currentDomain = window.location.hostname;
        throw {
          code: 'auth/unauthorized-domain',
          message: `El dominio "${currentDomain}" no está autorizado en Firebase. ` +
            `Por favor, agrega este dominio en Firebase Console → Authentication → Settings → Authorized domains.`,
          error: `El dominio "${currentDomain}" no está autorizado en Firebase. ` +
            `Por favor, agrega este dominio en Firebase Console → Authentication → Settings → Authorized domains.`
        };
      }
      
      if (error?.code === 'auth/popup-closed-by-user') {
        throw {
          code: 'auth/popup-closed-by-user',
          message: 'La ventana de Google fue cerrada. Por favor intenta de nuevo.',
          error: 'La ventana de Google fue cerrada. Por favor intenta de nuevo.'
        };
      }
      
      if (error?.code === 'auth/network-request-failed') {
        const currentDomain = window.location.hostname;
        throw {
          code: 'auth/network-request-failed',
          message: `Error de conexión con Firebase. Verifica que el dominio "${currentDomain}" esté autorizado en Firebase Console.`,
          error: `Error de conexión con Firebase. Verifica que el dominio "${currentDomain}" esté autorizado en Firebase Console. ` +
            `Si el problema persiste, verifica tu conexión a internet.`
        };
      }
      
      if (error?.code === 'auth/internal-error') {
        const currentDomain = window.location.hostname;
        throw {
          code: 'auth/internal-error',
          message: `Error interno de Firebase. Verifica que el dominio "${currentDomain}" esté autorizado en Firebase Console.`,
          error: `Error interno de Firebase. Verifica que el dominio "${currentDomain}" esté autorizado en Firebase Console. ` +
            `También verifica que el CSP (Content Security Policy) permita las conexiones a Firebase.`
        };
      }
      
      // Si es un error HTTP del backend
      if (error?.status) {
        throw {
          code: 'backend-error',
          message: error.error?.error || 'Error del servidor',
          error: error.error?.error || `Error del servidor (${error.status})`
        };
      }
      
      // Error genérico
      throw {
        code: error?.code || 'unknown-error',
        message: error?.message || 'Error desconocido al iniciar sesión con Google',
        error: error?.message || 'Error desconocido al iniciar sesión con Google'
      };
    }
  }

  private async clearFirebaseSession(): Promise<void> {
    try {
      await signOut(this.auth);
    } catch {
      // No bloquear el flujo si no había sesión activa en Firebase.
    }
  }

  /**
   * Establecer usuario actual
   */
  private setCurrentUser(usuario: Usuario): void {
    const normalizado: Usuario = {
      ...usuario,
      rol: this.normalizeRole(usuario?.rol)
    };
    this.currentUserSubject.next(normalizado);
    this.isAuthenticatedSubject.next(true);
    localStorage.setItem('currentUser', JSON.stringify(normalizado));
    if (normalizado.rol) {
      localStorage.setItem('userRole', normalizado.rol);
    }
  }

  private storeTokens(tokens: JwtTokenResponse): void {
    this.tokenService.setTokens(tokens.access, tokens.refresh);
  }

  refreshToken(): Observable<string | null> {
    const refresh = this.tokenService.getRefreshToken();
    if (!refresh) {
      return of(null);
    }

    return this.http.post<{ access: string }>(apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.refresh), { refresh }).pipe(
      map((resp) => {
        if (!resp?.access) {
          return null;
        }
        this.tokenService.setAccessToken(resp.access);
        return resp.access;
      }),
      catchError(() => {
        this.logout();
        return of(null);
      })
    );
  }

  /**
   * Obtener usuario actual
   */
  getCurrentUser(): Usuario | null {
    return this.currentUserSubject.value;
  }

  /**
   * Verificar si está autenticado
   */
  isAuthenticated(): boolean {
    const valid = this.isAuthenticatedSubject.value && this.hasValidAccessToken();
    if (!valid && this.isAuthenticatedSubject.value) {
      // Si el token ya expiró o no existe, limpiar estado para evitar "sesiones fantasma".
      this.logout();
    }
    return valid;
  }

  getHomeRouteByRole(rol?: string): string {
    const rolNormalizado = this.normalizeRole(rol);
    switch (rolNormalizado) {
      case 'admin':
        return '/admin';
      case 'barbero':
        return '/barbero';
      case 'secretaria':
        return '/secretaria';
      default:
        return '/cliente';
    }
  }

  private normalizeRole(rol?: string): 'cliente' | 'admin' | 'barbero' | 'secretaria' {
    const value = String(rol || '').trim().toLowerCase();
    if (value === 'administrador' || value === 'admin') return 'admin';
    if (value === 'barbero') return 'barbero';
    if (value === 'secretaria') return 'secretaria';
    return 'cliente';
  }

  getFriendlyErrorMessage(error: any, fallback = 'Ocurrió un error inesperado'): string {
    if (!error) {
      return fallback;
    }

    if (error?.status === 0) {
      return 'No se pudo conectar con el servidor.';
    }
    if (error?.status === 400) {
      return 'Los datos enviados no son válidos.';
    }
    if (error?.status === 401) {
      return 'Credenciales incorrectas.';
    }
    if (error?.status === 403) {
      return 'No tienes permiso para realizar esta acción.';
    }
    if (error?.status === 404) {
      return 'El recurso solicitado no existe.';
    }
    if (error?.status >= 500) {
      return 'Error del servidor. Intenta de nuevo más tarde.';
    }

    return fallback;
  }

  /**
   * Cerrar sesión
   */
  logout(): void {
    // Cerrar sesión en Firebase para evitar reutilizar la última cuenta Google.
    void this.clearFirebaseSession();
    this.currentUserSubject.next(null);
    this.isAuthenticatedSubject.next(false);
    localStorage.removeItem('currentUser');
    localStorage.removeItem('userRole');
    this.tokenService.clear();
    localStorage.removeItem('registerEmail');
    localStorage.removeItem('testOTP');
    localStorage.removeItem('recoveryTempToken');
    localStorage.removeItem('recoveryEmail');
    localStorage.removeItem('recoveryMethod');
  }

  /**
   * Obtener pregunta secreta
   */
  obtenerPreguntaSecreta(email: string): Observable<any> {
    return this.funcionalidadNoDisponible('La recuperación por pregunta secreta');
  }

  /**
   * Verificar respuesta secreta
   */
  verificarRespuestaSecreta(email: string, respuestaSecreta: string): Observable<any> {
    return this.funcionalidadNoDisponible('La recuperación por pregunta secreta');
  }

  /**
   * Restablecer contraseña
   */
  restablecerContrasena(tempToken: string, nuevaContrasena: string): Observable<any> {
    return this.actualizarContrasenaOTP(tempToken, nuevaContrasena);
  }

  /**
   * Solicitar recuperación de contraseña por email
   */
  solicitarRecuperacionEmail(email: string): Observable<any> {
    return this.funcionalidadNoDisponible('La recuperación mediante enlace');
  }

  /**
   * Restablecer contraseña con token de email
   */
  restablecerConTokenEmail(token: string, nuevaContrasena: string): Observable<any> {
    return this.funcionalidadNoDisponible('La recuperación mediante enlace');
  }

  /**
   * Configurar TOTP - Obtener QR code
   */
  configurarTOTP(email: string): Observable<any> {
    return this.funcionalidadNoDisponible('La configuración TOTP');
  }

  /**
   * Habilitar TOTP después de verificar código
   */
  habilitarTOTP(email: string, codigo: string): Observable<any> {
    return this.funcionalidadNoDisponible('La configuración TOTP');
  }

  /**
   * Verificar código TOTP o backup en login
   */
  verificarTOTPLogin(tempToken: string, codigo: string, tipo: 'totp' | 'backup'): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.login2faVerify),
      { tempToken, codigo, tipo },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    ).pipe(
      tap((response: any) => {
        if (response.ok) {
          this.setCurrentUser(response.usuario);
        }
      })
    );
  }

  /**
   * Generar códigos de respaldo
   */
  generarCodigosRespaldo(email: string): Observable<any> {
    return this.funcionalidadNoDisponible('Los códigos de respaldo');
  }

  /**
   * Obtener estado de seguridad del usuario
   */
  obtenerEstadoSeguridad(email: string): Observable<EstadoSeguridad> {
    return this.funcionalidadNoDisponible('El panel de seguridad');
  }

  /**
   * Solicitar código por email cuando está usando TOTP
   */
  solicitarCodigoEmail(tempToken: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.login2faRequestCode),
      { tempToken },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  /**
   * Cambiar contraseña (usuario autenticado)
   */
  cambiarContrasena(email: string, contrasenaActual: string, nuevaContrasena: string): Observable<any> {
    return this.cambiarContrasenaUsuario(contrasenaActual, nuevaContrasena);
  }

  private funcionalidadNoDisponible(nombre: string): Observable<never> {
    return throwError(() => ({
      status: 501,
      error: { error: `${nombre} estará disponible próximamente.` }
    }));
  }

  // ========== MÉTODOS OTP POR CORREO (Brevo) ==========

  /**
   * Verificar código OTP durante el registro
   */
  verificarOTPRegistro(tempToken: string, codigo: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.verifyOtp),
      { tempToken, codigo },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    ).pipe(
      tap((response: any) => {
        if (response?.ok && response?.access && response?.refresh) {
          this.storeTokens({ access: response.access, refresh: response.refresh });
          this.setCurrentUser(response.usuario);
        }
      })
    );
  }

  /**
   * Reenviar código OTP durante el registro
   */
  reenviarOTP(correo: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.resendOtp),
      { correo },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  // ========== PERFIL DEL USUARIO ==========

  /**
   * Obtener perfil completo del usuario
   */
  getPerfil(): Observable<any> {
    return this.http.get(apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.profile), {
      withCredentials: true
    });
  }

  /**
   * Actualizar perfil del usuario
   */
  actualizarPerfil(data: Partial<{nombre: string; apellido: string; telefono: string; fecha_nacimiento: string; direccion: string; avatar_url: string}>): Observable<any> {
    return this.http.put(apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.profile), data, {
      withCredentials: true
    }).pipe(
      tap((response: any) => {
        if (response.ok && response.perfil) {
          // Actualizar usuario en localStorage con los nuevos datos
          const currentUser = this.getCurrentUser();
          if (currentUser) {
            const updated: Usuario = {
              ...currentUser,
              nombre: response.perfil.nombre,
              apellido: response.perfil.apellido,
              telefono: response.perfil.telefono,
              fecha_nacimiento: response.perfil.fecha_nacimiento,
              direccion: response.perfil.direccion,
              avatar_url: response.perfil.avatar_url,
            };
            this.setCurrentUser(updated);
          }
        }
      })
    );
  }

  /**
   * Cambiar contraseña del usuario autenticado
   */
  cambiarContrasenaUsuario(contrasenaActual: string, nuevaContrasena: string): Observable<any> {
    return this.http.post(apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.profilePassword), {
      contrasena_actual: contrasenaActual,
      nueva_contrasena: nuevaContrasena
    }, {
      withCredentials: true
    });
  }

  getPerfil2FAConfig(): Observable<Perfil2FAConfig> {
    return this.http.get<Perfil2FAConfig>(apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.profile2fa), {
      withCredentials: true
    });
  }

  actualizarPerfil2FAConfig(email2FA: boolean): Observable<any> {
    return this.http.put(apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.profile2fa), { email_2fa: email2FA }, {
      withCredentials: true
    });
  }

  /**
   * Subir imagen de avatar a Cloudinary
   */
  uploadAvatar(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('image', file);
    return this.http.post(apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.profileAvatar), formData, {
      withCredentials: true
    });
  }

  /**
   * Subir comprobante de pago (transferencia) para citas o pedidos.
   */
  uploadComprobantePago(file: File, folder: string = 'comprobantes'): Observable<any> {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('folder', folder);
    return this.http.post(apiEndpoint(this.apiUrl, API_ENDPOINTS.client.receiptsUpload), formData, {
      withCredentials: true
    });
  }

  /**
   * Solicitar recuperación de contraseña con OTP (Brevo)
   * Envía código OTP al correo para recuperar contraseña
   */
  solicitarRecuperacionOTP(email: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.recoverOtp),
      { email },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  /**
   * Verificar código OTP para recuperación de contraseña
   */
  verificarOTPRecuperacion(tempToken: string, codigo: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.verifyRecoveryOtp),
      { tempToken, codigo },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  /**
   * Reenviar código OTP para recuperación de contraseña
   */
  reenviarOTPRecuperacion(correo: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.resendRecoveryOtp),
      { correo, email: correo },  // Enviar ambos campos para compatibilidad
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  /**
   * Actualizar contraseña después de verificar OTP de recuperación
   */
  actualizarContrasenaOTP(tempToken: string, nuevaContrasena: string): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.auth.updatePasswordOtp),
      { tempToken, nuevaContrasena },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }
}
