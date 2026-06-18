import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Producto } from '../../../../services/admin.service';
import { ModalService } from '../../../../services/modal.service';
import { esImagenValidaParaGaleria } from '../../../../utils/galeria-imagen.util';
import { firstValueFrom } from 'rxjs';

interface MarcaOption {
  id: number;
  nombre: string;
  activa: boolean;
}

@Component({
  selector: 'app-producto-editar',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './producto-editar.component.html',
  styleUrl: './producto-editar.component.css'
})
export class ProductoEditarComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly navProducto = this.router.getCurrentNavigation()?.extras?.state?.['producto'] as Producto | undefined;

  productoId = 0;
  loading = true;
  guardando = false;
  subiendoImagen = false;
  /** Marcas de producto cargadas desde el backend, ordenadas alfabéticamente */
  marcas: MarcaOption[] = [];
  loadingMarcas = true;

  readonly GALERIA_MAX = 5;
  galeriaIndices: number[] = [0, 1, 2, 3, 4];
  galeriaPreviews: (string | null)[] = new Array(5).fill(null);
  galeriaFiles: (File | null)[] = new Array(5).fill(null);

  form = {
    nombre: '',
    marca: '',
    descripcion: '',
    peso_volumen: '',
    categoria: 'cabello',
    precio: 0,
    stock: 0,
    stock_minimo: 10,
    activo: true,
    destacado: false,
    imagen_url: '',
    imagenes_galeria: ['', '', '', '', ''] as string[]
  };

  categorias = [
    { value: 'cabello', label: 'Cabello' },
    { value: 'barba', label: 'Barba' },
    { value: 'facial', label: 'Facial' },
    { value: 'accesorios', label: 'Accesorios' },
    { value: 'kit', label: 'Kits' }
  ];

  get esSecretaria(): boolean {
    return this.router.url.startsWith('/secretaria');
  }

  /** Marcas ordenadas alfabéticamente por nombre (incluye inactivas para mostrar la actual del producto) */
  get marcasOrdenadas(): MarcaOption[] {
    return [...this.marcas].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es', { sensitivity: 'base' }));
  }

  get catalogoBase(): string {
    return this.esSecretaria ? '/secretaria/catalogo' : '/admin/productos';
  }

  get inventarioBase(): string {
    return this.esSecretaria ? '/secretaria/inventario' : '/admin/inventario';
  }

  ngOnInit(): void {
    this.adminService.getMarcas().subscribe({
      next: (res) => {
        this.loadingMarcas = false;
        if (res?.ok && Array.isArray(res.marcas)) {
          this.marcas = res.marcas;
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.loadingMarcas = false;
        this.cdr.markForCheck();
      },
    });

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.loading = false;
      return;
    }
    this.productoId = +id;

    const desdeNav = this.navProducto?.id === this.productoId ? this.navProducto : null;
    const bootRaw = this.adminService.getProductoEdicionBootstrap(this.productoId);
    let instant: Record<string, unknown> | null = bootRaw;
    if (!instant && desdeNav) {
      instant = {
        ...desdeNav,
        imagenes_galeria: [] as string[],
      };
    }
    if (instant) {
      this.aplicarProductoAlForm(instant);
      this.loading = false;
      this.cdr.markForCheck();
    }

    this.adminService.getProducto(this.productoId).subscribe({
      next: (res) => {
        if (res?.ok && res.producto) {
          this.aplicarProductoAlForm(res.producto as Record<string, unknown>);
        } else if (!instant) {
          this.modalService.showError('Producto no encontrado');
          this.router.navigate([this.catalogoBase]);
        }
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        if (!instant) {
          this.modalService.showError('Error al cargar el producto');
          this.router.navigate([this.catalogoBase]);
        }
        this.loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  private aplicarProductoAlForm(p: Record<string, unknown>): void {
    const galeria = Array.isArray(p['imagenes_galeria']) ? (p['imagenes_galeria'] as string[]) : [];
    const imagenes_galeria = [...galeria];
    while (imagenes_galeria.length < 5) {
      imagenes_galeria.push('');
    }

    const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
    const num = (v: unknown, fallback = 0): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    this.form = {
      nombre: str(p['nombre']),
      marca: str(p['marca']),
      descripcion: str(p['descripcion']),
      peso_volumen: str(p['peso_volumen']),
      categoria: str(p['categoria'], 'cabello') || 'cabello',
      precio: num(p['precio'], 0),
      stock: num(p['stock'], 0),
      stock_minimo: num(p['stock_minimo'], 10),
      activo: p['activo'] !== false,
      destacado: !!p['destacado'],
      imagen_url: str(p['imagen_url']),
      imagenes_galeria: imagenes_galeria.slice(0, 5),
    };
    this.galeriaPreviews = new Array(5).fill(null);
    this.galeriaFiles = new Array(5).fill(null);
  }

  cancelar(): void {
    this.router.navigate([this.catalogoBase]);
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
      this.cdr.markForCheck();
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
      this.modalService.showError('El nombre del producto es requerido');
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
          const uploadRes = await firstValueFrom(
            this.adminService.uploadImage(this.galeriaFiles[i]!, 'productos')
          );
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

      this.adminService.actualizarProducto(this.productoId, {
        nombre: this.form.nombre.trim(),
        marca: (this.form.marca || '').trim(),
        descripcion: (this.form.descripcion || '').trim(),
        peso_volumen: (this.form.peso_volumen || '').trim(),
        categoria: this.form.categoria,
        precio: Number(this.form.precio),
        stock_minimo: Number.isFinite(Number(this.form.stock_minimo)) ? Number(this.form.stock_minimo) : 10,
        imagen_url,
        imagenes_galeria,
        activo: this.form.activo,
        destacado: this.form.destacado
      }).subscribe({
        next: (res) => {
          this.guardando = false;
          if (res?.ok) {
            this.modalService.showSuccess(res.mensaje || 'Producto actualizado');
            this.router.navigate([this.catalogoBase]);
          } else {
            this.modalService.showError(res?.error || 'Error al guardar');
          }
        },
        error: (err) => {
          this.guardando = false;
          this.modalService.showError(err?.error?.error || 'Error al actualizar producto');
        }
      });
    } catch (e: unknown) {
      this.guardando = false;
      this.subiendoImagen = false;
      this.modalService.showError((e as Error)?.message || 'Error al subir imagen');
    }
  }

  eliminarProducto(): void {
    if (!confirm(`¿Eliminar permanentemente el producto "${this.form.nombre}"?\n\nSi tiene ventas, pedidos o inventario relacionado, no se podrá eliminar y deberás desactivarlo.`)) {
      return;
    }
    this.adminService.eliminarProducto(this.productoId).subscribe({
      next: (res) => {
        this.modalService.showSuccess(res?.mensaje || 'Producto eliminado');
        this.router.navigate([this.catalogoBase]);
      },
      error: (err) => {
        this.modalService.showError(
          err?.error?.error ||
          err?.error?.detail ||
          'Error al eliminar producto'
        );
      }
    });
  }
}
