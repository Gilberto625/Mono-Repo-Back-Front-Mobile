export const API_ENDPOINTS = {
  auth: {
    login: '/login/',
    register: '/register/',
    refresh: '/auth/token/refresh/',
    profile: '/perfil/',
    profilePassword: '/perfil/cambiar-contrasena/',
    profile2fa: '/perfil/2fa/',
    recoverOtp: '/recuperar-otp/',
    verifyRecoveryOtp: '/verificar-otp-recuperacion/',
    updatePasswordOtp: '/actualizar-contrasena-otp/'
  },
  appointments: '/citas/',
  orders: '/pedidos/',
  createOrder: '/pedidos/crear/',
  validatePromotion: '/promociones/validar/',
  clipPayment: '/pagos/clip/intentar/'
} as const;

export function apiEndpoint(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/$/, '')}${path}`;
}
