import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Empleado, Servicio } from '../../../../services/admin.service';
import { ModalService } from '../../../../services/modal.service';
import { esImagenValidaParaGaleria } from '../../../../utils/galeria-imagen.util';

@Component({
  selector: 'app-servicio-editar',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './servicio-editar.component.html',
  styleUrl: './servicio-editar.component.css'
})
export class ServicioEditarComponent implements OnInit {
  private adminService = inject(AdminService);
  private modalService = inject(ModalService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private readonly navServicio = this.router.getCurrentNavigation()?.extras?.state?.['servicio'] as Servicio | undefined;

  servicioId: number = 0;
  loading = true;
  guardando = false;
  subiendoImagen = false;
  barberos: Empleado[] = [];
  barberosSeleccionados: Set<number> = new Set();

  readonly GALERIA_MAX = 5;
  /** Índices 0-4 para los 5 slots de la galería (igual que en crear servicio) */
  galeriaIndices: number[] = [0, 1, 2, 3, 4];
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
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.loading = false;
      return;
    }
    this.servicioId = +id;

    const desdeNav = this.navServicio && this.navServicio.id === this.servicioId ? this.navServicio : null;
    const bootRaw = this.adminService.getServicioEdicionBootstrap(this.servicioId);
    let instant: Record<string, unknown> | null = bootRaw;
    if (!instant && desdeNav) {
      instant = {
        ...desdeNav,
        imagenes_galeria: [] as string[],
        barberos_ids: [] as number[],
        etiquetas: [] as string[],
      };
    }
    if (instant) {
      this.aplicarServicioAlForm(instant as Record<string, unknown>);
      this.loading = false;
    }

    const empSnap = this.adminService.getEmpleadosCacheSnapshot();
    if (empSnap.length > 0) {
      this.barberos = empSnap.filter((e) => e.rol === 'barbero');
    } else {
      this.adminService.getEmpleados().subscribe({
        next: (res) => {
          if (res?.ok && Array.isArray(res.empleados)) {
            this.barberos = res.empleados.filter((e: Empleado) => e.rol === 'barbero');
          }
        },
      });
    }

    this.adminService.getServicio(this.servicioId).subscribe({
      next: (res) => {
        if (res?.ok && res.servicio) {
          this.aplicarServicioAlForm(res.servicio as Record<string, unknown>);
        } else if (!instant) {
          this.modalService.showError('Servicio no encontrado');
          this.router.navigate([this.serviciosBase]);
        }
        this.loading = false;
      },
      error: () => {
        if (!instant) {
          this.modalService.showError('Error al cargar el servicio');
          this.router.navigate([this.serviciosBase]);
        }
        this.loading = false;
      },
    });
  }

  private aplicarServicioAlForm(s: Record<string, unknown>): void {
    const galeria = Array.isArray(s['imagenes_galeria']) ? (s['imagenes_galeria'] as string[]) : [];
    const imagenes_galeria = [...galeria];
    while (imagenes_galeria.length < 5) {
      imagenes_galeria.push('');
    }
    this.form = {
      nombre: String(s['nombre'] ?? ''),
      descripcion: String(s['descripcion'] ?? ''),
      precio: Number(s['precio']) || 0,
      duracion_minutos: (s['duracion_minutos'] as number) ?? 30,
      categoria: String(s['categoria'] ?? 'corte'),
      activo: s['activo'] !== false,
      popular: !!s['popular'],
      imagen_url: String(s['imagen_url'] ?? ''),
      imagenes_galeria: imagenes_galeria.slice(0, 5),
      etiquetas: Array.isArray(s['etiquetas']) ? [...(s['etiquetas'] as string[])] : [],
    };
    this.galeriaPreviews = Array(5).fill(null);
    this.galeriaFiles = Array(5).fill(null);
    if (Array.isArray(s['barberos_ids'])) {
      this.barberosSeleccionados = new Set(s['barberos_ids'] as number[]);
    }
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

      this.adminService.actualizarServicio(this.servicioId, {
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
            this.modalService.showSuccess(res.mensaje || 'Servicio actualizado');
            this.router.navigate([this.serviciosBase]);
          } else {
            this.modalService.showError(res?.error || 'Error al guardar');
          }
        },
        error: (err) => {
          this.guardando = false;
          this.modalService.showError(err?.error?.error || 'Error al actualizar servicio');
        }
      });
    } catch (e: unknown) {
      this.guardando = false;
      this.subiendoImagen = false;
      this.modalService.showError((e as Error)?.message || 'Error al subir imagen');
    }
  }

  eliminarServicio(): void {
    if (!confirm(`¿Eliminar permanentemente el servicio "${this.form.nombre}"?\n\nSi este servicio ya tiene citas o ventas relacionadas, no se podrá eliminar y deberás desactivarlo desde el campo Estado.`)) {
      return;
    }
    this.adminService.eliminarServicio(this.servicioId).subscribe({
      next: (res) => {
        this.modalService.showSuccess(res?.mensaje || 'Servicio eliminado');
        this.router.navigate([this.serviciosBase]);
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
