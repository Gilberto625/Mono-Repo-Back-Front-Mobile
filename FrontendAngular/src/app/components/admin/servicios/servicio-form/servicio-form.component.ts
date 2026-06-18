import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Empleado } from '../../../../services/admin.service';
import { ModalService } from '../../../../services/modal.service';
import { esImagenValidaParaGaleria } from '../../../../utils/galeria-imagen.util';

@Component({
  selector: 'app-servicio-form',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './servicio-form.component.html',
  styleUrl: './servicio-form.component.css'
})
export class ServicioFormComponent implements OnInit {
  private adminService = inject(AdminService);
  private modalService = inject(ModalService);
  private router = inject(Router);

  guardando = false;
  subiendoImagen = false;
  barberos: Empleado[] = [];
  barberosSeleccionados: Set<number> = new Set();

  /** Galería: hasta 5 imágenes (cortes/barbas). La primera se usa como thumbnail en lista. */
  readonly GALERIA_MAX = 5;
  galeriaPreviews: (string | null)[] = Array(5).fill(null);
  galeriaFiles: (File | null)[] = Array(5).fill(null);

  readonly ETIQUETAS_ROSTRO = [
    { value: 'rostro-ovalado', label: 'Ovalado' },
    { value: 'rostro-redondo', label: 'Redondo' },
    { value: 'rostro-cuadrado', label: 'Cuadrado' },
    { value: 'rostro-oblongo', label: 'Oblongo' },
    { value: 'rostro-corazon', label: 'Corazón' },
    { value: 'rostro-diamante', label: 'Diamante' }
  ];
  readonly ETIQUETAS_ESTILO = [
    { value: 'estilo-clasico', label: 'Clásico' },
    { value: 'estilo-moderno', label: 'Moderno' },
    { value: 'estilo-deportivo', label: 'Deportivo' },
    { value: 'estilo-elegante', label: 'Elegante' },
    { value: 'estilo-casual', label: 'Casual' },
    { value: 'estilo-urbano', label: 'Urbano' }
  ];

  form = {
    nombre: '',
    descripcion: '',
    precio: 0,
    duracion_minutos: 30,
    categoria: 'corte',
    activo: true,
    popular: false,
    imagen_url: '',
    imagenes_galeria: ['', '', '', '', ''] as string[],
    etiquetas: [] as string[]
  };

  categorias = [
    { value: 'corte', label: 'Cortes' },
    { value: 'barba', label: 'Barba' },
    { value: 'tratamiento', label: 'Tratamientos' },
    { value: 'combo', label: 'Paquetes' }
  ];

  get esSecretaria(): boolean {
    return this.router.url.startsWith('/secretaria');
  }

  get serviciosBase(): string {
    return this.esSecretaria ? '/secretaria/servicios' : '/admin/servicios';
  }

  ngOnInit(): void {
    this.cargarBarberos();
  }

  cargarBarberos(): void {
    this.adminService.getEmpleados().subscribe({
      next: (res) => {
        if (res?.ok && Array.isArray(res.empleados)) {
          this.barberos = res.empleados.filter((e: Empleado) => e.rol === 'barbero');
        }
      }
    });
  }

  toggleEtiqueta(etiqueta: string): void {
    const idx = this.form.etiquetas.indexOf(etiqueta);
    if (idx >= 0) {
      this.form.etiquetas.splice(idx, 1);
    } else {
      this.form.etiquetas.push(etiqueta);
    }
  }

  tieneEtiqueta(etiqueta: string): boolean {
    return this.form.etiquetas.includes(etiqueta);
  }

  toggleBarbero(id: number): void {
    if (this.barberosSeleccionados.has(id)) {
      this.barberosSeleccionados.delete(id);
    } else {
      this.barberosSeleccionados.add(id);
    }
    this.barberosSeleccionados = new Set(this.barberosSeleccionados);
  }

  estaBarberoSeleccionado(id: number): boolean {
    return this.barberosSeleccionados.has(id);
  }

  iniciales(nombre: string, apellido: string): string {
    const n = (nombre || '').trim().charAt(0);
    const a = (apellido || '').trim().charAt(0);
    return (n + a).toUpperCase() || '?';
  }

  cancelar(): void {
    this.router.navigate([this.serviciosBase]);
  }

  onImagenGaleriaSeleccionada(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    if (file.size > 2 * 1024 * 1024) {
      this.modalService.showError('La imagen no debe superar 2MB');
      return;
    }
    if (!esImagenValidaParaGaleria(file)) {
      this.modalService.showError('Solo se permiten imágenes (JPG, PNG, WebP, HEIC, etc.)');
      return;
    }
    this.galeriaFiles[index] = file;
    this.form.imagenes_galeria[index] = '';
    const reader = new FileReader();
    reader.onload = (e) => {
      this.galeriaPreviews[index] = e.target?.result as string;
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  eliminarImagenGaleria(index: number): void {
    this.galeriaPreviews[index] = null;
    this.galeriaFiles[index] = null;
    this.form.imagenes_galeria[index] = '';
  }

  async guardar(): Promise<void> {
    if (!this.form.nombre?.trim()) {
      this.modalService.showError('El nombre del servicio es requerido');
      return;
    }
    if (this.form.precio == null || this.form.precio < 0) {
      this.modalService.showError('El precio es requerido y debe ser mayor o igual a 0');
      return;
    }

    this.guardando = true;
    try {
      this.subiendoImagen = true;
      const imagenes_galeria: string[] = [];
      for (let i = 0; i < this.GALERIA_MAX; i++) {
        if (this.galeriaFiles[i]) {
          const uploadRes = await this.adminService.uploadImage(this.galeriaFiles[i]!, 'servicios').toPromise();
          if (uploadRes?.ok) {
            imagenes_galeria.push(uploadRes.url);
          } else {
            throw new Error('Error al subir imagen ' + (i + 1));
          }
        } else if (this.form.imagenes_galeria[i]?.trim()) {
          imagenes_galeria.push(this.form.imagenes_galeria[i].trim());
        } else {
          imagenes_galeria.push('');
        }
      }
      this.subiendoImagen = false;
      const imagen_url = imagenes_galeria[0] || '';

      this.adminService.crearServicio({
        nombre: this.form.nombre.trim(),
        descripcion: (this.form.descripcion || '').trim(),
        precio: Number(this.form.precio),
        duracion_minutos: Number(this.form.duracion_minutos) || 30,
        categoria: this.form.categoria,
        imagen_url,
        imagenes_galeria,
        activo: this.form.activo,
        popular: this.form.popular,
        etiquetas: this.form.etiquetas,
        barberos_ids: Array.from(this.barberosSeleccionados)
      }).subscribe({
        next: (res) => {
          this.guardando = false;
          if (res?.ok) {
            this.modalService.showSuccess(res.mensaje || 'Servicio creado exitosamente');
            this.router.navigate([this.serviciosBase]);
          } else {
            this.modalService.showError(res?.error || 'Error al guardar');
          }
        },
        error: (err) => {
          this.guardando = false;
          this.modalService.showError(err?.error?.error || 'Error al crear servicio');
        }
      });
    } catch (e: unknown) {
      this.guardando = false;
      this.subiendoImagen = false;
      this.modalService.showError((e as Error)?.message || 'Error al subir imagen');
    }
  }
}
