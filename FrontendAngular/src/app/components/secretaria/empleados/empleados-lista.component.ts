import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
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
  private adminService = inject(AdminService);
  private modalService = inject(ModalService);

  empleados: Empleado[] = [];
  empleadosFiltrados: Empleado[] = [];
  loading = true;
  
  filtro = '';
  filtroRol = 'barbero';
  filtroEstado = '';

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
    this.cargarEmpleados();
  }

  cargarEmpleados(): void {
    this.loading = true;
    this.adminService.getEmpleados().subscribe({
      next: (response) => {
        this.loading = false;
        if (response.ok) {
          this.empleados = response.empleados;
          this.filtrarEmpleados();
        }
      },
      error: (error) => {
        this.loading = false;
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
      const matchEstado = !this.filtroEstado ||
        (this.filtroEstado === 'activo' ? (e.activo && !this.empleadoEnVacacionesHoy(e)) :
         this.filtroEstado === 'inactivo' ? !e.activo :
         this.filtroEstado === 'vacaciones' ? this.empleadoEnVacacionesHoy(e) : true);
      return matchNombre && matchRol && matchEstado;
    });
  }

  limpiarFiltros(): void {
    this.filtro = '';
    this.filtroRol = 'barbero';
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
