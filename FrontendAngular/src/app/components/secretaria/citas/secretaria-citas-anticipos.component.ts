import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';

interface CitaAnticipo {
  id: number;
  cliente_nombre: string;
  cliente_email: string;
  cliente_telefono?: string;
  servicio_nombre: string;
  fecha: string;
  hora: string;
  estado: string;
  precio_total: number;
  anticipo_pagado: number;
  comprobante_pago: string;
  anticipo_validado: boolean;
  fecha_creacion: string;
  fecha_modificacion?: string;
}

@Component({
  selector: 'app-secretaria-citas-anticipos',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './secretaria-citas-anticipos.component.html',
  styleUrl: './secretaria-citas-anticipos.component.css'
})
export class SecretariaCitasAnticiposComponent implements OnInit {
  private http = inject(HttpClient);
  private router = inject(Router);

  citas = signal<CitaAnticipo[]>([]);
  cargando = signal(true);
  error = signal('');
  filtro = signal<'pendientes' | 'validados' | 'cancelados' | 'todos'>('pendientes');
  menuAbiertoId = signal<number | null>(null);
  paginaActual = signal(1);
  tamanoPagina = signal(10);

  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  ngOnInit(): void {
    this.cargarCitas();
  }

  cargarCitas(): void {
    this.cargando.set(true);
    this.error.set('');
    // Cargar transferencias de citas desde endpoint real de secretaría
    this.http.get<any>(`${this.apiUrl}/secretaria/citas/`).subscribe({
      next: (res) => {
        if (res?.ok) {
          // Filtrar solo las que tienen anticipo
          const conAnticipo = (res.citas || []).filter((c: CitaAnticipo) => c.anticipo_pagado > 0);
          this.citas.set(conAnticipo);
        }
        this.cargando.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error || 'No se pudieron cargar las transferencias de citas.');
        this.cargando.set(false);
      }
    });
  }

  get citasFiltradas(): CitaAnticipo[] {
    const todas = this.citas();
    const f = this.filtro();
    if (f === 'pendientes') {
      return todas
        .filter(c => !c.anticipo_validado && !!c.comprobante_pago && c.estado !== 'cancelada')
        .sort((a, b) => this.getTimestamp(b) - this.getTimestamp(a));
    }
    if (f === 'validados') {
      // Ultimo validado arriba (normalmente reflejado por fecha_modificacion).
      return todas
        .filter(c => c.anticipo_validado)
        .sort((a, b) => this.getTimestamp(b) - this.getTimestamp(a));
    }
    if (f === 'cancelados') {
      return todas
        .filter(c => c.estado === 'cancelada')
        .sort((a, b) => this.getTimestamp(b) - this.getTimestamp(a));
    }
    return [...todas].sort((a, b) => this.getTimestamp(b) - this.getTimestamp(a));
  }

  get totalPaginas(): number {
    return Math.max(1, Math.ceil(this.citasFiltradas.length / this.tamanoPagina()));
  }

  get citasPaginaActual(): CitaAnticipo[] {
    const inicio = (this.paginaActual() - 1) * this.tamanoPagina();
    const fin = inicio + this.tamanoPagina();
    return this.citasFiltradas.slice(inicio, fin);
  }

  get paginasDisponibles(): number[] {
    return Array.from({ length: this.totalPaginas }, (_, i) => i + 1);
  }

  setFiltro(filtro: 'pendientes' | 'validados' | 'cancelados' | 'todos'): void {
    this.filtro.set(filtro);
    this.paginaActual.set(1);
  }

  setTamanoPagina(value: number): void {
    this.tamanoPagina.set(value);
    this.paginaActual.set(1);
  }

  irPaginaAnterior(): void {
    if (this.paginaActual() > 1) this.paginaActual.update(v => v - 1);
  }

  irPaginaSiguiente(): void {
    if (this.paginaActual() < this.totalPaginas) this.paginaActual.update(v => v + 1);
  }

  irAPagina(pagina: number): void {
    if (pagina < 1 || pagina > this.totalPaginas) return;
    this.paginaActual.set(pagina);
  }

  getEstadoClass(estado: string): string {
    const map: Record<string, string> = {
      'pendiente': 'badge-warning',
      'confirmada': 'badge-success',
      'en_curso': 'badge-primary',
      'completada': 'badge-success',
      'cancelada': 'badge-error',
      'no_asistio': 'badge-error',
    };
    return map[estado] || 'badge-secondary';
  }

  getEstadoLabel(estado: string): string {
    const map: Record<string, string> = {
      'pendiente': 'Pendiente',
      'confirmada': 'Confirmada',
      'en_curso': 'En curso',
      'completada': 'Completada',
      'cancelada': 'Cancelada',
      'no_asistio': 'No asistió',
    };
    return map[estado] || estado;
  }

  formatearFecha(fecha: string): string {
    const d = new Date(fecha + 'T00:00:00');
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  private getTimestamp(cita: CitaAnticipo): number {
    const source = cita.fecha_modificacion || cita.fecha_creacion || '';
    const dt = source ? new Date(source) : new Date(`${cita.fecha}T${cita.hora || '00:00:00'}`);
    const time = dt.getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  getIniciales(nombre: string): string {
    if (!nombre) return '??';
    return nombre.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  }

  irADetalle(citaId: number): void {
    this.router.navigate(['/secretaria/transferencias', citaId]);
  }

  toggleMenu(citaId: number, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.menuAbiertoId.update(current => current === citaId ? null : citaId);
  }

  private normalizarTelefonoWhatsapp(raw: string): string {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `52${digits}`;
    return digits;
  }

  puedeContactarWhatsApp(cita: CitaAnticipo): boolean {
    return !!this.normalizarTelefonoWhatsapp(cita.cliente_telefono || '');
  }

  contactarPorWhatsApp(cita: CitaAnticipo, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.menuAbiertoId.set(null);
    const phone = this.normalizarTelefonoWhatsapp(cita.cliente_telefono || '');
    if (!phone) return;
    const texto = [
      `Hola ${cita.cliente_nombre}, te escribimos de secretaría de la barbería.`,
      `Sobre tu cita #${cita.id} (${cita.servicio_nombre}) del ${this.formatearFecha(cita.fecha)} a las ${cita.hora}.`,
      'Estamos validando tu transferencia.'
    ].join(' ');
    const chatUrl = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(texto)}`;
    window.open(chatUrl, '_blank', 'noopener,noreferrer');
  }
}
