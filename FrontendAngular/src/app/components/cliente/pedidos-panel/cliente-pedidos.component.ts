import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { PedidoService, PedidoResp } from '../../../services/pedido.service';

@Component({
  selector: 'app-cliente-pedidos',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './cliente-pedidos.component.html',
  styleUrl: './cliente-pedidos.component.css'
})
export class ClientePedidosComponent implements OnInit {
  pedidoService = inject(PedidoService);

  ngOnInit(): void {
    this.pedidoService.cargarPedidos();
  }

  getEstadoLabel(estado: string): string {
    const labels: Record<string, string> = {
      'pendiente': 'Pendiente',
      'aceptado': 'Aceptado',
      'comprobando_pago': 'Comprobando pago',
      'pago_validado': 'Pago validado',
      'confirmado': 'Confirmado',
      'preparando': 'Preparando',
      'listo_recoger': 'Listo para recoger',
      'enviado': 'En camino',
      'entregado': 'Entregado',
      'cancelado': 'Cancelado',
    };
    return labels[estado] || estado;
  }

  getEstadoClass(estado: string): string {
    const clases: Record<string, string> = {
      'pendiente': 'badge-warning',
      'aceptado': 'badge-info',
      'comprobando_pago': 'badge-warning',
      'pago_validado': 'badge-info',
      'confirmado': 'badge-info',
      'preparando': 'badge-info',
      'listo_recoger': 'badge-gold',
      'enviado': 'badge-gold',
      'entregado': 'badge-success',
      'cancelado': 'badge-error',
    };
    return clases[estado] || '';
  }

  getEntregaLabel(metodo: string): string {
    const labels: Record<string, string> = {
      'recoger_local': 'Recoger en local',
      'moto_mandado': 'Moto mandado',
      'paqueteria': 'Paquetería',
    };
    return labels[metodo] || metodo;
  }

  formatFecha(fecha: string): string {
    try {
      return new Date(fecha).toLocaleDateString('es-MX', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch {
      return fecha;
    }
  }
}
