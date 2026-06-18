import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

console.log('🚀 Iniciando aplicación Angular...');
console.log('📦 AppConfig:', appConfig);
console.log('🎯 AppComponent:', AppComponent);

bootstrapApplication(AppComponent, appConfig)
  .then(() => {
    console.log('✅ Aplicación Angular iniciada correctamente');
  })
  .catch((err: any) => {
    console.error('❌ Error al inicializar la aplicación:', err);
    console.error('Stack trace:', err?.stack);
    
    // Mostrar un mensaje de error en la página
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding: 20px; font-family: Arial, sans-serif; background: #f5f5f5; color: #333;';
    errorDiv.innerHTML = `
      <h1 style="color: #d32f2f;">Error al cargar la aplicación</h1>
      <p>Por favor, recarga la página. Si el problema persiste, verifica la consola del navegador (F12).</p>
      <p><strong>Error:</strong> ${err?.message || 'Error desconocido'}</p>
      <details style="margin-top: 10px;">
        <summary>Detalles técnicos</summary>
        <pre style="background: #fff; padding: 10px; border: 1px solid #ddd; overflow: auto;">${err?.stack || JSON.stringify(err, null, 2)}</pre>
      </details>
    `;
    document.body.appendChild(errorDiv);
  });
