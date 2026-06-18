import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const publicOnlyGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isAuthenticated()) {
    return true;
  }

  const rol = authService.getCurrentUser()?.rol || localStorage.getItem('userRole') || undefined;
  router.navigate([authService.getHomeRouteByRole(rol)]);
  return false;
};
