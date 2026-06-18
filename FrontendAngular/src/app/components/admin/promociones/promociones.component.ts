import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { AdminService, EstadisticasPromociones, PromocionAdmin } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';

type TabPromocion = 'activas' | 'pausadas' | 'finalizadas' | 'codigos';

@Component({
  selector: 'app-promociones',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './promociones.component.html',
  styleUrl: './promociones.component.css'
})
export class PromocionesComponent implements OnInit {
  private adminService = inject(AdminService);
  private modalService = inject(ModalService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  loading = false;
  guardando = false;
  tabActiva: TabPromocion = 'activas';
  mostrarFormulario = false;
  editandoId: number | null = null;

  promociones: PromocionAdmin[] = [];
  estadisticas: EstadisticasPromociones = {
    promociones_activas: 0,
    promociones_programadas: 0,
    promociones_finalizadas: 0,
    promociones_pausadas: 0,
    usos_total: 0,
    descuentos_aplicados_mes: 0
  };

  form: {
    nombre: string;
    descripcion: string;
    tipo_descuento: 'porcentaje' | 'monto_fijo' | '2x1' | 'producto_gratis';
    aplica_en: 'servicios' | 'productos' | 'ambos';
    valor_descuento: number;
    codigo: string;
    fecha_inicio: string;
    fecha_fin: string;
    solo_clientes_nuevos: boolean;
    requiere_compra_minima: boolean;
    monto_compra_minima: number | null;
    limite_usos: number | null;
    activa: boolean;
  } = this.nuevoForm();

  ngOnInit(): void {
    this.cargarPromociones();
    this.syncFormularioDesdeRuta();
    this.route.params.subscribe(() => this.syncFormularioDesdeRuta());
  }

  private syncFormularioDesdeRuta(): void {
    const url = this.router.url || '';
    const matchEditar = url.match(/\/admin\/promociones\/editar\/(\d+)/);
    if (matchEditar) {
      const promoId = Number(matchEditar[1]);
      if (Number.isFinite(promoId) && promoId > 0) {
        const found = this.promociones.find((p) => p.id === promoId);
        if (found) {
          this.abrirEditar(found, false);
        } else {
          this.adminService.getPromocion(promoId).subscribe({
            next: (res) => {
              if (res?.ok && res.promocion) {
                this.abrirEditar(res.promocion, false);
              }
            }
          });
        }
      }
      return;
    }

    if (url.includes('/admin/promociones/nuevo')) {
      this.abrirNuevaPromocion(false);
      return;
    }

    this.mostrarFormulario = false;
    this.editandoId = null;
  }

  private nuevoForm(): PromocionesComponent['form'] {
    const inicio = this.fechaLocalISO(new Date());
    const fin = inicio;
    return {
      nombre: '',
      descripcion: '',
      tipo_descuento: 'porcentaje',
      aplica_en: 'ambos',
      valor_descuento: 10,
      codigo: '',
      fecha_inicio: inicio,
      fecha_fin: fin,
      solo_clientes_nuevos: false,
      requiere_compra_minima: false,
      monto_compra_minima: null,
      limite_usos: null,
      activa: true
    };
  }

  private fechaLocalISO(d: Date): string {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  private tabDesdeEstado(estado: PromocionAdmin['estado']): Exclude<TabPromocion, 'codigos'> {
    if (estado === 'programada') return 'activas';
    if (estado === 'finalizada') return 'finalizadas';
    if (estado === 'pausada') return 'pausadas';
    return 'activas';
  }

  private estadoApiActual(): 'activas' | 'programadas' | 'finalizadas' | 'pausadas' | 'todas' {
    if (this.tabActiva === 'codigos') return 'todas';
    return this.tabActiva;
  }

  seleccionarTab(tab: TabPromocion): void {
    if (this.tabActiva === tab) return;
    this.tabActiva = tab;
    this.cargarPromociones();
  }

  cargarPromociones(): void {
    this.loading = true;
    this.adminService.getPromociones(this.estadoApiActual()).subscribe({
      next: (res) => {
        this.loading = false;
        if (!res?.ok) {
          this.modalService.showError(res?.error || 'No se pudieron cargar las promociones');
          return;
        }
        this.promociones = Array.isArray(res.promociones) ? res.promociones : [];
        this.estadisticas = res.estadisticas || this.estadisticas;
      },
      error: (err) => {
        this.loading = false;
        this.modalService.showError(err?.error?.error || 'Error al cargar promociones');
      }
    });
  }

  get promocionesTarjetas(): PromocionAdmin[] {
    return this.promociones.filter((p) => !!p && p.estado !== 'finalizada' ? true : this.tabActiva === 'finalizadas');
  }

  get codigosPromocion(): PromocionAdmin[] {
    return this.promociones.filter((p) => !!(p.codigo || '').trim());
  }

  abrirNuevaPromocion(navegar = true): void {
    this.editandoId = null;
    this.form = this.nuevoForm();
    this.mostrarFormulario = true;
    if (navegar) {
      this.router.navigate(['/admin/promociones/nuevo']);
    }
  }

  abrirEditar(promocion: PromocionAdmin, navegar = true): void {
    this.editandoId = promocion.id;
    this.form = {
      nombre: promocion.nombre,
      descripcion: promocion.descripcion || '',
      tipo_descuento: promocion.tipo_descuento,
      aplica_en: promocion.aplica_en,
      valor_descuento: Number(promocion.valor_descuento || 0),
      codigo: promocion.codigo || '',
      fecha_inicio: promocion.fecha_inicio,
      fecha_fin: promocion.fecha_fin,
      solo_clientes_nuevos: !!promocion.solo_clientes_nuevos,
      requiere_compra_minima: !!promocion.requiere_compra_minima,
      monto_compra_minima: promocion.monto_compra_minima,
      limite_usos: promocion.limite_usos,
      activa: !!promocion.activa
    };
    this.mostrarFormulario = true;
    if (navegar) {
      this.router.navigate(['/admin/promociones/editar', promocion.id]);
    }
  }

  cerrarFormulario(): void {
    if (this.guardando) return;
    this.mostrarFormulario = false;
    this.editandoId = null;
    this.router.navigate(['/admin/promociones']);
  }

  onTipoDescuentoChange(): void {
    if (this.form.tipo_descuento === '2x1' || this.form.tipo_descuento === 'producto_gratis') {
      this.form.valor_descuento = 0;
    } else if (this.form.valor_descuento <= 0) {
      this.form.valor_descuento = this.form.tipo_descuento === 'porcentaje' ? 10 : 50;
    }
  }

  get requiereValorDescuento(): boolean {
    return this.form.tipo_descuento === 'porcentaje' || this.form.tipo_descuento === 'monto_fijo';
  }

  private payloadDesdeForm(): Partial<PromocionAdmin> {
    return {
      nombre: this.form.nombre.trim(),
      descripcion: this.form.descripcion.trim(),
      tipo_descuento: this.form.tipo_descuento,
      aplica_en: this.form.aplica_en,
      valor_descuento: Number(this.form.valor_descuento || 0),
      codigo: (this.form.codigo || '').trim().toUpperCase(),
      fecha_inicio: this.form.fecha_inicio,
      fecha_fin: this.form.fecha_fin,
      solo_clientes_nuevos: !!this.form.solo_clientes_nuevos,
      requiere_compra_minima: !!this.form.requiere_compra_minima,
      monto_compra_minima: this.form.requiere_compra_minima ? Number(this.form.monto_compra_minima || 0) : null,
      limite_usos: this.form.limite_usos ?? null,
      activa: !!this.form.activa
    };
  }

  guardarPromocion(): void {
    const payload = this.payloadDesdeForm();
    if (!payload.nombre || payload.nombre.length < 3) {
      this.modalService.showError('El nombre debe tener al menos 3 caracteres.');
      return;
    }
    if (!payload.fecha_inicio || !payload.fecha_fin) {
      this.modalService.showError('Selecciona fecha de inicio y fin.');
      return;
    }
    if (payload.fecha_fin < payload.fecha_inicio) {
      this.modalService.showError('La fecha de fin no puede ser menor que la de inicio.');
      return;
    }
    if (payload.tipo_descuento === 'porcentaje' && ((payload.valor_descuento || 0) <= 0 || (payload.valor_descuento || 0) > 100)) {
      this.modalService.showError('Para porcentaje el valor debe estar entre 0.01 y 100.');
      return;
    }
    if (payload.requiere_compra_minima && (payload.monto_compra_minima || 0) <= 0) {
      this.modalService.showError('El monto mínimo debe ser mayor a 0.');
      return;
    }

    this.guardando = true;
    const req$ = this.editandoId
      ? this.adminService.actualizarPromocion(this.editandoId, payload)
      : this.adminService.crearPromocion(payload);

    req$.subscribe({
      next: (res) => {
        this.guardando = false;
        if (!res?.ok) {
          this.modalService.showError(res?.error || 'No se pudo guardar la promoción');
          return;
        }
        const promoResp = res?.promocion as PromocionAdmin | undefined;
        if (!this.editandoId && promoResp?.estado) {
          this.tabActiva = this.tabDesdeEstado(promoResp.estado);
        }
        this.modalService.showSuccess(this.editandoId ? 'Promoción actualizada' : 'Promoción creada correctamente');
        this.mostrarFormulario = false;
        this.router.navigate(['/admin/promociones']);
        this.cargarPromociones();
      },
      error: (err) => {
        this.guardando = false;
        this.modalService.showError(err?.error?.error || 'Error al guardar la promoción');
      }
    });
  }

  cambiarEstado(promocion: PromocionAdmin, activa: boolean): void {
    const accion = activa ? 'activar' : 'pausar';
    if (!confirm(`¿Deseas ${accion} la promoción "${promocion.nombre}"?`)) return;
    this.adminService.actualizarPromocion(promocion.id, { activa }).subscribe({
      next: (res) => {
        if (!res?.ok) {
          this.modalService.showError(res?.error || 'No se pudo actualizar el estado');
          return;
        }
        this.modalService.showSuccess(`Promoción ${activa ? 'activada' : 'pausada'} correctamente`);
        this.cargarPromociones();
      },
      error: (err) => {
        this.modalService.showError(err?.error?.error || 'Error al actualizar el estado');
      }
    });
  }

  eliminar(promocion: PromocionAdmin): void {
    if (!confirm(`¿Eliminar permanentemente la promoción "${promocion.nombre}"?`)) return;
    this.adminService.eliminarPromocion(promocion.id).subscribe({
      next: (res) => {
        if (!res?.ok) {
          this.modalService.showError(res?.error || 'No se pudo eliminar');
          return;
        }
        this.modalService.showSuccess('Promoción eliminada');
        this.cargarPromociones();
      },
      error: (err) => {
        this.modalService.showError(err?.error?.error || 'Error al eliminar la promoción');
      }
    });
  }

  duplicar(promocion: PromocionAdmin): void {
    const baseNombre = (promocion.nombre || '').trim();
    const payload: Partial<PromocionAdmin> = {
      nombre: `${baseNombre} (Copia)`,
      descripcion: promocion.descripcion || '',
      tipo_descuento: promocion.tipo_descuento,
      aplica_en: promocion.aplica_en,
      valor_descuento: promocion.valor_descuento,
      codigo: '',
      fecha_inicio: promocion.fecha_inicio,
      fecha_fin: promocion.fecha_fin,
      solo_clientes_nuevos: promocion.solo_clientes_nuevos,
      requiere_compra_minima: promocion.requiere_compra_minima,
      monto_compra_minima: promocion.monto_compra_minima,
      limite_usos: promocion.limite_usos,
      activa: false
    };
    this.adminService.crearPromocion(payload).subscribe({
      next: (res) => {
        if (!res?.ok) {
          this.modalService.showError(res?.error || 'No se pudo duplicar la promoción');
          return;
        }
        this.modalService.showSuccess('Promoción duplicada');
        this.cargarPromociones();
      },
      error: (err) => {
        this.modalService.showError(err?.error?.error || 'Error al duplicar la promoción');
      }
    });
  }

  etiquetaEstado(promocion: PromocionAdmin): string {
    if (promocion.estado === 'activa') return 'Activa';
    if (promocion.estado === 'programada') return 'Programada';
    if (promocion.estado === 'finalizada') return 'Finalizada';
    return 'Pausada';
  }

  claseEstado(promocion: PromocionAdmin): string {
    if (promocion.estado === 'activa') return 'badge badge-success';
    if (promocion.estado === 'programada') return 'badge badge-warning';
    if (promocion.estado === 'finalizada') return 'badge badge-error';
    return 'badge';
  }
}
