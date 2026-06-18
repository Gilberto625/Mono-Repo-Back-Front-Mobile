import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

function extractTempToken(route: ActivatedRouteSnapshot, router: Router): string {
  const fromQuery = (route.queryParamMap.get('tempToken') || '').trim();
  if (fromQuery) {
    return fromQuery;
  }

  const navState = router.getCurrentNavigation()?.extras?.state as { tempToken?: string } | undefined;
  const fromNavState = (navState?.tempToken || '').trim();
  if (fromNavState) {
    return fromNavState;
  }

  const historyState = (history.state || {}) as { tempToken?: string };
  return (historyState.tempToken || '').trim();
}

export const verify2faGuard: CanActivateFn = (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    const rol = authService.getCurrentUser()?.rol || localStorage.getItem('userRole') || undefined;
    router.navigate([authService.getHomeRouteByRole(rol)]);
    return false;
  }

  const tempToken = extractTempToken(route, router);
  if (!tempToken) {
    router.navigate(['/login']);
    return false;
  }

  return true;
};
