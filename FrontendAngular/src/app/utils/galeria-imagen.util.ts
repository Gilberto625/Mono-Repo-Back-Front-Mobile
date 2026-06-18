/**
 * HEIC/HEIF (iPhone) a menudo llegan con MIME vacío o application/octet-stream en Windows/Chrome.
 */
const EXT_IMAGEN_GALERIA = /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|avif)$/i;

export function esImagenValidaParaGaleria(file: File): boolean {
  const tipo = (file.type || '').trim().toLowerCase();
  if (tipo.startsWith('image/')) {
    return true;
  }
  if (tipo === 'application/octet-stream' && EXT_IMAGEN_GALERIA.test(file.name)) {
    return true;
  }
  return EXT_IMAGEN_GALERIA.test(file.name);
}
