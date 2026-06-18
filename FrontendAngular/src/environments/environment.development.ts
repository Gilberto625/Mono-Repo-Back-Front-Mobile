export const environment = {
  production: false,
  // Front en local contra API en Render (para volver a Django local: http://127.0.0.1:8000/api)
  apiUrl: 'http://127.0.0.1:8000/api',

  firebase: {
    apiKey: "AIzaSyAJ0Om_GyOwpAgJoaQc7g1oplyGx7g70LQ",
    authDomain: "auth-backend-tu-nombre.firebaseapp.com",
    projectId: "auth-backend-tu-nombre",
    storageBucket: "auth-backend-tu-nombre.firebasestorage.app",
    messagingSenderId: "370925550099",
    appId: "1:370925550099:web:ebfdea93f12c7b01435de6"
  }
};
