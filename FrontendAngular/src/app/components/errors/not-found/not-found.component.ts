import { Component } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';

@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent],
  templateUrl: './not-found.component.html',
  styleUrl: './not-found.component.css'
})
export class NotFoundComponent {
  errorCode = '404';
  errorTitle = 'Página no encontrada';
  errorMessage = 'Lo sentimos, la página que buscas no existe o ha sido movida.';

  constructor(private location: Location) {}

  goBack(): void {
    this.location.back();
  }
}
