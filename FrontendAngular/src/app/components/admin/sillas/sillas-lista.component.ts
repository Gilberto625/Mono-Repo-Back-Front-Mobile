import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, SillaAdmin } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';

@Component({
  selector: 'app-sillas-lista',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './sillas-lista.component.html',
  styleUrl: './sillas-lista.component.css'
})
export class SillasListaComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);

  sillas: SillaAdmin[] = [];
  /** Sin datos aún (primera carga o sin caché). */
  loading = true;
  /** Actualización en segundo plano cuando ya hay filas en pantalla. */
  listaRefreshing = false;
  mostrarFormNueva = false;
  guardando = false;
  form = { numero: '', nombre: '' };

  get sillasConNombre(): number {
    return this.sillas.filter(s => !!(s.nombre || '').trim()).length;
  }

  get sillasSinNombre(): number {
    return this.sillas.filter(s => !(s.nombre || '').trim()).length;
  }

  ngOnInit(): void {
    const mem = this.adminService.getSillasCacheSnapshot();
    if (mem.length > 0) {
      this.sillas = mem.map((s) => ({ ...s }));
      this.loading = false;
    } else {
      const snap = this.adminService.getSillasListaBootstrap();
      if (snap.length > 0) {
        this.sillas = snap;
        this.loading = false;
      }
    }
    this.cargarSillas();
  }

  toggleFormNueva(): void {
    this.mostrarFormNueva = !this.mostrarFormNueva;
    if (this.mostrarFormNueva) this.form = { numero: '', nombre: '' };
  }

  cargarSillas(): void {
    if (this.sillas.length === 0) {
      this.loading = true;
      this.listaRefreshing = false;
    } else {
      this.listaRefreshing = true;
    }
    this.adminService.getSillas().subscribe({
      next: (res) => {
        this.loading = false;
        this.listaRefreshing = false;
        if (res?.ok) {
          this.sillas = res.sillas || [];
        }
      },
      error: () => {
        this.loading = false;
        this.listaRefreshing = false;
        this.modalService.showError('Error al cargar sillas');
      }
    });
  }

  guardarSilla(): void {
    const numero = (this.form.numero || '').trim();
    if (!numero) {
      this.modalService.showError('El número de silla es requerido');
      return;
    }
    this.guardando = true;
    this.adminService.crearSilla({ numero, nombre: (this.form.nombre || '').trim() || undefined }).subscribe({
      next: (res) => {
        this.guardando = false;
        if (res?.ok) {
          this.modalService.showSuccess('Silla agregada correctamente');
          this.mostrarFormNueva = false;
          this.form = { numero: '', nombre: '' };
          this.cargarSillas();
        } else {
          this.modalService.showError(res?.error || 'Error al guardar');
        }
      },
      error: (err) => {
        this.guardando = false;
        this.modalService.showError(err?.error?.error || 'Error al agregar silla');
      }
    });
  }

  quitarSilla(silla: SillaAdmin): void {
    if (!confirm(`¿Quitar la silla "${silla.nombre || silla.numero}"? Los barberos que la tengan asignada quedarán sin silla.`)) return;
    this.adminService.eliminarSilla(silla.id).subscribe({
      next: () => {
        this.modalService.showSuccess('Silla quitada');
        this.cargarSillas();
      },
      error: () => this.modalService.showError('Error al quitar silla')
    });
  }
}
