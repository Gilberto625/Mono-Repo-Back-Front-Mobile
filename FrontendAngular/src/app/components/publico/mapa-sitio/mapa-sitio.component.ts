import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';

@Component({
  selector: 'app-mapa-sitio',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent, ScrollRevealDirective],
  templateUrl: './mapa-sitio.component.html',
  styleUrl: './mapa-sitio.component.css'
})
export class MapaSitioComponent {
  secciones = [
    {
      titulo: 'Páginas Públicas',
      enlaces: [
        { label: 'Inicio', route: '/' },
        { label: 'Servicios', route: '/servicios' },
        { label: 'Productos', route: '/productos' },
        { label: 'Nosotros', route: '/nosotros' },
        { label: 'Ayuda', route: '/ayuda' },
        { label: 'Contáctanos', route: '/contacto' }
      ]
    },
    {
      titulo: 'Área de Clientes',
      enlaces: [
        { label: 'Servicios', route: '/cliente/servicios' },
        { label: 'Productos', route: '/cliente/productos' },
        { label: 'Agendar Cita', route: '/cliente/agendar' },
        { label: 'Mis Citas', route: '/cliente/citas' },
        { label: 'Carrito', route: '/cliente/carrito' },
        { label: 'Mis Pedidos', route: '/cliente/pedidos' },
        { label: 'Mi Perfil', route: '/cliente/perfil' }
      ]
    }
  ];
}
