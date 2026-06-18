import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService, Usuario } from '../../../services/auth.service';
import { ModalService } from '../../../services/modal.service';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { RolUsuario } from '../../../models';

@Component({
  selector: 'app-editar-perfil',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './editar-perfil.component.html',
  styleUrl: './editar-perfil.component.css'
})
export class EditarPerfilComponent implements OnInit {
  currentUser: Usuario | null = null;

  form = {
    nombre: '',
    apellido: '',
    email: '',
    telefono: '',
    fechaNacimiento: '',
    direccion: ''
  };

  passwords = {
    actual: '',
    nueva: '',
    confirmar: ''
  };

  hidePassActual = true;
  hidePassNueva = true;
  hidePassConfirmar = true;

  // Avatar
  avatarUrl = '';
  avatarPreview = '';
  avatarFile: File | null = null;

  guardando = false;
  guardandoPassword = false;
  /** Sincronización con el servidor en segundo plano (el formulario ya es visible). */
  perfilRefreshing = false;

  constructor(
    private authService: AuthService,
    private router: Router,
    private modalService: ModalService
  ) {}

  get rolActual(): RolUsuario {
    const url = this.router.url;
    if (url.startsWith('/admin')) return 'admin';
    if (url.startsWith('/secretaria')) return 'secretaria';
    if (url.startsWith('/barbero')) return 'barbero';
    return 'cliente';
  }

  get baseRoute(): string {
    const r = this.rolActual;
    return r === 'admin' ? '/admin' : r === 'secretaria' ? '/secretaria' : r === 'barbero' ? '/barbero' : '/cliente';
  }

  get perfilRoute(): string {
    return this.rolActual === 'cliente' ? '/cliente/perfil' : this.baseRoute;
  }

  get volverTexto(): string {
    return this.rolActual === 'cliente' ? 'Volver a mi perfil' : 'Volver al panel';
  }

  ngOnInit(): void {
    this.currentUser = this.authService.getCurrentUser();
    if (!this.currentUser) {
      this.router.navigate(['/login']);
      return;
    }

    this.hidratarFormularioDesdeSesion();

    this.perfilRefreshing = true;
    this.authService.getPerfil().subscribe({
      next: (res: any) => {
        this.perfilRefreshing = false;
        if (res.ok && res.perfil) {
          this.form.nombre = res.perfil.nombre || '';
          this.form.apellido = res.perfil.apellido || '';
          this.form.email = res.perfil.email || '';
          this.form.telefono = res.perfil.telefono || '';
          this.form.fechaNacimiento = res.perfil.fecha_nacimiento || '';
          this.form.direccion = res.perfil.direccion || '';
          this.avatarUrl = res.perfil.avatar_url || '';
        }
      },
      error: () => {
        this.perfilRefreshing = false;
      }
    });
  }

  /** Datos del login / localStorage: el formulario puede pintarse al instante. */
  private hidratarFormularioDesdeSesion(): void {
    const u = this.currentUser;
    if (!u) {
      return;
    }
    this.form.nombre = u.nombre || '';
    this.form.apellido = u.apellido || '';
    this.form.email = u.email || '';
    this.form.telefono = u.telefono || '';
    this.form.fechaNacimiento = u.fecha_nacimiento || '';
    this.form.direccion = u.direccion || '';
    this.avatarUrl = u.avatar_url || '';
  }

  get iniciales(): string {
    const n = (this.form.nombre || '').trim().charAt(0);
    const a = (this.form.apellido || this.currentUser?.username || '').trim().charAt(0);
    return (n + a).toUpperCase() || '?';
  }

  get tieneAvatar(): boolean {
    return !!(this.avatarPreview || this.avatarUrl);
  }

  get avatarDisplay(): string {
    return this.avatarPreview || this.avatarUrl;
  }

  // -- Foto de perfil --

  onAvatarSeleccionado(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];

    // Validar tipo
    if (!String(file.type || '').startsWith('image/')) {
      this.modalService.showError('El archivo seleccionado no es una imagen válida');
      input.value = '';
      return;
    }

    // Validar tamaño (5MB)
    if (file.size > 5 * 1024 * 1024) {
      this.modalService.showError('La imagen no debe superar los 5MB');
      input.value = '';
      return;
    }

