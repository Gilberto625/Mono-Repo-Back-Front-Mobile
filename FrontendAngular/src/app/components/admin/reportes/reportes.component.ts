import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService } from '../../../services/admin.service';

type AlertaNivel = 'alta' | 'media' | 'baja' | 'info';
interface AlertaInteligente {
  nivel: AlertaNivel;
  titulo: string;
  mensaje: string;
  tipoReporte: string;
  accionLabel?: string;
}

@Component({
  selector: 'app-reportes',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './reportes.component.html',
  styleUrl: './reportes.component.css'
})
export class ReportesComponent implements OnInit {
  private adminService = inject(AdminService);

  periodos: { valor: string; etiqueta: string }[] = [];
  periodoSeleccionado = '';
  datosReportes: { resumen?: Record<string, number>; periodo?: Record<string, string>; citas_por_estado?: Record<string, number> } | null = null;
  loading = true;

  /** Ventas y variaciones desde API */
  ventasDiaTotal = 0;
  ventasSemanaTotal = 0;
  ventasMesTotal = 0;
  ventasDiaVariacion = 0;
  ventasSemanaVariacion = 0;
  ventasMesVariacion = 0;

  ngOnInit(): void {
    this.generarPeriodos();
    this.cargarDatos();
  }

  get periodoEtiquetaActual(): string {
    return this.periodos.find(p => p.valor === this.periodoSeleccionado)?.etiqueta || 'Mes actual';
  }

  private getRangoMesSeleccionado(): { desde: string; hasta: string } | null {
    if (!this.periodoSeleccionado || !/^\d{4}-\d{2}$/.test(this.periodoSeleccionado)) return null;
    const [yStr, mStr] = this.periodoSeleccionado.split('-');
    const year = Number(yStr);
    const month = Number(mStr);
    if (!year || !month || month < 1 || month > 12) return null;
    const inicio = new Date(year, month - 1, 1);
    const fin = new Date(year, month, 0);
    const toISO = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { desde: toISO(inicio), hasta: toISO(fin) };
  }

  /**
   * Aplica el mes seleccionado a reportes que se consumen por rango.
   * Para ventas día/semana mantenemos el comportamiento actual.
   */
  queryParamsPorTipo(tipo: string): Record<string, string> {
    const base: Record<string, string> = { tipo };
    const tiposConMes = new Set([
      'ventas-mes',
      'servicios-populares',
      'citas',
      'horarios',
      'productos-vendidos',
      'inventario'
    ]);
    if (!tiposConMes.has(tipo)) return base;
    const rango = this.getRangoMesSeleccionado();
    if (!rango) return base;
    return { ...base, desde: rango.desde, hasta: rango.hasta };
  }

