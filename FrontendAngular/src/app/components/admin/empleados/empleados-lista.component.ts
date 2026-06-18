import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Empleado } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';

@Component({
  selector: 'app-empleados-lista',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './empleados-lista.component.html',
  styleUrl: './empleados-lista.component.css'
})
export class EmpleadosListaComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);
  private readonly router = inject(Router);

  empleados: Empleado[] = [];
  empleadosFiltrados: Empleado[] = [];
  /** Sin datos aún (primera carga o sin caché). */
  loading = true;
  /** Actualización en segundo plano cuando ya hay filas en pantalla. */
  listaRefreshing = false;

  private readonly snapKey = 'admin_empleados_lista_v1';
  private readonly snapMaxAgeMs = 3 * 60 * 1000;
  
  filtro = '';
  filtroRol = '';
  filtroEstado = '';

  get esSecretaria(): boolean {
    return this.router.url.startsWith('/secretaria');
  }

  get empleadosBase(): string {
    return this.esSecretaria ? '/secretaria/empleados' : '/admin/empleados';
  }

  /** True si el empleado está en vacaciones hoy (flag en_vacaciones o periodo aprobado activo) */
  empleadoEnVacacionesHoy(e: Empleado): boolean {
    if (e.en_vacaciones) return true;
    const pv = e.periodos_vacaciones;
    if (!pv || pv === '' || pv === '[]') return false;
    try {
      const lista = typeof pv === 'string' ? JSON.parse(pv) : pv;
      if (!Array.isArray(lista)) return false;
      const hoy = new Date().toISOString().slice(0, 10);
      return lista.some((item: { fecha_inicio?: string; fecha_fin?: string; estado?: string }) => {
        if (item.estado !== 'aprobado') return false;
        const inicio = item.fecha_inicio?.slice(0, 10) || '';
        const fin = item.fecha_fin?.slice(0, 10) || '';
        return inicio && fin && hoy >= inicio && hoy <= fin;
      });
    } catch {
      return false;
    }
  }

  get empleadosActivos(): number {
    return this.empleados.filter(e => e.activo && !this.empleadoEnVacacionesHoy(e)).length;
  }

  get empleadosEnVacaciones(): number {
    return this.empleados.filter(e => this.empleadoEnVacacionesHoy(e)).length;
  }

  get empleadosInactivos(): number {
    return this.empleados.filter(e => !e.activo).length;
  }

  getRolLabel(rol: string): string {
    const labels: Record<string, string> = {
      admin: 'Administrador',
      barbero: 'Barbero',
      secretaria: 'Secretaria',
      cliente: 'Cliente'
    };
    return labels[rol] || rol;
  }

  getEspecialidadDisplay(empleado: Empleado): string {
    if (empleado.rol !== 'barbero' || !empleado.especialidades) return '-';
    try {
      const arr = typeof empleado.especialidades === 'string' && empleado.especialidades.startsWith('[')
        ? JSON.parse(empleado.especialidades) : (empleado.especialidades || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      return Array.isArray(arr) ? arr.join(', ') : empleado.especialidades;
    } catch {
      return empleado.especialidades || '-';
    }
  }

  ngOnInit(): void {
    if (this.esSecretaria) {
      this.filtroRol = 'barbero';
    }
    const mem = this.adminService.getEmpleadosCacheSnapshot();
    if (mem.length > 0) {
      this.empleados = mem;
      this.filtrarEmpleados();
      this.loading = false;
    } else if (this.restaurarSnapshotSesion()) {
      this.loading = false;
    }
    this.cargarEmpleados();
  }

  private restaurarSnapshotSesion(): boolean {
    try {
      const raw = sessionStorage.getItem(this.snapKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { at?: number; empleados?: Empleado[] };
      if (!parsed?.empleados?.length || typeof parsed.at !== 'number') return false;
      if (Date.now() - parsed.at > this.snapMaxAgeMs) return false;
      this.empleados = parsed.empleados;
      this.filtrarEmpleados();
      return true;
    } catch {
      return false;
    }
  }

  private guardarSnapshotSesion(): void {
    if (!this.empleados.length) return;
    try {
      sessionStorage.setItem(this.snapKey, JSON.stringify({ at: Date.now(), empleados: this.empleados }));
    } catch {
      /* ignore */
    }
  }

  cargarEmpleados(): void {
    if (this.empleados.length === 0) {
      this.loading = true;
      this.listaRefreshing = false;
    } else {
      this.listaRefreshing = true;
    }
    this.adminService.getEmpleados().subscribe({
      next: (response) => {
        this.loading = false;
        this.listaRefreshing = false;
        if (response.ok) {
          this.empleados = response.empleados;
          this.filtrarEmpleados();
          this.guardarSnapshotSesion();
        }
      },
      error: (error) => {
        this.loading = false;
        this.listaRefreshing = false;
        this.modalService.showError('Error al cargar empleados');
        console.error(error);
      }
    });
  }

  filtrarEmpleados(): void {
    this.empleadosFiltrados = this.empleados.filter(e => {
      const matchNombre = !this.filtro ||
        `${e.nombre || ''} ${e.apellido || ''} ${e.email || ''}`.toLowerCase().includes(this.filtro.toLowerCase());
      const matchRol = !this.filtroRol || e.rol === this.filtroRol;
      let matchEstado = true;
      if (this.filtroEstado) {
        switch (this.filtroEstado) {
          case 'activo':
            matchEstado = e.activo && !this.empleadoEnVacacionesHoy(e);
            break;
          case 'inactivo':
            matchEstado = !e.activo;
            break;
          case 'vacaciones':
            matchEstado = this.empleadoEnVacacionesHoy(e);
            break;
        }
      }
      return matchNombre && matchRol && matchEstado;
    });
  }

  limpiarFiltros(): void {
    this.filtro = '';
    this.filtroRol = this.esSecretaria ? 'barbero' : '';
    this.filtroEstado = '';
    this.filtrarEmpleados();
  }

  getIniciales(empleado: Empleado): string {
    const nombre = empleado.nombre || empleado.email.split('@')[0];
    const apellido = empleado.apellido || '';
    return `${nombre[0] || ''}${apellido[0] || nombre[1] || ''}`.toUpperCase();
  }

  desactivarEmpleado(empleado: Empleado): void {
    if (confirm(`¿Desactivar a ${empleado.nombre}?`)) {
      this.adminService.actualizarEmpleado(empleado.id, { activo: false }).subscribe({
        next: () => {
          this.modalService.showSuccess('Usuario desactivado');
          this.cargarEmpleados();
        },
        error: () => this.modalService.showError('Error al desactivar')
      });
    }
  }

  activarEmpleado(empleado: Empleado): void {
    this.adminService.actualizarEmpleado(empleado.id, { activo: true }).subscribe({
      next: () => {
        this.modalService.showSuccess('Usuario activado');
        this.cargarEmpleados();
      },
      error: () => this.modalService.showError('Error al activar')
    });
  }
}
