import { Component, HostListener, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';

interface ContenidoLegal {
  id: number;
  tipo: string;
  tipo_display: string;
  titulo: string;
  contenido: string;
  activo: boolean;
  fecha_actualizacion: string | null;
}

@Component({
  selector: 'app-contenido-legal',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './contenido-legal.component.html',
  styleUrl: './contenido-legal.component.css'
})
export class ContenidoLegalComponent implements OnInit {
  readonly MAX_TITULO = 120;
  readonly MAX_CONTENIDO_NORMAL = 5000;
  readonly MAX_CONTENIDO_PRIVACIDAD = 300000;
  readonly MAX_CONTENIDO_TERMINOS = 300000;

  private adminService = inject(AdminService);
  private modalService = inject(ModalService);

  contenidos: ContenidoLegal[] = [];
  tiposDisponibles: Record<string, string> = {};
  loading = true;
  guardando = false;

  /** Contenido siendo editado (null = ninguno). */
  editando: ContenidoLegal | null = null;
  editForm = { titulo: '', contenido: '', activo: true };

  /** Formulario para crear nuevo. */
  mostrarFormNuevo = false;
  nuevoForm = { tipo: '', titulo: '', contenido: '' };
  private editOriginal = { titulo: '', contenido: '', activo: true };

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.loading = true;
    this.adminService.getContenidoLegal().subscribe({
      next: (res) => {
        this.loading = false;
        if (res?.ok) {
          this.contenidos = res.contenidos || [];
          this.tiposDisponibles = res.tipos_disponibles || {};
        }
      },
      error: () => {
        this.loading = false;
        this.modalService.showError('Error al cargar contenidos');
      }
    });
  }

  toggleFormNuevo(): void {
    if (this.mostrarFormNuevo) {
      if (!this.confirmarDescartarCambiosNuevo()) return;
      this.mostrarFormNuevo = false;
      this.nuevoForm = { tipo: '', titulo: '', contenido: '' };
      return;
    }

    if (this.editando && !this.confirmarDescartarCambiosEdicion()) return;
    this.mostrarFormNuevo = true;
    this.nuevoForm = { tipo: '', titulo: '', contenido: '' };
    this.editando = null;
    this.editOriginal = { titulo: '', contenido: '', activo: true };
  }

  private esTipoExtenso(tipo: string | null | undefined): boolean {
    const key = String(tipo || '').trim().toLowerCase();
    return key === 'privacidad' || key === 'terminos';
  }

  private confirmarDescartarCambiosNuevo(): boolean {
    if (!this.hayCambiosNuevo) return true;
    return confirm('Tienes cambios sin guardar en "Nuevo contenido". ¿Deseas descartarlos?');
  }

  private confirmarDescartarCambiosEdicion(): boolean {
    if (!this.hayCambiosEdicion) return true;
    return confirm('Tienes cambios sin guardar en la edición. ¿Deseas descartarlos?');
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.guardando || !this.hayCambiosSinGuardar) return;
    event.preventDefault();
    event.returnValue = '';
  }

  get hayCambiosNuevo(): boolean {
    if (!this.mostrarFormNuevo) return false;
    return !!(
      this.nuevoForm.tipo.trim() ||
      this.nuevoForm.titulo.trim() ||
      this.nuevoForm.contenido.trim()
    );
  }

  get hayCambiosEdicion(): boolean {
    if (!this.editando) return false;
    return (
      this.editForm.titulo.trim() !== this.editOriginal.titulo.trim() ||
      this.editForm.contenido !== this.editOriginal.contenido ||
      this.editForm.activo !== this.editOriginal.activo
    );
  }

  get hayCambiosSinGuardar(): boolean {
    return this.hayCambiosNuevo || this.hayCambiosEdicion;
  }

  get maxContenidoNuevo(): number {
    const tipo = String(this.nuevoForm.tipo || '').trim().toLowerCase();
    if (tipo === 'privacidad') return this.MAX_CONTENIDO_PRIVACIDAD;
    if (tipo === 'terminos') return this.MAX_CONTENIDO_TERMINOS;
    return this.MAX_CONTENIDO_NORMAL;
  }

  get maxContenidoEdicion(): number {
    const tipo = String(this.editando?.tipo || '').trim().toLowerCase();
    if (tipo === 'privacidad') return this.MAX_CONTENIDO_PRIVACIDAD;
    if (tipo === 'terminos') return this.MAX_CONTENIDO_TERMINOS;
    return this.MAX_CONTENIDO_NORMAL;
  }

  get esNuevoTipoExtenso(): boolean {
    return this.esTipoExtenso(this.nuevoForm.tipo);
  }

  get esEdicionTipoExtenso(): boolean {
    return this.esTipoExtenso(this.editando?.tipo);
  }

  get maxContenidoNuevoLabel(): string {
    const tipo = String(this.nuevoForm.tipo || '').trim().toLowerCase();
    if (tipo === 'privacidad') return `Límite extendido para política de privacidad (${this.MAX_CONTENIDO_PRIVACIDAD} caracteres).`;
    if (tipo === 'terminos') return `Límite extendido para términos y condiciones (${this.MAX_CONTENIDO_TERMINOS} caracteres).`;
    return `Límite estándar (${this.MAX_CONTENIDO_NORMAL} caracteres).`;
  }

  get maxContenidoEdicionLabel(): string {
    const tipo = String(this.editando?.tipo || '').trim().toLowerCase();
    if (tipo === 'privacidad') return `Límite extendido para política de privacidad (${this.MAX_CONTENIDO_PRIVACIDAD} caracteres).`;
    if (tipo === 'terminos') return `Límite extendido para términos y condiciones (${this.MAX_CONTENIDO_TERMINOS} caracteres).`;
    return `Límite estándar (${this.MAX_CONTENIDO_NORMAL} caracteres).`;
  }

  crear(): void {
    const tipo = this.nuevoForm.tipo;
    if (!tipo) {
      this.modalService.showError('Selecciona un tipo de contenido');
      return;
    }
    if (!this.puedeCrear) {
      this.modalService.showError('Revisa título y contenido: superan el límite permitido.');
      return;
    }
    const nombreTipo = this.tiposDisponibles[tipo] || tipo;
    if (!confirm(`¿Crear contenido para "${nombreTipo}"?`)) return;

    this.guardando = true;
    this.adminService.crearContenidoLegal({
      tipo,
      titulo: this.nuevoForm.titulo.trim() || this.tiposDisponibles[tipo] || tipo,
      contenido: this.nuevoForm.contenido
    }).subscribe({
      next: (res) => {
        this.guardando = false;
        if (res?.ok) {
          this.modalService.showSuccess('Contenido creado exitosamente');
          this.mostrarFormNuevo = false;
          this.nuevoForm = { tipo: '', titulo: '', contenido: '' };
          this.cargar();
        } else {
          this.modalService.showError(res?.error || 'Error al crear');
        }
      },
      error: (err) => {
        this.guardando = false;
        this.modalService.showError(err?.error?.error || 'Error al crear contenido');
      }
    });
  }

  iniciarEdicion(c: ContenidoLegal): void {
    if (this.mostrarFormNuevo && !this.confirmarDescartarCambiosNuevo()) return;
    if (this.editando && this.editando.id !== c.id && !this.confirmarDescartarCambiosEdicion()) return;

    this.editando = c;
    this.editForm = { titulo: c.titulo, contenido: c.contenido, activo: c.activo };
    this.editOriginal = { titulo: c.titulo, contenido: c.contenido, activo: c.activo };
    this.mostrarFormNuevo = false;
  }

  cancelarEdicion(): void {
    if (!this.confirmarDescartarCambiosEdicion()) return;
    this.editando = null;
    this.editOriginal = { titulo: '', contenido: '', activo: true };
  }

  guardarEdicion(): void {
    if (!this.editando) return;
    if (!this.puedeGuardarEdicion) {
      this.modalService.showError('Revisa título y contenido antes de guardar.');
      return;
    }
    if (!confirm(`¿Guardar cambios en "${this.editando.tipo_display}"?`)) return;

    this.guardando = true;
    this.adminService.actualizarContenidoLegal(this.editando.id, {
      titulo: this.editForm.titulo.trim(),
      contenido: this.editForm.contenido,
      activo: this.editForm.activo
    }).subscribe({
      next: (res) => {
        this.guardando = false;
        if (res?.ok) {
          this.modalService.showSuccess('Contenido actualizado');
          this.editando = null;
          this.editOriginal = { titulo: '', contenido: '', activo: true };
          this.cargar();
        } else {
          this.modalService.showError(res?.error || 'Error al actualizar');
        }
      },
      error: () => {
        this.guardando = false;
        this.modalService.showError('Error al actualizar contenido');
      }
    });
  }

  toggleActivo(c: ContenidoLegal): void {
    const accion = c.activo ? 'desactivar' : 'activar';
    if (!confirm(`¿Deseas ${accion} "${c.tipo_display}" en la página pública?`)) return;
    this.adminService.actualizarContenidoLegal(c.id, { activo: !c.activo }).subscribe({
      next: (res) => {
        if (res?.ok) {
          c.activo = !c.activo;
        }
      },
      error: () => {
        this.modalService.showError('No se pudo actualizar el estado.');
      },
    });
  }

  eliminar(c: ContenidoLegal): void {
    if (!confirm(`¿Eliminar "${c.tipo_display}"? Esta acción no se puede deshacer.`)) return;
    this.adminService.eliminarContenidoLegal(c.id).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.modalService.showSuccess('Contenido eliminado');
          this.cargar();
        }
      },
      error: () => {
        this.modalService.showError('Error al eliminar');
      }
    });
  }

  get hayTiposDisponibles(): boolean {
    return Object.keys(this.tiposDisponibles).length > 0;
  }

  get nuevoTituloChars(): number {
    return (this.nuevoForm.titulo || '').trim().length;
  }

  get nuevoContenidoChars(): number {
    return (this.nuevoForm.contenido || '').length;
  }

  get editTituloChars(): number {
    return (this.editForm.titulo || '').trim().length;
  }

  get editContenidoChars(): number {
    return (this.editForm.contenido || '').length;
  }

  get puedeCrear(): boolean {
    if (!this.nuevoForm.tipo) return false;
    if (this.nuevoTituloChars > this.MAX_TITULO) return false;
    if (this.nuevoContenidoChars > this.maxContenidoNuevo) return false;
    return true;
  }

  get puedeGuardarEdicion(): boolean {
    if (!this.editando) return false;
    if (!this.editForm.titulo.trim()) return false;
    if (this.editTituloChars > this.MAX_TITULO) return false;
    if (this.editContenidoChars > this.maxContenidoEdicion) return false;
    return true;
  }

  get tituloNuevoPreview(): string {
    const tipo = this.nuevoForm.tipo;
    const fallback = tipo ? (this.tiposDisponibles[tipo] || tipo) : 'Título del contenido';
    return this.nuevoForm.titulo.trim() || fallback;
  }

  get contenidoNuevoPreview(): string {
    return (this.nuevoForm.contenido || '').trim() || 'Aquí verás la vista previa del contenido.';
  }

  get tituloEdicionPreview(): string {
    return this.editForm.titulo.trim() || this.editando?.tipo_display || 'Título del contenido';
  }

  get contenidoEdicionPreview(): string {
    return (this.editForm.contenido || '').trim() || 'Aquí verás la vista previa del contenido.';
  }
}
