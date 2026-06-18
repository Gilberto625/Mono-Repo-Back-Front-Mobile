import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Producto } from '../../../../services/admin.service';
import { ModalService } from '../../../../services/modal.service';

@Component({
  selector: 'app-secretaria-movimiento-inventario',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './movimiento-inventario.component.html',
  styleUrl: './movimiento-inventario.component.css'
})
export class SecretariaMovimientoInventarioComponent implements OnInit {
  private adminService = inject(AdminService);
  private modalService = inject(ModalService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  productos: Producto[] = [];
  loading = true;
  guardando = false;
  tipo: 'entrada' | 'salida' = 'entrada';
  productoId = '';
  cantidad = 0;
  notas = '';

  get productoSeleccionado(): Producto | undefined {
    return this.productos.find(p => p.id.toString() === this.productoId);
  }
  get titulo(): string {
    return this.tipo === 'entrada' ? 'Registrar entrada' : 'Registrar salida';
  }
  get subtitulo(): string {
    return this.tipo === 'entrada'
      ? 'Suma unidades al stock (compra o reabastecimiento)'
      : 'Resta unidades del stock (uso interno o venta)';
  }
  get labelBoton(): string {
    return this.guardando ? 'Registrando...' : (this.tipo === 'entrada' ? 'Registrar entrada' : 'Registrar salida');
  }

  ngOnInit(): void {
    const path = this.route.snapshot.url.map(u => u.path).join('/');
    this.tipo = path.includes('entrada') ? 'entrada' : 'salida';
    const productoIdParam = this.route.snapshot.paramMap.get('productoId');
    if (productoIdParam) this.productoId = productoIdParam;
    this.cargarProductos();
  }

  cargarProductos(): void {
    this.loading = true;
    this.adminService.getProductos(true).subscribe({
      next: (response) => {
        this.loading = false;
        if (response.ok) this.productos = response.productos;
      },
      error: () => {
        this.loading = false;
        this.modalService.showError('Error al cargar productos');
      }
    });
  }

  volver(): void {
    this.router.navigate(['/secretaria/inventario']);
  }

  guardar(): void {
    if (!this.productoId || this.cantidad <= 0) {
      this.modalService.showError('Selecciona un producto y una cantidad válida');
      return;
    }
    if (this.tipo === 'salida' && this.productoSeleccionado && this.cantidad > this.productoSeleccionado.stock) {
      this.modalService.showError('La salida no puede ser mayor al stock actual del producto');
      return;
    }
    if (!this.notas.trim()) {
      this.modalService.showError('La nota es obligatoria para secretaría. Especifica motivo y por qué se realiza el movimiento.');
      return;
    }

    this.guardando = true;
    const cantidad = this.tipo === 'salida' ? -this.cantidad : this.cantidad;

    this.adminService.actualizarStock(
      parseInt(this.productoId, 10),
      cantidad,
      'sumar',
      this.notas.trim()
    ).subscribe({
      next: (response) => {
        this.guardando = false;
        if (response.ok) {
          const producto = this.productos.find(p => p.id.toString() === this.productoId);
          this.modalService.showSuccess(`Stock actualizado: ${response.stock_actual} unidades`);
          this.router.navigate(['/secretaria/inventario'], {
            state: {
              ultimoMovimiento: {
                tipo: this.tipo,
                producto: producto?.nombre || 'Producto',
                cantidad: this.cantidad,
                fecha: new Date(),
                usuario: 'Secretaría',
                notas: this.notas.trim()
              }
            }
          });
        }
      },
      error: (err) => {
        this.guardando = false;
        this.modalService.showError(
          err?.error?.error ||
          err?.error?.detail ||
          'Error al registrar movimiento'
        );
      }
    });
  }
}
