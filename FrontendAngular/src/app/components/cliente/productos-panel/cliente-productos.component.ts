import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { ProductoService } from '../../../services/producto.service';
import { CarritoService } from '../../../services/carrito.service';
import { ModalService } from '../../../services/modal.service';
import { Producto } from '../../../models';

type CategoriaFiltro = 'todos' | 'cabello' | 'barba' | 'facial' | 'accesorios' | 'kit';

@Component({
  selector: 'app-cliente-productos',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './cliente-productos.component.html',
  styleUrl: './cliente-productos.component.css'
})
export class ClienteProductosComponent implements OnInit {
  private readonly productoService = inject(ProductoService);
  private readonly modalService = inject(ModalService);
  carritoService = inject(CarritoService);

  categoriaActiva = signal<CategoriaFiltro>('todos');
  marcaActiva = signal<string>('todas');
  ordenActivo = signal<'popularidad' | 'precio_asc' | 'precio_desc'>('popularidad');

  // Para feedback visual de "Agregado"
  productoAgregado = signal<string>('');

  ngOnInit(): void {
    this.productoService.loadProductosPublicos();
  }

  marcasDisponibles = computed(() => {
    const categoria = this.categoriaActiva();
    const productosBase = this.productoService.productos();
    const productos = categoria === 'todos'
      ? productosBase
      : productosBase.filter(p => p.categoria === categoria);

    const marcas = Array.from(
      new Set(
        productos
          .map(p => (p.marca || '').trim())
          .filter(m => !!m)
      )
    );
    return marcas.sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  });

  productosFiltrados = computed(() => {
    const categoria = this.categoriaActiva();
    const marca = this.marcaActiva();
    const orden = this.ordenActivo();
    const base = this.productoService.productos();

    let productos = categoria === 'todos' ? base : base.filter(p => p.categoria === categoria);
    if (marca !== 'todas') {
      const marcaNorm = marca.trim().toLowerCase();
      productos = productos.filter(p => (p.marca || '').trim().toLowerCase() === marcaNorm);
    }

    productos = productos.slice();

    switch (orden) {
      case 'precio_asc':
        productos.sort((a, b) => a.precio - b.precio);
        break;
      case 'precio_desc':
        productos.sort((a, b) => b.precio - a.precio);
        break;
      case 'popularidad':
      default:
        productos.sort((a, b) => (b.destacado ? 1 : 0) - (a.destacado ? 1 : 0));
        break;
    }

    return productos;
  });

  filtrarCategoria(categoria: CategoriaFiltro): void {
    this.categoriaActiva.set(categoria);
    this.marcaActiva.set('todas');
  }

  filtrarMarca(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.marcaActiva.set(select.value || 'todas');
  }

  ordenar(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.ordenActivo.set(select.value as 'popularidad' | 'precio_asc' | 'precio_desc');
  }

  agregarAlCarrito(producto: Producto): void {
    if (producto.stock <= 0) {
      this.modalService.showError('Este producto está agotado');
      return;
    }

    const agregado = this.carritoService.agregarItem(producto);
    if (agregado) {
      this.productoAgregado.set(producto.id);
      setTimeout(() => this.productoAgregado.set(''), 2000);
    } else {
      this.modalService.showWarning('No hay suficiente stock disponible');
    }
  }

  estaEnCarrito(productoId: string): boolean {
    return this.carritoService.estaEnCarrito(productoId);
  }
}