  private generarPeriodos(): void {
    const ahora = new Date();
    this.periodos = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
      const mes = d.toLocaleString('es', { month: 'long' });
      const etiqueta = mes.charAt(0).toUpperCase() + mes.slice(1) + ' ' + d.getFullYear();
      const valor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      this.periodos.push({ valor, etiqueta });
    }
    this.periodoSeleccionado = this.periodos[0]?.valor ?? '';
  }

  cargarDatos(): void {
    this.loading = true;
    const rango = this.getRangoMesSeleccionado();
    this.adminService.getReportes(undefined, undefined, rango?.desde, rango?.hasta).subscribe({
      next: (res) => {
        this.loading = false;
        if (res?.ok) {
          this.datosReportes = { resumen: res.resumen, periodo: res.periodo, citas_por_estado: res.citas_por_estado };
          this.ventasDiaTotal = Number(res.ventas_dia) || 0;
          this.ventasSemanaTotal = Number(res.ventas_semana) || 0;
          this.ventasMesTotal = Number(res.ventas_mes) || 0;
          this.ventasDiaVariacion = Number(res.ventas_dia_variacion) ?? 0;
          this.ventasSemanaVariacion = Number(res.ventas_semana_variacion) ?? 0;
          this.ventasMesVariacion = Number(res.ventas_mes_variacion) ?? 0;
        }
      },
      error: () => {
        this.loading = false;
      }
    });
  }

  /** Formatear monto para mostrar */
  formatMonto(value: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
  }

  /** Clase para el % de variación: verde si >= 0, rojo si < 0 */
  getVariacionClase(porcentaje: number): string {
    return porcentaje >= 0 ? 'text-success' : 'text-error';
  }

  /** Total de citas (todas) desde API para tarjeta Reporte de Citas */
  get totalCitas(): number {
    const cp = this.datosReportes?.citas_por_estado;
    if (!cp || typeof cp !== 'object') return 0;
    return Object.values(cp).reduce((a, b) => a + Number(b), 0);
  }

  /** Tasa de asistencia % (completadas / (completadas+no_asistio+canceladas)) para tarjeta Reporte de Citas */
  get tasaAsistencia(): number {
    const cp = this.datosReportes?.citas_por_estado;
    if (!cp || typeof cp !== 'object') return 0;
    const completadas = Number(cp['completada'] ?? 0);
    const noAsistio = Number(cp['no_asistio'] ?? 0);
    const canceladas = Number(cp['cancelada'] ?? 0);
    const atendidas = completadas + noAsistio + canceladas;
    return atendidas > 0 ? Math.round((completadas / atendidas) * 100) : 0;
  }

  get alertasInteligentes(): AlertaInteligente[] {
    const alertas: AlertaInteligente[] = [];
    const stockBajo = Number(this.datosReportes?.resumen?.['productos_stock_bajo'] ?? 0);

    if (this.ventasDiaVariacion <= -20) {
      alertas.push({
        nivel: 'alta',
        titulo: 'Caída fuerte hoy',
        mensaje: `Las ventas del día cayeron ${Math.abs(this.ventasDiaVariacion)}% vs ayer. Revisa agenda y promociones rápidas.`,
        tipoReporte: 'ventas-dia',
        accionLabel: 'Ir a ventas del día'
      });
    } else if (this.ventasDiaVariacion < 0) {
      alertas.push({
        nivel: 'media',
        titulo: 'Baja diaria detectada',
        mensaje: `Ventas del día en ${this.ventasDiaVariacion}% vs ayer. Ajusta seguimiento de clientes frecuentes.`,
        tipoReporte: 'ventas-dia',
        accionLabel: 'Ver detalle diario'
      });
    }

    if (this.ventasSemanaVariacion < 0) {
      alertas.push({
        nivel: 'media',
        titulo: 'Tendencia semanal a la baja',
        mensaje: `${this.ventasSemanaVariacion}% vs semana pasada. Conviene revisar horarios pico y servicios más rentables.`,
        tipoReporte: 'ventas-semana',
        accionLabel: 'Ir a ventas semanales'
      });
    }

    if (stockBajo > 0) {
      alertas.push({
        nivel: stockBajo >= 5 ? 'alta' : 'media',
        titulo: 'Productos con stock bajo',
        mensaje: `${stockBajo} producto(s) están cerca de agotarse. Prioriza reabasto para evitar pérdida de venta.`,
        tipoReporte: 'inventario',
        accionLabel: 'Ir a inventario'
      });
    }

    if (this.totalCitas > 0 && this.tasaAsistencia < 70) {
      alertas.push({
        nivel: 'alta',
        titulo: 'Asistencia baja',
        mensaje: `La tasa de asistencia es ${this.tasaAsistencia}%. Refuerza confirmaciones y recordatorios de cita.`,
        tipoReporte: 'citas',
        accionLabel: 'Ir a reporte de citas'
      });
    } else if (this.totalCitas > 0 && this.tasaAsistencia < 85) {
      alertas.push({
        nivel: 'media',
        titulo: 'Asistencia mejorable',
        mensaje: `La tasa de asistencia es ${this.tasaAsistencia}%. Puedes mejorarla con recordatorios previos.`,
        tipoReporte: 'citas',
        accionLabel: 'Ver citas'
      });
    }

    if (!alertas.length && !this.loading) {
      alertas.push({
        nivel: 'info',
        titulo: 'Operación estable',
        mensaje: 'No se detectan riesgos críticos en este momento. Mantén el monitoreo diario.',
        tipoReporte: 'ventas-mes',
        accionLabel: 'Ver reporte mensual'
      });
    }

    return alertas.slice(0, 4);
  }

  claseAlerta(nivel: AlertaNivel): string {
    return `alerta-${nivel}`;
  }

  claseBotonAlerta(nivel: AlertaNivel): string {
    return `alerta-cta-${nivel}`;
  }
}
