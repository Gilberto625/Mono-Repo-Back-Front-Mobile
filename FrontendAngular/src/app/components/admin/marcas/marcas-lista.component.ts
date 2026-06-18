import { Component, OnInit, inject, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, MarcaAdmin } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';
import { RolUsuario } from '../../../models';

@Component({
  selector: 'app-marcas-lista',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './marcas-lista.component.html',
  styleUrl: './marcas-lista.component.css'
})
export class MarcasListaComponent implements OnInit {
  @Input() rol?: RolUsuario;

  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);
  private readonly router = inject(Router);

  marcas: MarcaAdmin[] = [];
  loading = true;
  mostrarFormNueva = false;
  guardando = false;
  form = { nombre: '' };

  get rolActual(): RolUsuario {
    if (this.rol) return this.rol;
    const url = this.router.url;
    return url.startsWith('/secretaria') ? 'secretaria' : 'admin';
  }

  get baseRoute(): string {
    return this.rolActual === 'secretaria' ? '/secretaria' : '/admin';
  }

  get marcasActivas(): number {
    return this.marcas.filter(m => m.activa).length;
  }

  ngOnInit(): void {
    const mem = this.adminService.getMarcasCacheSnapshot();
    if (mem.length > 0) {
      this.marcas = mem.map((m) => ({ ...m }));
      this.loading = false;
    } else {
      const snap = this.adminService.getMarcasListaBootstrap();
      if (snap.length > 0) {
        this.marcas = snap;
        this.loading = false;
      }
    }
    this.cargarMarcas();
  }

  toggleFormNueva(): void {
    this.mostrarFormNueva = !this.mostrarFormNueva;
    if (this.mostrarFormNueva) this.form = { nombre: '' };
  }

  cargarMarcas(): void {
    this.loading = this.marcas.length === 0;
    this.adminService.getMarcas().subscribe({
      next: (res) => {
        this.loading = false;
        if (res?.ok) {
          this.marcas = res.marcas || [];
        }
      },
      error: () => {
        this.loading = false;
        this.modalService.showError('Error al cargar marcas');
      }
    });
  }

  guardarMarca(): void {
    const nombre = (this.form.nombre || '').trim();
    if (!nombre) {
      this.modalService.showError('El nombre de la marca es requerido');
      return;
    }
    this.guardando = true;
    this.adminService.crearMarca({ nombre }).subscribe({
      next: (res) => {
        this.guardando = false;
        if (res?.ok) {
          this.modalService.showSuccess('Marca agregada correctamente');
          this.mostrarFormNueva = false;
          this.form = { nombre: '' };
          this.cargarMarcas();
        } else {
          this.modalService.showError(res?.error || 'Error al guardar');
        }
      },
      error: (err) => {
        this.guardando = false;
        this.modalService.showError(err?.error?.error || 'Error al agregar marca');
      }
    });
  }
}
