// Tests del driver R2 de fileStore (P-03 Fase 2).
//
// Usa mock inyectado via `_setS3ClientForTest`. NO conecta a R2 real.
// Estos tests verifican el path crítico: PUT/GET/DELETE pasan por S3Client.send
// con el Command correcto, y el fallback legacy (`archivo_data` cuando no hay
// `archivo_key`) sigue funcionando bajo driver r2.

const { Readable } = require('stream');

// Helpers para reload fresca del módulo con STORAGE_DRIVER=r2
function loadR2Module() {
  // Setear env vars antes de require — el módulo las usa cuando _getS3Client()
  // hace lazy init. Por mock, no las lee en los tests, pero el guard inicial
  // (DRIVER check) sí.
  process.env.STORAGE_DRIVER       = 'r2';
  process.env.R2_ENDPOINT          = 'https://test.r2.cloudflarestorage.com';
  process.env.R2_ACCESS_KEY_ID     = 'test-key-id';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.R2_BUCKET            = 'test-bucket';
  process.env.NODE_ENV             = 'test';
  jest.resetModules();
  // eslint-disable-next-line global-require
  return require('../src/lib/fileStore');
}

// Restaurar al driver db por defecto al terminar este archivo.
afterAll(() => {
  delete process.env.STORAGE_DRIVER;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;
  jest.resetModules();
});

