const DATABASE_NAME = 'vortex-task';
const DATABASE_VERSION = 2;
const OUTBOX_STORE = 'outbox';
const METADATA_STORE = 'metadata';

function createId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class OutboxService {
  constructor({ indexedDBImpl = globalThis.indexedDB, keyRangeImpl = globalThis.IDBKeyRange } = {}) {
    this.indexedDB = indexedDBImpl;
    this.keyRange = keyRangeImpl;
    this.databasePromise = null;
  }

  open() {
    if (!this.indexedDB) {
      return Promise.reject(new Error('Este navegador no permite IndexedDB; las acciones offline no se pueden guardar.'));
    }
    if (this.databasePromise) return this.databasePromise;

    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
          database.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
        }
        const outboxStore = request.transaction.objectStore(OUTBOX_STORE);
        if (outboxStore.indexNames.contains('scopeCreatedAt')) {
          outboxStore.deleteIndex('scopeCreatedAt');
        }
        outboxStore.createIndex('scopeSequence', ['userId', 'workspaceId', 'sequence']);
        if (!database.objectStoreNames.contains(METADATA_STORE)) {
          database.createObjectStore(METADATA_STORE, { keyPath: 'id' });
        }
        let sequence = 0;
        const cursorRequest = outboxStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            const record = cursor.value;
            if (!record.sequence) {
              record.sequence = ++sequence;
              cursor.update(record);
            } else {
              sequence = Math.max(sequence, record.sequence);
            }
            cursor.continue();
            return;
          }
          request.transaction.objectStore(METADATA_STORE)
            .put({ id: 'outbox-sequence', value: sequence });
        };
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error('No se pudo abrir la base local de acciones offline.'));
      request.onblocked = () => reject(new Error('La base local está bloqueada por otra pestaña de Vortex Task.'));
    }).catch((error) => {
      this.databasePromise = null;
      throw error;
    });

    return this.databasePromise;
  }

  async transact(storeName, mode, perform) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = perform(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error || new Error('Falló una transacción de IndexedDB.'));
      transaction.onabort = () => reject(transaction.error || new Error('Se canceló una transacción de IndexedDB.'));
      request?.addEventListener('error', () => reject(request.error || new Error('Falló una operación de IndexedDB.')), { once: true });
    });
  }

  async add(action) {
    const record = {
      ...action,
      id: action.id || createId(),
      schemaVersion: 1,
      createdAt: action.createdAt || new Date().toISOString()
    };
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([OUTBOX_STORE, METADATA_STORE], 'readwrite');
      const metadata = transaction.objectStore(METADATA_STORE);
      const sequenceRequest = metadata.get('outbox-sequence');
      sequenceRequest.onsuccess = () => {
        record.sequence = (sequenceRequest.result?.value || 0) + 1;
        metadata.put({ id: 'outbox-sequence', value: record.sequence });
        transaction.objectStore(OUTBOX_STORE).add(record);
      };
      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la acción offline.'));
      transaction.onabort = () => reject(transaction.error || new Error('Se canceló el guardado de la acción offline.'));
      sequenceRequest.onerror = () => reject(sequenceRequest.error || new Error('No se pudo ordenar la cola offline.'));
    });
  }

  async list({ userId, workspaceId }) {
    if (!userId || !workspaceId) return [];
    if (!this.keyRange) throw new Error('IDBKeyRange no está disponible para consultar la cola offline.');
    const range = this.keyRange.bound(
      [userId, workspaceId, 0],
      [userId, workspaceId, Number.MAX_SAFE_INTEGER]
    );
    const records = await this.transact(OUTBOX_STORE, 'readonly', (store) => (
      store.index('scopeSequence').getAll(range)
    ));
    return records.sort((first, second) => (
      (first.sequence || 0) - (second.sequence || 0)
      || first.createdAt.localeCompare(second.createdAt)
      || first.id.localeCompare(second.id)
    ));
  }

  async remove(id) {
    await this.transact(OUTBOX_STORE, 'readwrite', (store) => store.delete(id));
  }

  async getCheckpoint(id) {
    const record = await this.transact(METADATA_STORE, 'readonly', (store) => store.get(id));
    return record?.value || null;
  }

  async setCheckpoint(id, value) {
    await this.transact(METADATA_STORE, 'readwrite', (store) => store.put({ id, value }));
  }
}
