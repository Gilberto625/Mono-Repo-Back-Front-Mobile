import { Component, inject, ChangeDetectorRef, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService } from '../../../../services/admin.service';
import { ModalService } from '../../../../services/modal.service';
import { esImagenValidaParaGaleria } from '../../../../utils/galeria-imagen.util';

interface MarcaOption {
  id: number;
  nombre: string;
  activa: boolean;
}

@Component({
  selector: 'app-producto-form',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './producto-form.component.html',
  styleUrl: './producto-form.component.css'
})
export class ProductoFormComponent implements OnInit {
  private adminService = inject(AdminService);
  private modalService = inject(ModalService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  guardando = false;
  subiendoImagen = false;
  /** Marcas de producto cargadas desde el backend, ordenadas alfabéticamente */
  marcas: MarcaOption[] = [];
  loadingMarcas = true;

  readonly GALERIA_MAX = 5;
  galeriaIndices: number[] = [0, 1, 2, 3, 4];
  galeriaPreviews: (string | null)[] = Array(5).fill(null);
  galeriaFiles: (File | null)[] = Array(5).fill(null);

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

  /** Marcas ordenadas alfabéticamente por nombre (solo activas para el select) */
  get marcasOrdenadas(): MarcaOption[] {
    return [...this.marcas]
      .filter(m => m.activa)
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es', { sensitivity: 'base' }));
  }

  get catalogoBase(): string {
    return this.esSecretaria ? '/secretaria/catalogo' : '/admin/productos';
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
      }
    });
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
    const tieneAlgunaImagen = this.galeriaFiles.some((f) => !!f) || this.form.imagenes_galeria.some((u) => !!u?.trim());
    if (!tieneAlgunaImagen) {
      this.modalService.showError('Debes agregar al menos una imagen del producto');
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
          const uploadRes = await this.adminService.uploadImage(this.galeriaFiles[i]!, 'productos').toPromise();
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

      this.adminService.crearProducto({
        nombre: this.form.nombre.trim(),
        marca: (this.form.marca || '').trim(),
        descripcion: (this.form.descripcion || '').trim(),
        peso_volumen: (this.form.peso_volumen || '').trim(),
        categoria: this.form.categoria,
        precio: Number(this.form.precio),
        stock: Number(this.form.stock) || 0,
        stock_minimo: Number(this.form.stock_minimo) ?? 10,
        imagen_url,
        imagenes_galeria,
        activo: this.form.activo,
        destacado: this.form.destacado
      }).subscribe({
        next: (res) => {
          this.guardando = false;
          if (res?.ok) {
            this.modalService.showSuccess(res.mensaje || 'Producto creado exitosamente');
            this.router.navigate([this.catalogoBase]);
          } else {
            this.modalService.showError(res?.error || 'Error al guardar');
          }
        },
        error: (err) => {
          this.guardando = false;
          this.modalService.showError(err?.error?.error || 'Error al crear producto');
        }
      });
    } catch (e: unknown) {
      this.guardando = false;
      this.subiendoImagen = false;
      this.modalService.showError((e as Error)?.message || 'Error al subir imagen');
    }
  }
}
