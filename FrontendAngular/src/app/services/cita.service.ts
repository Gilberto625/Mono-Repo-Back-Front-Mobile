import { Injectable, signal, computed, inject } from '@angular/core';
import { Cita, Barbero, HorarioDisponible, Usuario, TipoDemanda } from '../models';
import { AdminService, HorarioDiaConfig } from './admin.service';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class CitaService {
  private adminService = inject(AdminService);
  private http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  listarMisCitas<T>(): Observable<{ ok: boolean; citas: T[] }> {
    return this.http.get<{ ok: boolean; citas: T[] }>(`${this.apiUrl}/mis-citas/`, { withCredentials: true });
  }

  obtenerDashboardCliente<T>(): Observable<{ ok: boolean; stats: T }> {
    return this.http.get<{ ok: boolean; stats: T }>(`${this.apiUrl}/dashboard-stats/`, { withCredentials: true });
  }

  /** Horarios de atención por día (0=Lunes .. 6=Domingo). Si no está cargado, se usa 09:00-20:00 y todos los días abiertos. */
  private horariosAtencion = signal<HorarioDiaConfig[] | null>(null);

  setHorariosAtencion(horarios: HorarioDiaConfig[] | null): void {
    this.horariosAtencion.set(horarios && horarios.length >= 7 ? horarios : null);
  }

  /** Índice 0=Lunes .. 6=Domingo a partir de Date.getDay() (0=Dom, 1=Lun, ...). */
  private diaSemanaIndex(fecha: Date): number {
    const d = fecha.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    return d === 0 ? 6 : d - 1;
  }

  /** True si el negocio está abierto ese día según horarios de atención. */
  negocioAbiertoEnFecha(fecha: Date): boolean {
    const horarios = this.horariosAtencion();
    if (!horarios) return true;
    const idx = this.diaSemanaIndex(fecha);
    return !!horarios[idx]?.abierto;
  }

  /** Parsea "09:00" o "09:00:00" a hora numérica (0-23). */
  private parseHora(str: string | undefined): number {
    if (!str || typeof str !== 'string') return 9;
    const parts = str.trim().substring(0, 5).split(':');
    const h = parseInt(parts[0], 10);
    return isNaN(h) ? 9 : Math.max(0, Math.min(23, h));
  }

  // Barberos (se cargan desde API con dias_libres; fallback mock)
  private barberosData = signal<Barbero[]>([
    {
      id: '1',
      usuario: {
        id: 'u1',
        email: 'carlos@stylobarber.com',
        nombre: 'Carlos',
        apellidos: 'Martínez',
        telefono: '5512345678',
        rol: 'barbero',
        fechaRegistro: new Date(),
        activo: true
      },
      especialidades: ['Degradados', 'Diseños'],
      tiemposServicio: [],
      activo: true,
      calificacion: 4.8
    },
    {
      id: '2',
      usuario: {
        id: 'u2',
        email: 'miguel@stylobarber.com',
        nombre: 'Miguel',
        apellidos: 'Rodríguez',
        telefono: '5512345679',
        rol: 'barbero',
        fechaRegistro: new Date(),
        activo: true
      },
      especialidades: ['Corte Clásico', 'Barba'],
      tiemposServicio: [],
      activo: true,
      calificacion: 4.6
    },
    {
      id: '3',
      usuario: {
        id: 'u3',
        email: 'jose@stylobarber.com',
        nombre: 'José',
        apellidos: 'López',
        telefono: '5512345680',
        rol: 'barbero',
        fechaRegistro: new Date(),
        activo: true
      },
      especialidades: ['Tratamientos', 'Color'],
      tiemposServicio: [],
      activo: true,
      calificacion: 4.9
    }
  ]);

  // Citas mock
  private citasData = signal<Cita[]>([
    {
      id: '1',
      clienteId: 'c1',
      barberoId: '1',
      servicioId: '3',
      fecha: new Date(),
      hora: '10:00',
      duracionMinutos: 45,
      estado: 'confirmada',
      estadoPago: 'parcial',
      precioTotal: 250,
      anticipo: 75,
      anticipoPagado: true,
      fechaCreacion: new Date()
    },
    {
      id: '2',
      clienteId: 'c1',
      barberoId: '2',
      servicioId: '2',
      fecha: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000),
      hora: '15:30',
      duracionMinutos: 35,
      estado: 'pendiente',
      estadoPago: 'pendiente',
      precioTotal: 180,
      anticipo: 54,
      anticipoPagado: false,
      fechaCreacion: new Date()
    }
  ]);

  // Configuración de demanda por día
  private demandaDias = signal<Map<number, TipoDemanda>>(new Map([
    [0, 'alta'],  // Domingo
    [1, 'baja'],  // Lunes
    [2, 'baja'],  // Martes
    [3, 'media'], // Miércoles
    [4, 'media'], // Jueves
    [5, 'alta'],  // Viernes
    [6, 'alta']   // Sábado
  ]));

  barberos = computed(() => this.barberosData().filter(b => b.activo));
  citas = computed(() => this.citasData());

  citasDelDia = computed(() => {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    return this.citasData().filter(c => {
      const fechaCita = new Date(c.fecha);
      fechaCita.setHours(0, 0, 0, 0);
      return fechaCita.getTime() === hoy.getTime();
    });
  });

  citasProximas = computed(() => {
    const ahora = new Date();
    return this.citasData()
      .filter(c => new Date(c.fecha) >= ahora && c.estado !== 'cancelada')
      .sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());
  });

  getBarberoById(id: string): Barbero | undefined {
    return this.barberosData().find(b => b.id === id);
  }

  /** Carga barberos desde la API (endpoint público; incluye dias_libres para bloquear agendar en esos días) */
  loadBarberosFromApi(): void {
    this.adminService.getBarberosParaAgendar().subscribe({
      next: (res) => {
        const lista = res?.barberos ?? [];
        if (res?.ok && Array.isArray(lista) && lista.length > 0) {
          const barberos: Barbero[] = lista
            .filter((e: { activo?: boolean }) => e.activo !== false)
            .map((e: { id: number; email: string; nombre: string; apellido: string; telefono?: string; especialidades?: string; activo?: boolean; dias_libres?: string; periodos_vacaciones?: string }) => ({
              id: String(e.id),
              usuario: {
                id: String(e.id),
                email: e.email,
                nombre: e.nombre || '',
                apellidos: e.apellido || '',
                telefono: e.telefono || '',
                rol: 'barbero',
                fechaRegistro: new Date(),
                activo: e.activo !== false
              },
              especialidades: this.parseEspecialidades(e.especialidades),
              tiemposServicio: [],
              activo: e.activo !== false,
              calificacion: 4.5,
              dias_libres: e.dias_libres || '',
              periodos_vacaciones: e.periodos_vacaciones || ''
            }));
          this.barberosData.set(barberos);
        }
      },
      error: () => { /* mantener barberos mock si falla la API */ }
    });
  }

  private parseEspecialidades(esp: string | undefined): string[] {
    if (!esp) return [];
    try {
      const arr = typeof esp === 'string' && esp.startsWith('[') ? JSON.parse(esp) : esp.split(',').map((s: string) => s.trim()).filter(Boolean);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** True si el barbero tiene ese día como día libre (no se puede agendar) */
  barberoTieneDiaLibre(barberoId: string, fecha: Date): boolean {
    const barbero = this.getBarberoById(barberoId);
    if (!barbero?.dias_libres) return false;
    try {
      const lista = JSON.parse(barbero.dias_libres);
      if (!Array.isArray(lista)) return false;
      const ymd = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
      return lista.some((item: { fecha?: string }) => {
        const f = item.fecha;
        if (!f) return false;
        const itemYmd = f.slice(0, 10);
        return itemYmd === ymd;
      });
    } catch {
      return false;
    }
  }

  /** True si el barbero tiene vacaciones aprobadas en esa fecha (no se puede agendar) */
  barberoEnVacacionesAprobadas(barberoId: string, fecha: Date): boolean {
    const barbero = this.getBarberoById(barberoId);
    if (!barbero?.periodos_vacaciones) return false;
    try {
      const lista = JSON.parse(barbero.periodos_vacaciones);
      if (!Array.isArray(lista)) return false;
      const ymd = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
      return lista.some((item: { fecha_inicio?: string; fecha_fin?: string; estado?: string }) => {
        if (item.estado !== 'aprobado') return false;
        const inicio = item.fecha_inicio?.slice(0, 10) || '';
        const fin = item.fecha_fin?.slice(0, 10) || '';
        return inicio && fin && ymd >= inicio && ymd <= fin;
      });
    } catch {
      return false;
    }
  }

  /** True si el barbero no está disponible ese día (día libre o vacaciones aprobadas) */
  barberoNoDisponibleEnFecha(barberoId: string, fecha: Date): boolean {
    return this.barberoTieneDiaLibre(barberoId, fecha) || this.barberoEnVacacionesAprobadas(barberoId, fecha);
  }

  getCitaById(id: string): Cita | undefined {
    return this.citasData().find(c => c.id === id);
  }

  getCitasCliente(clienteId: string): Cita[] {
    return this.citasData().filter(c => c.clienteId === clienteId);
  }

  getCitasBarbero(barberoId: string): Cita[] {
    return this.citasData().filter(c => c.barberoId === barberoId);
  }

  getDemandaDia(fecha: Date): TipoDemanda {
    return this.demandaDias().get(fecha.getDay()) || 'media';
  }

  // Genera horarios disponibles para una fecha y barbero (respeta horarios de atención del negocio)
  getHorariosDisponibles(fecha: Date, barberoId?: string): HorarioDisponible[] {
    const horarios: HorarioDisponible[] = [];
    const horariosDia = this.horariosAtencion();
    const idx = this.diaSemanaIndex(fecha);

    let horaInicio = 9;
    let horaFin = 20;
    if (horariosDia && horariosDia[idx]) {
      if (!horariosDia[idx].abierto) return [];
      horaInicio = this.parseHora(horariosDia[idx].apertura);
      horaFin = this.parseHora(horariosDia[idx].cierre);
      if (horaFin <= horaInicio) horaFin = horaInicio + 1;
    }

    // Si el barbero tiene día libre o vacaciones aprobadas ese día, no hay horarios disponibles
    if (barberoId && this.barberoNoDisponibleEnFecha(barberoId, fecha)) {
      for (let hora = horaInicio; hora < horaFin; hora++) {
        for (const minutos of [0, 30]) {
          horarios.push({
            fecha,
            hora: `${hora.toString().padStart(2, '0')}:${minutos.toString().padStart(2, '0')}`,
            disponible: false,
            barberoId
          });
        }
      }
      return horarios;
    }

    for (let hora = horaInicio; hora < horaFin; hora++) {
      for (const minutos of [0, 30]) {
        const horaStr = `${hora.toString().padStart(2, '0')}:${minutos.toString().padStart(2, '0')}`;
        
        // Verificar si hay cita en ese horario
        const ocupado = this.citasData().some(c => {
          const fechaCita = new Date(c.fecha);
          fechaCita.setHours(0, 0, 0, 0);
          const fechaConsulta = new Date(fecha);
          fechaConsulta.setHours(0, 0, 0, 0);
          
          return fechaCita.getTime() === fechaConsulta.getTime() &&
            c.hora === horaStr &&
            (!barberoId || c.barberoId === barberoId) &&
            c.estado !== 'cancelada';
        });

        horarios.push({
          fecha,
          hora: horaStr,
          disponible: !ocupado,
          barberoId
        });
      }
    }
    
    return horarios;
  }

  // Crear nueva cita
  crearCita(cita: Omit<Cita, 'id' | 'fechaCreacion'>): Cita {
    const nuevaCita: Cita = {
      ...cita,
      id: Date.now().toString(),
      fechaCreacion: new Date()
    };
    this.citasData.update(citas => [...citas, nuevaCita]);
    return nuevaCita;
  }

  // Actualizar cita
  actualizarCita(id: string, datos: Partial<Cita>): void {
    this.citasData.update(citas =>
      citas.map(c => c.id === id ? { ...c, ...datos, fechaModificacion: new Date() } : c)
    );
  }

  // Cancelar cita
  cancelarCita(id: string): void {
    this.actualizarCita(id, { estado: 'cancelada' });
  }

  // Confirmar asistencia
  confirmarAsistencia(id: string): void {
    this.actualizarCita(id, { estado: 'en_curso' });
  }

  // Completar cita
  completarCita(id: string): void {
    this.actualizarCita(id, { estado: 'completada', estadoPago: 'completado' });
  }

  // Marcar inasistencia
  marcarInasistencia(id: string): void {
    this.actualizarCita(id, { estado: 'no_asistio' });
  }

  // Verificar si cliente requiere anticipo
  clienteRequiereAnticipo(clienteId: string): boolean {
    const citasCliente = this.getCitasCliente(clienteId);
    const inasistencias = citasCliente.filter(c => c.estado === 'no_asistio').length;
    
    // Si es primera cita, no requiere
    if (citasCliente.length === 0) return false;
    
    // Si tiene inasistencias recientes
    if (inasistencias > 0) {
      const citasRecientes = citasCliente.slice(-10);
      const inasistenciasRecientes = citasRecientes.filter(c => c.estado === 'no_asistio').length;
      return inasistenciasRecientes > 0;
    }
    
    return false;
  }

  // Calcular anticipo
  calcularAnticipo(precioTotal: number, porcentaje: number = 30): number {
    return Math.ceil(precioTotal * (porcentaje / 100));
  }
}