describe('fileStore — driver r2', () => {
  let fileStore;
  let mockSend;
  let mockS3;

  beforeEach(() => {
    fileStore = loadR2Module();
    mockSend = jest.fn();
    mockS3 = { send: mockSend };
    fileStore._setS3ClientForTest(mockS3);
  });

  afterEach(() => {
    fileStore._resetS3ClientForTest();
  });

  describe('_DRIVER', () => {
    test('es "r2" cuando STORAGE_DRIVER=r2', () => {
      expect(fileStore._DRIVER).toBe('r2');
    });
  });

  describe('put()', () => {
    // PR 5 multi-tenant: todos los put() requieren tenantId (entero positivo).
    // Los tests existentes pasan tenantId=1 para preservar la semántica
    // pre-PR-5 (single-tenant). El test de cross-tenant abajo valida que
    // tenants distintos generan keys con prefijos distintos.
    test('sin tenantId tira error (validación upfront)', async () => {
      const blob = Buffer.from('x').toString('base64');
      await expect(fileStore.put({ dataBase64: blob, entity: 'comprobantes' }))
        .rejects.toThrow(/tenantId requerido/);
      await expect(fileStore.put({ tenantId: 0, dataBase64: blob, entity: 'comprobantes' }))
        .rejects.toThrow(/tenantId requerido/);
      await expect(fileStore.put({ tenantId: -1, dataBase64: blob, entity: 'comprobantes' }))
        .rejects.toThrow(/tenantId requerido/);
      await expect(fileStore.put({ tenantId: 'abc', dataBase64: blob, entity: 'comprobantes' }))
        .rejects.toThrow(/tenantId requerido/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('sin dataBase64 devuelve nulls y NO llama a S3', async () => {
      const result = await fileStore.put({ tenantId: 1, entity: 'comprobantes' });
      expect(result).toEqual({ data: null, key: null, nombre: null, tipo: null, size: null });
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('con dataBase64 llama PutObjectCommand con buffer decoded', async () => {
      mockSend.mockResolvedValue({});  // S3 returns nothing on PUT
      const blob = Buffer.from('hola mundo').toString('base64');

      const result = await fileStore.put({
        tenantId: 1,
        dataBase64: blob,
        filename: 'saludo.txt',
        mime: 'text/plain',
        entity: 'comprobantes',
      });

      // Verificar invocación a S3
      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.constructor.name).toBe('PutObjectCommand');
      expect(sentCommand.input.Bucket).toBe('test-bucket');
      expect(sentCommand.input.Body).toBeInstanceOf(Buffer);
      expect(sentCommand.input.Body.toString()).toBe('hola mundo');
      expect(sentCommand.input.ContentType).toBe('text/plain');
      expect(sentCommand.input.Metadata['original-name']).toBe('saludo.txt');

      // Key con prefix tenant: ipro/<env>/t<tenantId>/<entity>/<YYYY/MM/DD>/<uuid>.<ext>
      expect(sentCommand.input.Key).toMatch(
        /^ipro\/test\/t1\/comprobantes\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.txt$/
      );

      // El return debe tener key (no data) — el caller guarda key en columna
      expect(result.data).toBeNull();
      expect(result.key).toBe(sentCommand.input.Key);
      expect(result.nombre).toBe('saludo.txt');
      expect(result.tipo).toBe('text/plain');
      expect(result.size).toBe(10);  // "hola mundo" = 10 bytes
    });

    test('genera key con subpath cuando se pasa', async () => {
      mockSend.mockResolvedValue({});
      const blob = Buffer.from('x').toString('base64');

      await fileStore.put({
        tenantId: 1,
        dataBase64: blob,
        mime: 'image/jpeg',
        entity: 'productos',
        subpath: 'producto-42',
      });

      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.Key).toMatch(
        /^ipro\/test\/t1\/productos\/producto-42\/[0-9a-f-]{36}\.jpg$/
      );
    });

    test('mapea MIMEs comunes a extensiones correctas', async () => {
      mockSend.mockResolvedValue({});
      const blob = Buffer.from('x').toString('base64');

      const cases = [
        { mime: 'image/jpeg',      ext: 'jpg' },
        { mime: 'image/png',       ext: 'png' },
        { mime: 'image/webp',      ext: 'webp' },
        { mime: 'application/pdf', ext: 'pdf' },
        { mime: 'unknown/type',    ext: 'bin' },
        { mime: undefined,         ext: 'bin' },
      ];
      for (const { mime, ext } of cases) {
        mockSend.mockClear();
        await fileStore.put({ tenantId: 1, dataBase64: blob, mime, entity: 'comprobantes' });
        const key = mockSend.mock.calls[0][0].input.Key;
        expect(key.endsWith('.' + ext)).toBe(true);
      }
    });

    test('Metadata original-name filtra caracteres no-ASCII', async () => {
      mockSend.mockResolvedValue({});
      const blob = Buffer.from('x').toString('base64');
      await fileStore.put({
        tenantId: 1,
        dataBase64: blob,
        filename: 'fotó-café.jpg',  // caracteres con acento
        mime: 'image/jpeg',
        entity: 'productos',
      });
      const meta = mockSend.mock.calls[0][0].input.Metadata['original-name'];
      // Los caracteres no-ASCII se reemplazan con _
      expect(meta).not.toContain('ó');
      expect(meta).not.toContain('é');
      expect(meta).toMatch(/fot.-caf.\.jpg/);
    });

    test('S3 error propaga al caller (no se silencia)', async () => {
      const s3Err = new Error('S3 down');
      mockSend.mockRejectedValue(s3Err);
      const blob = Buffer.from('x').toString('base64');

      await expect(fileStore.put({
        tenantId: 1,
        dataBase64: blob,
        mime: 'image/jpeg',
        entity: 'comprobantes',
      })).rejects.toThrow('S3 down');
    });

    // ── PR 5 multi-tenant: aislamiento de keys por tenant ──
    test('PR 5: tenants distintos generan keys con prefijos distintos (aislamiento)', async () => {
      mockSend.mockResolvedValue({});
      const blob = Buffer.from('archivo del tenant').toString('base64');

      // Tenant A
      await fileStore.put({
        tenantId: 100,
        dataBase64: blob,
        mime: 'application/pdf',
        entity: 'comprobantes',
        subpath: 'mismo-subpath',
      });
      const keyA = mockSend.mock.calls[0][0].input.Key;

      // Tenant B (mismos entity + subpath para forzar el mejor caso de colisión)
      mockSend.mockClear();
      await fileStore.put({
        tenantId: 200,
        dataBase64: blob,
        mime: 'application/pdf',
        entity: 'comprobantes',
        subpath: 'mismo-subpath',
      });
      const keyB = mockSend.mock.calls[0][0].input.Key;

      // Cada key tiene el prefix correcto del tenant.
      expect(keyA).toMatch(/^ipro\/test\/t100\/comprobantes\/mismo-subpath\/[0-9a-f-]{36}\.pdf$/);
      expect(keyB).toMatch(/^ipro\/test\/t200\/comprobantes\/mismo-subpath\/[0-9a-f-]{36}\.pdf$/);

      // Las keys NO se solapan: comparten el sufijo entity+subpath pero el
      // prefix tenant las separa irreductiblemente. Esto es el invariante
      // operativo — el bucket queda particionado por tenant a nivel path.
      expect(keyA.startsWith('ipro/test/t100/')).toBe(true);
      expect(keyB.startsWith('ipro/test/t200/')).toBe(true);
      expect(keyA).not.toEqual(keyB);
    });
  });

  describe('get()', () => {
    test('fila con archivo_key llama GetObjectCommand y devuelve base64', async () => {
      // S3 devuelve un stream con el contenido
      mockSend.mockResolvedValue({
        Body: Readable.from([Buffer.from('contenido del archivo')]),
      });

      const row = {
        archivo_key:    'ipro/test/comprobantes/abc.pdf',
        archivo_nombre: 'recibo.pdf',
        archivo_tipo:   'application/pdf',
      };
      const result = await fileStore.get(row);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('GetObjectCommand');
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toBe('ipro/test/comprobantes/abc.pdf');

      // El contenido se devuelve como base64
      expect(result.data).toBe(Buffer.from('contenido del archivo').toString('base64'));
      expect(result.nombre).toBe('recibo.pdf');
      expect(result.tipo).toBe('application/pdf');
    });

    test('fila SIN archivo_key pero CON archivo_data lee legacy (no llama S3)', async () => {
      const row = {
        archivo_key:    null,
        archivo_data:   'LEGACY_BASE64',
        archivo_nombre: 'old.jpg',
        archivo_tipo:   'image/jpeg',
      };
      const result = await fileStore.get(row);

      expect(mockSend).not.toHaveBeenCalled();
      expect(result).toEqual({
        data: 'LEGACY_BASE64',
        nombre: 'old.jpg',
        tipo: 'image/jpeg',
      });
    });

    test('fila sin archivo_key ni archivo_data devuelve null', async () => {
      const row = { archivo_key: null, archivo_data: null };
      expect(await fileStore.get(row)).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('S3 devuelve NoSuchKey → get devuelve null (no throw)', async () => {
      const noSuchKey = new Error('NoSuchKey');
      noSuchKey.name = 'NoSuchKey';
      mockSend.mockRejectedValue(noSuchKey);

      const row = { archivo_key: 'ipro/test/comprobantes/borrado.pdf' };
      expect(await fileStore.get(row)).toBeNull();
    });

    test('S3 devuelve 404 (httpStatusCode) → get devuelve null', async () => {
      const notFound = new Error('Not found');
      notFound.$metadata = { httpStatusCode: 404 };
      mockSend.mockRejectedValue(notFound);

      const row = { archivo_key: 'ipro/test/comprobantes/borrado.pdf' };
      expect(await fileStore.get(row)).toBeNull();
    });

    test('S3 devuelve otro error → propaga al caller', async () => {
      mockSend.mockRejectedValue(new Error('Internal error'));
      const row = { archivo_key: 'ipro/test/comprobantes/x.pdf' };
      await expect(fileStore.get(row)).rejects.toThrow('Internal error');
    });

    test('funciona con prefix=foto', async () => {
      mockSend.mockResolvedValue({
        Body: Readable.from([Buffer.from('img')]),
      });

      const row = {
        foto_key:    'ipro/test/productos/foto.jpg',
        foto_nombre: 'iphone.jpg',
        foto_tipo:   'image/jpeg',
      };
      const result = await fileStore.get(row, { prefix: 'foto' });

      expect(mockSend.mock.calls[0][0].input.Key).toBe('ipro/test/productos/foto.jpg');
      expect(result.data).toBe(Buffer.from('img').toString('base64'));
      expect(result.nombre).toBe('iphone.jpg');
    });
  });

  describe('stream()', () => {
    test('fila con archivo_key devuelve el Body stream directo (sin materializar)', async () => {
      const s3Body = Readable.from([Buffer.from('big binary')]);
      mockSend.mockResolvedValue({ Body: s3Body });

      const row = { archivo_key: 'ipro/test/comprobantes/big.pdf' };
      const result = await fileStore.stream(row);

      // Es el mismo stream — el beneficio principal vs base64 driver db
      expect(result).toBe(s3Body);
    });

    test('fila legacy (archivo_data only) wrappea base64 en Readable', async () => {
      const blob = Buffer.from('legacy').toString('base64');
      const row = { archivo_data: blob };

      const result = await fileStore.stream(row);
      expect(result).toBeInstanceOf(Readable);
      expect(mockSend).not.toHaveBeenCalled();

      const chunks = [];
      for await (const chunk of result) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('legacy');
    });

    test('NoSuchKey en stream() devuelve null', async () => {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      mockSend.mockRejectedValue(err);

      const row = { archivo_key: 'ipro/test/comprobantes/gone.pdf' };
      expect(await fileStore.stream(row)).toBeNull();
    });
  });

  describe('remove()', () => {
    test('fila con archivo_key llama DeleteObjectCommand', async () => {
      mockSend.mockResolvedValue({});
      const row = { archivo_key: 'ipro/test/comprobantes/borrar.pdf' };

      await fileStore.remove(row);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('DeleteObjectCommand');
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toBe('ipro/test/comprobantes/borrar.pdf');
    });

    test('fila sin archivo_key NO llama S3', async () => {
      await fileStore.remove({ archivo_data: 'legacy' });
      await fileStore.remove({});
      await fileStore.remove(null);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('NoSuchKey en remove es idempotente (no throw)', async () => {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      mockSend.mockRejectedValue(err);

      await expect(fileStore.remove({
        archivo_key: 'ipro/test/comprobantes/ya-borrado.pdf'
      })).resolves.toBeUndefined();
    });

    test('otro error en remove propaga', async () => {
      mockSend.mockRejectedValue(new Error('Network down'));
      await expect(fileStore.remove({
        archivo_key: 'ipro/test/comprobantes/x.pdf'
      })).rejects.toThrow('Network down');
    });

    test('funciona con prefix=foto', async () => {
      mockSend.mockResolvedValue({});
      await fileStore.remove({ foto_key: 'ipro/test/productos/x.jpg' }, { prefix: 'foto' });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].input.Key).toBe('ipro/test/productos/x.jpg');
    });
  });
});

describe('fileStore — driver r2 sin env vars', () => {
  test('_getS3Client throwea si falta R2_ENDPOINT', () => {
    process.env.STORAGE_DRIVER = 'r2';
    delete process.env.R2_ENDPOINT;
    process.env.R2_ACCESS_KEY_ID     = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_BUCKET            = 'b';
    jest.resetModules();
    // eslint-disable-next-line global-require
    const fs = require('../src/lib/fileStore');
    fs._resetS3ClientForTest();

    // El throw se materializa al intentar la PRIMERA operación con driver r2,
    // no en el require — eso es intencional (test bypass + flag-off path).
    return expect(fs.put({
      tenantId: 1,  // PR 5: tenantId requerido — el test mide el throw de lazy init de R2
      dataBase64: Buffer.from('x').toString('base64'),
      mime: 'image/jpeg',
      entity: 'productos',
    })).rejects.toThrow(/R2_ENDPOINT.+R2_ACCESS_KEY_ID/);
  });
});
