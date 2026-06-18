import { ApplicationConfig } from '@angular/core';
import { provideRouter, withPreloading } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { getAuth, provideAuth } from '@angular/fire/auth';
import { environment } from '../environments/environment';

import { routes } from './app.routes';
import { authInterceptor } from './interceptors/auth.interceptor';
import { errorInterceptor } from './interceptors/error.interceptor';
import { SelectivePreloadingStrategy } from './services/selective-preloading.strategy';

// Firebase providers con manejo de errores robusto
function getFirebaseProviders(): any[] {
  try {
    if (!environment?.firebase?.apiKey) {
      console.warn('⚠️ Firebase config no disponible, continuando sin Firebase');
      return [];
    }

    return [
      provideFirebaseApp(() => {
        try {
          console.log('🔥 Inicializando Firebase...');
          const app = initializeApp(environment.firebase);
          console.log('✅ Firebase inicializado correctamente');
          return app;
        } catch (error: any) {
          console.warn('⚠️ Error inicializando Firebase (no bloqueante):', error?.message || error);
          // Retornar instancia dummy para no bloquear la app
          try {
            return initializeApp({
              apiKey: 'dummy-key',
              authDomain: 'dummy.firebaseapp.com',
              projectId: 'dummy-project',
              storageBucket: 'dummy.appspot.com',
              messagingSenderId: '123456789',
              appId: '1:123456789:web:dummy'
            });
          } catch (e) {
            console.error('❌ Error crítico con Firebase dummy:', e);
            throw e; // Solo lanzar si incluso el dummy falla
          }
        }
      }),
      provideAuth(() => {
        try {
          return getAuth();
        } catch (error: any) {
          console.warn('⚠️ Error obteniendo Auth (no bloqueante):', error?.message || error);
          return getAuth(); // Intentar de todas formas
        }
      })
    ];
  } catch (error: any) {
    console.warn('⚠️ Error configurando Firebase providers (continuando sin Firebase):', error?.message || error);
    return [];
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withPreloading(SelectivePreloadingStrategy)),
    provideHttpClient(
      withInterceptorsFromDi(),
      withInterceptors([authInterceptor, errorInterceptor])
    ),
    provideAnimations(),
    ...getFirebaseProviders()
  ]
};
