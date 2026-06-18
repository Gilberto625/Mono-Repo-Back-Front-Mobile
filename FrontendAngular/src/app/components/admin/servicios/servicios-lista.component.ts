import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Servicio } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';

@Component({
  selector: 'app-servicios-lista',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './servicios-lista.component.html',
  styleUrl: './servicios-lista.component.css'
})
export class ServiciosListaComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);
  private readonly router = inject(Router);

  servicios: Servicio[] = [];
  serviciosFiltrados: Servicio[] = [];
  loading = true;
  listaRefreshing = false;
  
  filtro = '';
  filtroCategoria = '';
  /** Por defecto solo activos, así los eliminados (inactivos) no reaparecen al recargar */
  filtroEstado = 'activo';

  get esSecretaria(): boolean {
    return this.router.url.startsWith('/secretaria');
  }

  get serviciosBase(): string {
    return this.esSecretaria ? '/secretaria/servicios' : '/admin/servicios';
  }

  get serviciosActivos(): number {
    return this.servicios.filter(s => s.activo).length;
  }

  get precioPromedio(): number {
    const activos = this.servicios.filter(s => s.activo);
    if (activos.length === 0) return 0;
    const total = activos.reduce((sum, s) => sum + Number(s.precio), 0);
    return Math.round(total / activos.length);
  }

  ngOnInit(): void {
    const mem = this.adminService.getServiciosCacheSnapshot();
    if (mem.length > 0) {
      this.servicios = mem.map((s) => ({ ...s }));
      this.filtrarServicios();
      this.loading = false;
    } else {
      const snap = this.adminService.getServiciosListaBootstrap();
      if (snap.length > 0) {
        this.servicios = snap;
        this.filtrarServicios();
        this.loading = false;
      }
    }
    this.cargarServicios();
  }

  cargarServicios(): void {
    if (this.servicios.length === 0) {
      this.loading = true;
      this.listaRefreshing = false;
    } else {
      this.listaRefreshing = true;
    }
    this.adminService.getServicios().subscribe({
      next: (response) => {
        this.loading = false;
        this.listaRefreshing = false;
        if (response.ok) {
          this.servicios = response.servicios;
          this.filtrarServicios();
        }
      },
      error: () => {
        this.loading = false;
        this.listaRefreshing = false;
        this.modalService.showError('Error al cargar servicios');
      }
    });
  }

  filtrarServicios(): void {
    this.serviciosFiltrados = this.servicios.filter(s => {
      const matchNombre = !this.filtro || s.nombre.toLowerCase().includes(this.filtro.toLowerCase());
      const matchCategoria = !this.filtroCategoria || s.categoria === this.filtroCategoria;
      const matchEstado = !this.filtroEstado || 
        (this.filtroEstado === 'activo' ? s.activo : !s.activo);
      return matchNombre && matchCategoria && matchEstado;
    });
  }

  limpiarFiltros(): void {
    this.filtro = '';
    this.filtroCategoria = '';
    this.filtroEstado = 'activo';
    this.filtrarServicios();
  }

  getCategoriaLabel(categoria: string): string {
    const labels: Record<string, string> = {
      'corte': 'Cortes',
      'barba': 'Barba',
      'tratamiento': 'Tratamientos',
      'combo': 'Paquetes'
    };
    return labels[categoria] || categoria;
  }

  toggleEstado(servicio: Servicio): void {
    const nuevoEstado = !servicio.activo;
    this.adminService.actualizarServicio(servicio.id, { activo: nuevoEstado }).subscribe({
      next: () => {
        this.modalService.showSuccess(nuevoEstado ? 'Servicio activado' : 'Servicio desactivado');
        this.cargarServicios();
      },
      error: () => this.modalService.showError('Error al cambiar estado')
    });
  }

  eliminarServicio(servicio: Servicio, event?: Event): void {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (!confirm(`¿Eliminar permanentemente el servicio "${servicio.nombre}"?\n\nSi tiene citas o ventas relacionadas, no se podrá eliminar y deberás desactivarlo.`)) {
      return;
    }
    this.adminService.eliminarServicio(servicio.id).subscribe({
      next: (res) => {
        this.modalService.showSuccess(res?.mensaje || 'Servicio eliminado');
        this.servicios = this.servicios.filter(s => s.id !== servicio.id);
        this.filtrarServicios();
      },
      error: (err) => {
        this.modalService.showError(
          err?.error?.error ||
          err?.error?.detail ||
          'Error al eliminar servicio'
        );
      }
    });
  }
}
