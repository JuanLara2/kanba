export const ATTACHMENT_BUCKET = 'ticket-attachments';
export const ATTACHMENT_MAX_FILE_SIZE = 8 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 5;
export const ATTACHMENT_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
});

function createId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function validateAttachmentFiles(files) {
  const selected = Array.from(files || []);
  if (selected.length > ATTACHMENT_MAX_FILES) {
    throw new Error(`Puedes adjuntar hasta ${ATTACHMENT_MAX_FILES} imágenes por comentario.`);
  }
  selected.forEach((file) => {
    if (!ATTACHMENT_MIME_TYPES.includes(file.type)) {
      throw new Error(`El formato de ${file.name || 'un archivo'} no está permitido. Usa JPG, PNG, WebP o GIF.`);
    }
    if (!Number.isFinite(file.size) || file.size < 1) {
      throw new Error(`${file.name || 'El archivo'} está vacío o no se pudo leer.`);
    }
    if (file.size > ATTACHMENT_MAX_FILE_SIZE) {
      throw new Error(`${file.name || 'El archivo'} supera el límite de 8 MB.`);
    }
    if (String(file.name || '').length > 255) {
      throw new Error('El nombre del archivo no puede superar 255 caracteres.');
    }
  });
  return selected;
}

async function compressImage(file) {
  if (file.type === 'image/gif' || typeof globalThis.createImageBitmap !== 'function'
    || typeof document === 'undefined') {
    return file;
  }

  const bitmap = await globalThis.createImageBitmap(file);
  try {
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('El navegador no pudo preparar la imagen para compresión.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('No se pudo comprimir la imagen seleccionada.'));
      }, 'image/webp', 0.82);
    });
    if (blob.type !== 'image/webp' || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') || 'adjunto';
    return new File([blob], `${name}.webp`, { type: blob.type, lastModified: file.lastModified });
  } finally {
    bitmap.close?.();
  }
}

export class AttachmentService {
  constructor({ ticketService, db }) {
    this.ticketService = ticketService;
    this.db = db;
  }

  async uploadFiles(ticketId, files, { commentId = null } = {}) {
    const selected = validateAttachmentFiles(files);
    if (!selected.length) return [];
    const { workspaceId } = await this.ticketService.getAttachmentContext(ticketId);
    const uploaded = [];
    let activeStoragePath = null;

    try {
      for (const originalFile of selected) {
        const file = await compressImage(originalFile);
        if (file.size > ATTACHMENT_MAX_FILE_SIZE) {
          throw new Error(`${originalFile.name} supera el límite de 8 MB luego de prepararse.`);
        }
        const extension = MIME_EXTENSIONS[file.type];
        if (!extension) throw new Error('La imagen preparada tiene un formato que no está permitido.');
        const storagePath = `${workspaceId}/${ticketId}/${createId()}.${extension}`;
        activeStoragePath = storagePath;
        await this.db.uploadAttachmentObject(storagePath, file);
        const record = await this.db.createAttachmentRecord({
          ticketId,
          commentId,
          storagePath,
          fileName: originalFile.name,
          mimeType: file.type,
          sizeBytes: file.size
        });
        uploaded.push(record);
        activeStoragePath = null;
      }
      return uploaded;
    } catch (error) {
      const cleanupErrors = [];
      if (activeStoragePath) {
        try {
          await this.db.deleteAttachmentObject(activeStoragePath);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      for (const record of uploaded.reverse()) {
        try {
          await this.removeUploaded(record);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        throw new Error(
          `${error.message} No se pudo limpiar uno o más archivos temporales: ${cleanupErrors[0].message}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  async removeUploaded(record) {
    await this.db.deleteAttachmentObject(record.storagePath);
    await this.db.deleteAttachmentRecord(record.id);
  }

  async linkToComment(records, commentId) {
    await this.db.linkAttachmentsToComment(records.map((record) => record.id), commentId);
  }

  async getForTicket(ticketId) {
    const records = await this.ticketService.getAttachments(ticketId);
    const signedUrls = await this.db.createAttachmentSignedUrls(records.map((record) => record.storagePath));
    return records.map((record, index) => ({ ...record, signedUrl: signedUrls[index] }));
  }
}
