import assert from 'node:assert/strict';
import test from 'node:test';
import { SupabaseAdapter } from '../js/data/db.js';
import { SupabaseClient } from '../js/data/supabaseClient.js';
import {
  AttachmentService,
  ATTACHMENT_MAX_FILE_SIZE,
  ATTACHMENT_MAX_FILES,
  validateAttachmentFiles
} from '../js/services/attachmentService.js';

function createFile(name, type = 'image/jpeg', size = 1024) {
  return { name, type, size, lastModified: 1 };
}

test('attachment validation enforces image MIME types, count, size, and filename length', () => {
  assert.equal(validateAttachmentFiles([createFile('evidence.jpg')]).length, 1);
  assert.throws(() => validateAttachmentFiles([createFile('script.svg', 'image/svg+xml')]), /formato.*no está permitido/);
  assert.throws(
    () => validateAttachmentFiles(Array.from({ length: ATTACHMENT_MAX_FILES + 1 }, (_, index) => createFile(`${index}.jpg`))),
    /hasta 5 imágenes/
  );
  assert.throws(
    () => validateAttachmentFiles([createFile('large.jpg', 'image/jpeg', ATTACHMENT_MAX_FILE_SIZE + 1)]),
    /supera el límite de 8 MB/
  );
  assert.throws(() => validateAttachmentFiles([createFile('x'.repeat(256))]), /no puede superar 255 caracteres/);
});

test('uploads attachment objects and metadata under the ticket workspace path', async () => {
  const uploadedObjects = [];
  const metadata = [];
  const ticketService = {
    async getAttachmentContext(ticketId) {
      assert.equal(ticketId, 'TCK-1020');
      return { workspaceId: 'workspace-123' };
    }
  };
  const db = {
    async uploadAttachmentObject(path, file) {
      uploadedObjects.push({ path, file });
    },
    async createAttachmentRecord(record) {
      const saved = { ...record, id: `attachment-${metadata.length + 1}` };
      metadata.push(saved);
      return saved;
    }
  };
  const service = new AttachmentService({ ticketService, db });

  const [attachment] = await service.uploadFiles('TCK-1020', [createFile('captura.jpg')], { commentId: 7 });

  assert.match(attachment.storagePath, /^workspace-123\/TCK-1020\/.+\.jpg$/);
  assert.equal(attachment.commentId, 7);
  assert.equal(uploadedObjects[0].path, attachment.storagePath);
  assert.equal(metadata[0].fileName, 'captura.jpg');
  assert.equal(metadata[0].mimeType, 'image/jpeg');
});

test('removes previously uploaded objects and records if a later upload fails', async () => {
  const events = [];
  let creationCount = 0;
  const service = new AttachmentService({
    ticketService: { async getAttachmentContext() { return { workspaceId: 'workspace-123' }; } },
    db: {
      async uploadAttachmentObject(path) { events.push(`upload:${path}`); },
      async createAttachmentRecord(record) {
        creationCount += 1;
        if (creationCount === 2) throw new Error('Storage de metadatos rechazó el archivo.');
        return { ...record, id: 'attachment-1' };
      },
      async deleteAttachmentObject(path) { events.push(`delete-object:${path}`); },
      async deleteAttachmentRecord(id) { events.push(`delete-record:${id}`); }
    }
  });

  await assert.rejects(
    () => service.uploadFiles('TCK-1020', [createFile('one.jpg'), createFile('two.png', 'image/png')]),
    /Storage de metadatos rechazó el archivo/
  );
  assert.equal(events.filter((event) => event.startsWith('delete-object:')).length, 2);
  assert.ok(events.includes('delete-record:attachment-1'));
});

test('Supabase storage uploads preserve binary bodies and include authenticated MIME headers', async () => {
  const previousFetch = globalThis.fetch;
  const blob = new Blob(['image-bytes'], { type: 'image/webp' });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, async text() { return '{}'; } };
  };

  try {
    const client = new SupabaseClient({ url: 'https://project.supabase.co', anonKey: 'public-key' });
    await client.requestStorage('object/ticket-attachments/workspace/TCK-1/photo.webp', {
      method: 'POST',
      accessToken: 'user-token',
      body: blob,
      rawBody: true,
      contentType: blob.type,
      headers: { 'x-upsert': 'false' }
    });

    assert.equal(request.url, 'https://project.supabase.co/storage/v1/object/ticket-attachments/workspace/TCK-1/photo.webp');
    assert.equal(request.options.body, blob);
    assert.equal(request.options.headers['Content-Type'], 'image/webp');
    assert.equal(request.options.headers.Authorization, 'Bearer user-token');
    assert.equal(request.options.headers['x-upsert'], 'false');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('creates signed URLs in one private storage request and preserves path mapping', async () => {
  let request;
  const paths = ['workspace/TCK-1/a.webp', 'workspace/TCK-1/b.jpg'];
  const client = {
    url: 'https://project.supabase.co',
    async requestStorage(path, options) {
      request = { path, options };
      return paths.map((filePath) => ({
        path: filePath,
        signedURL: `/object/sign/ticket-attachments/${filePath}?token=temporary`
      }));
    }
  };
  const adapter = new SupabaseAdapter(client, async () => 'user-token');

  const urls = await adapter.createAttachmentSignedUrls(paths);

  assert.equal(request.path, 'object/sign/ticket-attachments');
  assert.deepEqual(request.options.body, { expiresIn: 3600, paths });
  assert.deepEqual(urls, paths.map((filePath) => (
    `https://project.supabase.co/storage/v1/object/sign/ticket-attachments/${filePath}?token=temporary`
  )));
});
