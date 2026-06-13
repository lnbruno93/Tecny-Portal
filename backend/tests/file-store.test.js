// Tests para backend/src/lib/fileStore.js (P-03 Fase 1).
//
// En Fase 1 solo existe driver `db`, así que estos tests cubren el camino feliz
// + edge cases del driver db. Fase 2 (driver R2) agregará un archivo aparte
// con mock de @aws-sdk/client-s3.

const { Readable } = require('stream');

// Cargamos la lib una sola vez con STORAGE_DRIVER=db (default).
// Para testear el caso "driver inválido" hay un test dedicado más abajo que
// resetea el module cache.
const fileStore = require('../src/lib/fileStore');

describe('fileStore — driver db (Fase 1)', () => {
  describe('_DRIVER', () => {
    test('default es "db" cuando STORAGE_DRIVER no está seteado', () => {
      expect(fileStore._DRIVER).toBe('db');
    });
  });

  describe('put()', () => {
    test('sin dataBase64 devuelve todos los campos en null', async () => {
      const result = await fileStore.put({});
      expect(result).toEqual({
        data: null, key: null, nombre: null, tipo: null, size: null,
      });
    });

    test('dataBase64=null se trata como sin archivo', async () => {
      const result = await fileStore.put({
        dataBase64: null,
        filename: 'algo.jpg',
        mime: 'image/jpeg',
      });
      expect(result.data).toBeNull();
      expect(result.nombre).toBeNull();
      expect(result.tipo).toBeNull();
    });

    test('con dataBase64 es passthrough al campo `data` (driver db)', async () => {
      const blob = Buffer.from('hola mundo').toString('base64'); // "aG9sYSBtdW5kbw=="
      const result = await fileStore.put({
        dataBase64: blob,
        filename: 'saludo.txt',
        mime: 'text/plain',
        entity: 'comprobantes',
      });
      expect(result.data).toBe(blob);
      expect(result.key).toBeNull();             // driver db nunca setea key
      expect(result.nombre).toBe('saludo.txt');
      expect(result.tipo).toBe('text/plain');
    });

    test('calcula size correctamente desde base64 con padding "=="', async () => {
      // "hola mundo" tiene 10 bytes → base64 "aG9sYSBtdW5kbw==" (16 chars, padding ==)
      const blob = Buffer.from('hola mundo').toString('base64');
      const result = await fileStore.put({ dataBase64: blob });
      expect(result.size).toBe(10);
    });

    test('calcula size correctamente desde base64 con padding "="', async () => {
      // "hola mund" tiene 9 bytes → base64 "aG9sYSBtdW5k" + "=" = "aG9sYSBtdW5k" (no padding)
      // Probemos uno con 1 padding: "hola mun" = 8 bytes → "aG9sYSBtdW4=" (12 chars, padding =)
      const blob = Buffer.from('hola mun').toString('base64');
      expect(blob.endsWith('=')).toBe(true);
      const result = await fileStore.put({ dataBase64: blob });
      expect(result.size).toBe(8);
    });

    test('calcula size correctamente desde base64 sin padding', async () => {
      // "hola mu" = 7 bytes... probemos uno que dé múltiplo de 3 → sin padding
      const blob = Buffer.from('hol').toString('base64'); // "aG9s"
      expect(blob).toBe('aG9s');
      const result = await fileStore.put({ dataBase64: blob });
      expect(result.size).toBe(3);
    });

    test('size devuelve null si dataBase64 no es string', async () => {
      const result = await fileStore.put({ dataBase64: 12345 });
      // dataBase64 numérico → !dataBase64 es false (12345 truthy) pero no es string → size null
      // Pero la lib usa typeof check en _sizeFromBase64 — verificamos
      expect(result.size).toBeNull();
    });

    test('campos faltantes (filename, mime) defaultean a null', async () => {
      const blob = Buffer.from('x').toString('base64');
      const result = await fileStore.put({ dataBase64: blob });
      expect(result.nombre).toBeNull();
      expect(result.tipo).toBeNull();
      expect(result.data).toBe(blob);
    });
  });

  describe('get()', () => {
    test('lee de archivo_data con prefix default', async () => {
      const row = {
        archivo_data: 'BASE64',
        archivo_nombre: 'doc.pdf',
        archivo_tipo: 'application/pdf',
      };
      const result = await fileStore.get(row);
      expect(result).toEqual({
        data: 'BASE64',
        nombre: 'doc.pdf',
        tipo: 'application/pdf',
      });
    });

    test('lee de foto_data con prefix="foto"', async () => {
      const row = {
        foto_data: 'IMGBASE64',
        foto_nombre: 'producto.jpg',
        foto_tipo: 'image/jpeg',
      };
      const result = await fileStore.get(row, { prefix: 'foto' });
      expect(result).toEqual({
        data: 'IMGBASE64',
        nombre: 'producto.jpg',
        tipo: 'image/jpeg',
      });
    });

    test('devuelve null si la fila no tiene archivo_data', async () => {
      const row = { archivo_data: null, archivo_nombre: null };
      const result = await fileStore.get(row);
      expect(result).toBeNull();
    });

    test('devuelve null si la fila no tiene la columna esperada', async () => {
      const result = await fileStore.get({ foo: 'bar' });
      expect(result).toBeNull();
    });

    test('devuelve null si row es undefined o null', async () => {
      expect(await fileStore.get(undefined)).toBeNull();
      expect(await fileStore.get(null)).toBeNull();
    });

    test('campos nombre/tipo faltantes defaultean a null', async () => {
      const row = { archivo_data: 'BASE64' };
      const result = await fileStore.get(row);
      expect(result.data).toBe('BASE64');
      expect(result.nombre).toBeNull();
      expect(result.tipo).toBeNull();
    });
  });

  describe('stream()', () => {
    test('devuelve un Readable de un solo chunk con el buffer decoded', async () => {
      const original = 'hola mundo';
      const blob = Buffer.from(original).toString('base64');
      const row = { archivo_data: blob };

      const stream = await fileStore.stream(row);
      expect(stream).toBeInstanceOf(Readable);

      // Consumir el stream y verificar el contenido
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const result = Buffer.concat(chunks).toString();
      expect(result).toBe(original);
    });

    test('funciona con prefix="foto"', async () => {
      const blob = Buffer.from('xxx').toString('base64');
      const row = { foto_data: blob };
      const stream = await fileStore.stream(row, { prefix: 'foto' });
      expect(stream).toBeInstanceOf(Readable);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('xxx');
    });

    test('devuelve null si la fila no tiene archivo', async () => {
      expect(await fileStore.stream({ archivo_data: null })).toBeNull();
      expect(await fileStore.stream({})).toBeNull();
      expect(await fileStore.stream(null)).toBeNull();
    });
  });

  describe('remove()', () => {
    test('es no-op en driver db (no throwea)', async () => {
      await expect(fileStore.remove({ archivo_data: 'x' })).resolves.toBeUndefined();
      await expect(fileStore.remove(null)).resolves.toBeUndefined();
    });
  });
});

describe('fileStore — STORAGE_DRIVER inválido', () => {
  // Este test reinicia el module cache para forzar el throw inicial. No usa
  // la instancia singleton — la importa fresca con env mockeado.
  test('throwea fatal si STORAGE_DRIVER no es "db"', () => {
    const original = process.env.STORAGE_DRIVER;
    process.env.STORAGE_DRIVER = 'r2';  // r2 no existe en Fase 1
    jest.resetModules();
    expect(() => require('../src/lib/fileStore')).toThrow(
      /STORAGE_DRIVER='r2'.+no está soportado/i,
    );
    // Restaurar para no contaminar tests siguientes
    if (original === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = original;
    jest.resetModules();
  });

  test('throwea fatal si STORAGE_DRIVER es un valor random', () => {
    const original = process.env.STORAGE_DRIVER;
    process.env.STORAGE_DRIVER = 'foobar';
    jest.resetModules();
    expect(() => require('../src/lib/fileStore')).toThrow(
      /STORAGE_DRIVER='foobar'/i,
    );
    if (original === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = original;
    jest.resetModules();
  });
});
