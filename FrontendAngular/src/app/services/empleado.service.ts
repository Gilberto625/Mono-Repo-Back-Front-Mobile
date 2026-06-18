import { Injectable, signal, computed } from '@angular/core';
import { Usuario, RolUsuario, Barbero, TiempoServicio } from '../models';

@Injectable({
  providedIn: 'root'
})
export class EmpleadoService {
  
  private empleadosData = signal<Usuario[]>([
    {
      id: 'e1',
      email: 'admin@stylobarber.com',
      nombre: 'Administrador',
      apellidos: 'Principal',
      telefono: '5512340000',
      rol: 'admin',
      fechaRegistro: new Date('2023-01-01'),
      activo: true
    },
    {
      id: 'e2',
      email: 'secretaria@stylobarber.com',
      nombre: 'Sandra',
      apellidos: 'Mendoza',
      telefono: '5512340001',
      rol: 'secretaria',
      fechaRegistro: new Date('2023-06-15'),
      activo: true
    },
    {
      id: 'e3',
      email: 'carlos@stylobarber.com',
      nombre: 'Carlos',
      apellidos: 'Martínez',
      telefono: '5512345678',
      rol: 'barbero',
      fechaRegistro: new Date('2023-02-01'),
      activo: true
    },
    {
      id: 'e4',
      email: 'miguel@stylobarber.com',
      nombre: 'Miguel',
      apellidos: 'Rodríguez',
      telefono: '5512345679',
      rol: 'barbero',
      fechaRegistro: new Date('2023-03-15'),
      activo: true
    },
    {
      id: 'e5',
      email: 'jose@stylobarber.com',
      nombre: 'José',
      apellidos: 'López',
      telefono: '5512345680',
      rol: 'barbero',
      fechaRegistro: new Date('2023-04-01'),
      activo: true
    }
  ]);

  private barberosData = signal<Map<string, { especialidades: string[], calificacion: number }>>(new Map([
    ['e3', { especialidades: ['Degradados', 'Diseños'], calificacion: 4.8 }],
    ['e4', { especialidades: ['Corte Clásico', 'Barba'], calificacion: 4.6 }],
    ['e5', { especialidades: ['Tratamientos', 'Color'], calificacion: 4.9 }]
  ]));

  empleados = computed(() => this.empleadosData().filter(e => e.activo));
  
  barberos = computed(() => 
    this.empleadosData().filter(e => e.rol === 'barbero' && e.activo)
  );
  
  secretarias = computed(() => 
    this.empleadosData().filter(e => e.rol === 'secretaria' && e.activo)
  );

  getEmpleadoById(id: string): Usuario | undefined {
    return this.empleadosData().find(e => e.id === id);
  }

  getEmpleadosPorRol(rol: RolUsuario): Usuario[] {
    return this.empleadosData().filter(e => e.rol === rol && e.activo);
  }

  getBarberoInfo(empleadoId: string): { especialidades: string[], calificacion: number } | undefined {
    return this.barberosData().get(empleadoId);
  }

  crearEmpleado(empleado: Omit<Usuario, 'id' | 'fechaRegistro'>): Usuario {
    const nuevoEmpleado: Usuario = {
      ...empleado,
      id: `e${Date.now()}`,
      fechaRegistro: new Date()
    };
    
    this.empleadosData.update(empleados => [...empleados, nuevoEmpleado]);
    
    // Si es barbero, inicializar datos adicionales
    if (empleado.rol === 'barbero') {
      this.barberosData.update(barberos => {
        const nuevos = new Map(barberos);
        nuevos.set(nuevoEmpleado.id, { especialidades: [], calificacion: 0 });
        return nuevos;
      });
    }
    
    return nuevoEmpleado;
  }

  actualizarEmpleado(id: string, datos: Partial<Usuario>): void {
    this.empleadosData.update(empleados =>
      empleados.map(e => e.id === id ? { ...e, ...datos } : e)
    );
  }

  actualizarBarberoInfo(empleadoId: string, info: { especialidades?: string[], calificacion?: number }): void {
    this.barberosData.update(barberos => {
      const nuevos = new Map(barberos);
      const actual = nuevos.get(empleadoId) || { especialidades: [], calificacion: 0 };
      nuevos.set(empleadoId, { ...actual, ...info });
      return nuevos;
    });
  }

  desactivarEmpleado(id: string): void {
    this.actualizarEmpleado(id, { activo: false });
  }

  activarEmpleado(id: string): void {
    this.actualizarEmpleado(id, { activo: true });
  }

  cambiarRol(id: string, nuevoRol: RolUsuario): void {
    this.actualizarEmpleado(id, { rol: nuevoRol });
  }
}
