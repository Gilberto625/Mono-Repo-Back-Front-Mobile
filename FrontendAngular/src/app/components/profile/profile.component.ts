import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService, Usuario } from '../../services/auth.service';
import { AlexaService } from '../../services/alexa.service';
import { ModalService } from '../../services/modal.service';
import { SidebarComponent } from '../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../shared/breadcrumb/breadcrumb.component';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    SidebarComponent,
    BreadcrumbComponent
  ],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.css'
})
export class ProfileComponent implements OnInit, OnDestroy {
  currentUser: Usuario | null = null;

  // Preferencias
  prefNotificaciones = true;
  prefRecordatorios = true;
  email2FA = true;
  puedeGestionar2FA = true;
  guardando2FA = false;
  proveedor2FA = '';

  // Alexa
  alexaVinculado = false;
  alexaVinculadoEn: string | null = null;
  alexaCodigo: string | null = null;
  alexaSegundosRestantes = 0;
  cargandoEstadoAlexa = false;
  generandoCodigoAlexa = false;
  private alexaCountdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private authService: AuthService,
    private alexaService: AlexaService,
    private router: Router,
    private modalService: ModalService
  ) {}

  ngOnInit(): void {
    this.currentUser = this.authService.getCurrentUser();

    if (!this.currentUser) {
      this.router.navigate(['/login']);
      return;
    }

    // Cargar perfil completo desde el backend
    this.authService.getPerfil().subscribe({
      next: (res: any) => {
        if (res.ok && res.perfil) {
          this.currentUser = {
            ...this.currentUser!,
            nombre: res.perfil.nombre,
            apellido: res.perfil.apellido,
            telefono: res.perfil.telefono,
            fecha_nacimiento: res.perfil.fecha_nacimiento,
            direccion: res.perfil.direccion,
            avatar_url: res.perfil.avatar_url,
          };
        }
      },
      error: () => {}
    });

    this.authService.getPerfil2FAConfig().subscribe({
      next: (res) => {
        if (res?.ok) {
          this.email2FA = !!res.email_2fa;
          this.puedeGestionar2FA = !!res.puede_gestionar;
          this.proveedor2FA = String((res as any).proveedor_auth || '').toLowerCase();
        }
      },
      error: () => {
        this.puedeGestionar2FA = false;
      }
    });

    this.cargarEstadoAlexa();
  }

  ngOnDestroy(): void {
    this.detenerCountdownAlexa();
  }

  cargarEstadoAlexa(): void {
    this.cargandoEstadoAlexa = true;
    this.alexaService.getEstadoVinculacion().subscribe({
      next: (res) => {
        this.cargandoEstadoAlexa = false;
        if (res?.ok) {
          this.alexaVinculado = !!res.vinculado;
          this.alexaVinculadoEn = res.vinculado_en || null;
        }
      },
      error: () => {
        this.cargandoEstadoAlexa = false;
      }
    });
  }

  generarCodigoAlexa(): void {
    if (this.generandoCodigoAlexa) return;
    this.generandoCodigoAlexa = true;
    this.alexaService.generarCodigoVinculacion().subscribe({
      next: (res) => {
        this.generandoCodigoAlexa = false;
        if (!res?.ok || !res.codigo) {
          this.modalService.showError(res?.error || 'No se pudo generar el código de vinculación');
          return;
        }
        this.alexaCodigo = res.codigo;
        this.iniciarCountdownAlexa(res.expira_en_segundos || 300);
        this.modalService.showSuccess('Código generado. Díctalo a Alexa antes de que expire.');
      },
      error: (err) => {
        this.generandoCodigoAlexa = false;
        this.modalService.showError(err?.error?.error || 'No se pudo generar el código de vinculación');
      }
    });
  }

  private iniciarCountdownAlexa(segundos: number): void {
    this.detenerCountdownAlexa();
    this.alexaSegundosRestantes = Math.max(0, segundos);
    this.alexaCountdownTimer = setInterval(() => {
      this.alexaSegundosRestantes -= 1;
      if (this.alexaSegundosRestantes <= 0) {
        this.alexaCodigo = null;
        this.detenerCountdownAlexa();
      }
    }, 1000);
  }

  private detenerCountdownAlexa(): void {
    if (this.alexaCountdownTimer) {
      clearInterval(this.alexaCountdownTimer);
      this.alexaCountdownTimer = null;
    }
  }

  get alexaCountdownTexto(): string {
    const total = Math.max(0, this.alexaSegundosRestantes);
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }

  get alexaVinculadoEnTexto(): string {
    if (!this.alexaVinculadoEn) return '';
    const fecha = new Date(this.alexaVinculadoEn);
    if (Number.isNaN(fecha.getTime())) return '';
    return fecha.toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  }

  onToggle2FA(value: boolean): void {
    if (!this.puedeGestionar2FA || this.guardando2FA) return;
    const nuevoValor = !!value;
    const anterior = this.email2FA;
    this.email2FA = nuevoValor;
    this.guardando2FA = true;
    this.authService.actualizarPerfil2FAConfig(nuevoValor).subscribe({
      next: (res: any) => {
        if (!res?.ok) {
          this.guardando2FA = false;
          this.email2FA = anterior;
          this.modalService.showError(res?.error || 'No se pudo actualizar la verificación de dos pasos');
          return;
        }
        this.email2FA = !!res.email_2fa;
        this.proveedor2FA = String(res.proveedor_auth || this.proveedor2FA || '').toLowerCase();
        this.guardando2FA = false;
        this.modalService.showSuccess(this.email2FA ? 'Verificación de dos pasos activada' : 'Verificación de dos pasos desactivada');
      },
      error: (err) => {
        this.guardando2FA = false;
        this.email2FA = anterior;
        this.modalService.showError(err?.error?.error || 'No se pudo actualizar la verificación de dos pasos');
      }
    });
  }

  get estado2FATexto(): string {
    return this.email2FA ? 'Activada' : 'Desactivada';
  }

  get iniciales(): string {
    const n = (this.currentUser?.nombre || '').trim().charAt(0);
    const a = (this.currentUser?.apellido || this.currentUser?.username || '').trim().charAt(0);
    return (n + a).toUpperCase() || '?';
  }

  get nombreCompleto(): string {
    if (this.currentUser?.nombre) {
      return `${this.currentUser.nombre} ${this.currentUser.apellido || ''}`.trim();
    }
    return this.currentUser?.username || 'Usuario';
  }

  get tieneAvatar(): boolean {
    return !!(this.currentUser?.avatar_url);
  }

  eliminarCuenta(): void {
    if (confirm('¿Estás seguro de que deseas eliminar tu cuenta? Esta acción no se puede deshacer.')) {
      this.modalService.showInfo('La eliminación de cuenta no está disponible en este momento.');
    }
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
