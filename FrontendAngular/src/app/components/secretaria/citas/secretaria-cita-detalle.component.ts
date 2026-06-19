import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { environment } from '../../../../environments/environment';
import { apiEndpoint, secretariaAppointmentDetailPath, secretariaAppointmentUpdatePath } from '../../../core/api/api-endpoints';

interface CitaDetalle {
  id: number;
  cliente_id: number;
  cliente_nombre: string;
  cliente_email: string;
  cliente_telefono: string;
  barbero_nombre: string;
  servicio_nombre: string;
  servicio_imagen: string;
  servicio_precio: number;
  fecha: string;
  hora: string;
  duracion_minutos: number;
  estado: string;
  precio_total: number;
  anticipo_pagado: number;
  comprobante_pago: string;
  anticipo_validado: boolean;
  restante: number;
  notas: string;
  motivo_cancelacion: string;
  notas_cancelacion: string;
  fecha_creacion: string;
  fecha_modificacion: string;
}

@Component({
  selector: 'app-secretaria-cita-detalle',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './secretaria-cita-detalle.component.html',
  styleUrl: './secretaria-cita-detalle.component.css'
})
export class SecretariaCitaDetalleComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  cita = signal<CitaDetalle | null>(null);
  cargando = signal(true);
  error = signal('');
  actualizando = signal(false);
  mensajeExito = signal('');
  mostrarComprobante = signal(false);

  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.cargarCita(+id);
    } else {
      this.error.set('ID de cita no válido');
      this.cargando.set(false);
    }
  }

  cargarCita(id: number): void {
    this.cargando.set(true);
    this.http.get<any>(apiEndpoint(this.apiUrl, secretariaAppointmentDetailPath(id))).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.cita.set(res.cita);
        } else {
          this.error.set('No se pudo cargar la cita');
        }
        this.cargando.set(false);
      },
      error: () => {
        this.error.set('Error al cargar la cita');
        this.cargando.set(false);
      }
    });
  }

  validarAnticipo(): void {
    const c = this.cita();
    if (!c) return;
    this.actualizando.set(true);
    this.mensajeExito.set('');
    this.error.set('');

    this.http.put<any>(
      apiEndpoint(this.apiUrl, secretariaAppointmentUpdatePath(c.id)),
      { anticipo_validado: true, estado: 'confirmada' },
      {}
    ).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.mensajeExito.set('Anticipo validado correctamente');
          this.cita.set({
            ...c,
            anticipo_validado: true,
            estado: c.estado === 'pendiente' ? 'confirmada' : c.estado
          });
        }
        this.actualizando.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error || 'Error al validar el anticipo');
        this.actualizando.set(false);
      }
    });
  }

  rechazarAnticipo(): void {
    const c = this.cita();
    if (!c) return;

    const motivo = prompt(
      'Motivo del rechazo (opcional):\n\nAl rechazar el comprobante, la cita se cancelará automáticamente y el horario quedará libre para otros clientes.',
      'Comprobante de transferencia no válido'
    );

    if (motivo === null) return;

    this.actualizando.set(true);
    this.mensajeExito.set('');
    this.error.set('');

    this.http.put<any>(
      apiEndpoint(this.apiUrl, secretariaAppointmentUpdatePath(c.id)),
      {
        rechazar_comprobante: true,
        notas_cancelacion: motivo || 'Comprobante de pago rechazado'
      },
      {}
    ).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.mensajeExito.set(res.mensaje || 'Comprobante rechazado. La cita fue cancelada y el horario ha sido liberado.');
          this.cita.set({
            ...c,
            anticipo_validado: false,
            estado: 'cancelada',
            motivo_cancelacion: 'comprobante_invalido',
            notas_cancelacion: motivo || 'Comprobante de pago rechazado'
          });
        }
        this.actualizando.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error || 'Error al rechazar el comprobante');
        this.actualizando.set(false);
      }
    });
  }

  actualizarEstado(nuevoEstado: string): void {
    const c = this.cita();
    if (!c) return;

    if (nuevoEstado === 'cancelada') {
      if (!confirm('¿Cancelar esta cita? El horario quedará libre para otros clientes.')) return;
    }

    this.actualizando.set(true);
    this.mensajeExito.set('');
    this.error.set('');

    const body: any = { estado: nuevoEstado };
    if (nuevoEstado === 'cancelada') {
      body.motivo_cancelacion = 'secretaria_cancelo';
    }

    this.http.put<any>(
      apiEndpoint(this.apiUrl, secretariaAppointmentUpdatePath(c.id)),
      body,
      {}
    ).subscribe({
      next: (res) => {
        if (res?.ok) {
          let mensaje = res.mensaje;
          if (res.horario_liberado) {
            mensaje += ' El horario ha sido liberado.';
          }
          this.mensajeExito.set(mensaje);
          this.cita.set({
            ...c,
            estado: nuevoEstado,
            motivo_cancelacion: res.motivo_cancelacion || c.motivo_cancelacion
          });
        }
        this.actualizando.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error || 'Error al actualizar la cita');
        this.actualizando.set(false);
      }
    });
  }

  toggleComprobante(): void {
    this.mostrarComprobante.update(v => !v);
  }

  volver(): void {
    this.router.navigate(['/secretaria/transferencias']);
  }

  getEstadoLabel(estado: string): string {
    const map: Record<string, string> = {
      'pendiente': 'Pendiente', 'confirmada': 'Confirmada', 'en_curso': 'En curso',
      'completada': 'Completada', 'cancelada': 'Cancelada', 'no_asistio': 'No asistió',
    };
    return map[estado] || estado;
  }

  getEstadoClass(estado: string): string {
    const map: Record<string, string> = {
      'pendiente': 'badge-warning', 'confirmada': 'badge-success', 'en_curso': 'badge-primary',
      'completada': 'badge-success', 'cancelada': 'badge-error', 'no_asistio': 'badge-error',
    };
    return map[estado] || 'badge-secondary';
  }

  formatearFecha(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  formatearFechaHora(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  getIniciales(nombre: string): string {
    if (!nombre) return '??';
    return nombre.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  }

  getMotivoCancelacionLabel(motivo: string): string {
    const map: Record<string, string> = {
      'comprobante_invalido': 'Comprobante de pago rechazado',
      'secretaria_cancelo': 'Cancelada por secretaría',
      'cliente_cancelo': 'Cancelada por el cliente',
    };
    return map[motivo] || motivo || 'No especificado';
  }

  private normalizarTelefonoWhatsapp(raw: string): string {
    const digits = String(raw || '').replaceAll(/\D/g, '');
    if (!digits) return '';
    // Si viene local MX de 10 dígitos, anteponer lada país.
    if (digits.length === 10) return `52${digits}`;
    // Algunos teléfonos MX vienen como 521XXXXXXXXXX (el "1" no se usa en wa.me)
    if (digits.startsWith('521') && digits.length === 13) return `52${digits.slice(3)}`;
    return digits;
  }

  puedeContactarWhatsApp(): boolean {
    return !!this.normalizarTelefonoWhatsapp(this.cita()?.cliente_telefono || '');
  }

  contactarPorWhatsApp(): void {
    const c = this.cita();
    if (!c) return;
    const phone = this.normalizarTelefonoWhatsapp(c.cliente_telefono);
    if (!phone) {
      this.error.set('El cliente no tiene teléfono registrado para WhatsApp. Contacto manual por llamada.');
      return;
    }
    const texto = [
      `Hola ${c.cliente_nombre}, te escribimos de secretaría de la barbería.`,
      `Sobre tu cita #${c.id} (${c.servicio_nombre}) del ${this.formatearFecha(c.fecha)} a las ${c.hora}.`,
      'Estamos validando tu transferencia.'
    ].join(' ');
    const chatUrl = `https://wa.me/${encodeURIComponent(phone)}?text=${encodeURIComponent(texto)}`;
    window.open(chatUrl, '_blank', 'noopener,noreferrer');
  }
}
