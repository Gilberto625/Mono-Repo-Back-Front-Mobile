import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { CarritoService } from '../../../services/carrito.service';
import { PedidoService } from '../../../services/pedido.service';
import { ItemCarrito } from '../../../models';

@Component({
  selector: 'app-carrito',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './carrito.component.html',
  styleUrl: './carrito.component.css'
})
export class CarritoComponent implements OnInit {
  carritoService = inject(CarritoService);
  private pedidoService = inject(PedidoService);
  
  codigoDescuento = '';
  mensajeDescuento = '';
  descuentoValido = false;

  ngOnInit(): void {
    const codigoActivo = this.carritoService.getCodigoDescuento();
    if (codigoActivo) {
      this.codigoDescuento = codigoActivo;
      this.mensajeDescuento = 'Código aplicado correctamente';
      this.descuentoValido = true;
      return;
    }
    this.codigoDescuento = '';
    this.mensajeDescuento = '';
    this.descuentoValido = false;
  }

  incrementarCantidad(item: ItemCarrito): void {
    this.carritoService.actualizarCantidad(item.productoId, item.cantidad + 1);
  }

  decrementarCantidad(item: ItemCarrito): void {
    if (item.cantidad > 1) {
      this.carritoService.actualizarCantidad(item.productoId, item.cantidad - 1);
    }
  }

  eliminarItem(productoId: string): void {
    this.carritoService.removerItem(productoId);
  }

  vaciarCarrito(): void {
    if (confirm('¿Estás seguro de vaciar el carrito?')) {
      this.carritoService.vaciarCarrito();
    }
  }

  aplicarDescuento(): void {
    if (!this.codigoDescuento.trim()) {
      this.mensajeDescuento = 'Ingresa un código de descuento';
      this.descuentoValido = false;
      return;
    }

    const items = this.carritoService.items().map((i) => ({
      producto_id: Number(i.productoId),
      cantidad: Number(i.cantidad),
      precio_unitario: Number(i.precioUnitario),
    }));

    this.pedidoService.validarPromocion({
      codigo: this.codigoDescuento.trim().toUpperCase(),
      subtotal: this.carritoService.subtotal(),
      items,
    }).subscribe({
      next: (res: any) => {
        const promo = res?.promocion;
        if (res?.ok && promo?.codigo) {
          this.carritoService.aplicarCodigoDescuento({
            codigo: promo.codigo,
            tipo_descuento: promo.tipo_descuento,
            valor_descuento: Number(promo.valor_descuento || 0),
          });
          this.mensajeDescuento = '¡Código aplicado correctamente!';
          this.descuentoValido = true;
          return;
        }
        this.mensajeDescuento = res?.error || 'Código inválido o expirado';
        this.descuentoValido = false;
      },
      error: (err: any) => {
        this.mensajeDescuento = err?.error?.error || err?.error?.detail || 'No se pudo validar el código en este momento';
        this.descuentoValido = false;
      }
    });
  }
}