    this.normalizarAvatar(file).then((archivoNormalizado) => {
      this.avatarFile = archivoNormalizado;
      const reader = new FileReader();
      reader.onload = (e) => {
        this.avatarPreview = e.target?.result as string;
      };
      reader.onerror = () => {
        this.modalService.showError('No se pudo leer la imagen seleccionada');
        input.value = '';
      };
      reader.readAsDataURL(archivoNormalizado);
    }).catch(() => {
      this.modalService.showError('No se pudo procesar la imagen seleccionada');
      input.value = '';
    });
  }

  private async normalizarAvatar(file: File): Promise<File> {
    const dataUrl = await this.fileToDataUrl(file);
    const img = await this.dataUrlToImage(dataUrl);

    const lado = Math.min(img.width, img.height);
    const offsetX = Math.max(0, (img.width - lado) / 2);
    const offsetY = Math.max(0, (img.height - lado) * 0.2);

    const canvas = document.createElement('canvas');
    canvas.width = lado;
    canvas.height = lado;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo crear el contexto de imagen');

    ctx.drawImage(img, offsetX, offsetY, lado, lado, 0, 0, lado, lado);
    const blob = await this.canvasToBlob(canvas, 'image/jpeg', 0.92);
    return new File([blob], this.nombreSalidaAvatar(file.name), { type: 'image/jpeg' });
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private dataUrlToImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  private canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('No se pudo convertir la imagen'));
          return;
        }
        resolve(blob);
      }, type, quality);
    });
  }

  private nombreSalidaAvatar(nombreOriginal: string): string {
    const base = String(nombreOriginal || 'avatar').replace(/\.[^/.]+$/, '').trim() || 'avatar';
    return `${base}.jpg`;
  }

  eliminarAvatar(): void {
    this.avatarFile = null;
    this.avatarPreview = '';
    this.avatarUrl = '';
  }

  // -- Guardar datos personales --

  guardar(): void {
    if (!this.form.nombre?.trim()) {
      this.modalService.showError('El nombre es requerido');
      return;
    }
    if (this.form.nombre.trim().length < 2) {
      this.modalService.showError('El nombre debe tener al menos 2 caracteres');
      return;
    }
    const telefonoNormalizado = (this.form.telefono || '').replace(/\D+/g, '');
    if (telefonoNormalizado && (telefonoNormalizado.length < 10 || telefonoNormalizado.length > 15)) {
      this.modalService.showError('El teléfono debe tener entre 10 y 15 dígitos');
      return;
    }
    if (this.form.fechaNacimiento) {
      const hoy = new Date();
      const fechaNac = new Date(`${this.form.fechaNacimiento}T00:00:00`);
      if (Number.isNaN(fechaNac.getTime())) {
        this.modalService.showError('La fecha de nacimiento es inválida');
        return;
      }
      if (fechaNac > hoy) {
        this.modalService.showError('La fecha de nacimiento no puede ser futura');
        return;
      }
      const edad = hoy.getFullYear() - fechaNac.getFullYear() - (new Date(hoy.getFullYear(), fechaNac.getMonth(), fechaNac.getDate()) > hoy ? 1 : 0);
      if (edad < 16) {
        this.modalService.showError('Debes tener al menos 16 años');
        return;
      }
    }

    this.guardando = true;

    // Si hay foto nueva, subirla primero
    if (this.avatarFile) {
      this.authService.uploadAvatar(this.avatarFile).subscribe({
        next: (uploadRes: any) => {
          if (uploadRes.ok && uploadRes.url) {
            this.avatarUrl = uploadRes.url;
            this.guardarDatos(uploadRes.url);
          } else {
            this.guardando = false;
            this.modalService.showError('Error al subir la imagen');
          }
        },
        error: () => {
          this.guardando = false;
          this.modalService.showError('Error al subir la imagen. Intenta de nuevo.');
        }
      });
    } else {
      this.guardarDatos(this.avatarUrl);
    }
  }

  private guardarDatos(avatarUrl: string): void {
    const data = {
      nombre: this.form.nombre.trim(),
      apellido: this.form.apellido.trim(),
      telefono: (this.form.telefono || '').replace(/\D+/g, ''),
      fecha_nacimiento: this.form.fechaNacimiento || '',
      direccion: this.form.direccion.trim(),
      avatar_url: avatarUrl
    };

    this.authService.actualizarPerfil(data).subscribe({
      next: (res: any) => {
        this.guardando = false;
        if (res.ok) {
          this.avatarFile = null;
          this.avatarPreview = '';
          this.modalService.showSuccess('Perfil actualizado correctamente');
          setTimeout(() => this.router.navigate([this.perfilRoute]), 1000);
        } else {
          this.modalService.showError(res.error || 'Error al actualizar perfil');
        }
      },
      error: (err: any) => {
        this.guardando = false;
        this.modalService.showError(err.error?.error || 'Error al actualizar perfil');
      }
    });
  }

  // -- Cambio de contraseña --

  cambiarContrasena(): void {
    if (!this.passwords.actual) {
      this.modalService.showError('Ingresa tu contraseña actual');
      return;
    }
    if (!this.passwords.nueva) {
      this.modalService.showError('Ingresa la nueva contraseña');
      return;
    }
    if (this.passwords.nueva.length < 8) {
      this.modalService.showError('La contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(this.passwords.nueva)) {
      this.modalService.showError('La contraseña debe incluir al menos un caracter especial');
      return;
    }
    if (this.passwords.nueva !== this.passwords.confirmar) {
      this.modalService.showError('Las contraseñas no coinciden');
      return;
    }

    this.guardandoPassword = true;

    this.authService.cambiarContrasenaUsuario(this.passwords.actual, this.passwords.nueva).subscribe({
      next: (res: any) => {
        this.guardandoPassword = false;
        if (res.ok) {
          this.modalService.showSuccess('Contraseña cambiada exitosamente');
          this.passwords = { actual: '', nueva: '', confirmar: '' };
        } else {
          this.modalService.showError(res.error || 'Error al cambiar contraseña');
        }
      },
      error: (err: any) => {
        this.guardandoPassword = false;
        this.modalService.showError(err.error?.error || 'Error al cambiar contraseña');
      }
    });
  }

  cancelar(): void {
    this.router.navigate([this.perfilRoute]);
  }

  togglePassActual(): void { this.hidePassActual = !this.hidePassActual; }
  togglePassNueva(): void { this.hidePassNueva = !this.hidePassNueva; }
  togglePassConfirmar(): void { this.hidePassConfirmar = !this.hidePassConfirmar; }
}
