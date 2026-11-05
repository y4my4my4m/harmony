import express from 'express';
import cors from 'cors';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { NATIVE_CLIENT_ORIGINS, corsOrigins } from '../nativeOrigins.js';

describe('native app origins', () => {
  it('are the origins the Tauri 3 runtimes serve the app from', () => {
    expect([...NATIVE_CLIENT_ORIGINS].sort()).toEqual(['http://tauri.localhost', 'tauri://localhost']);
  });

  it('join CORS_ORIGIN after its trimmed, non-empty entries, once each', () => {
    expect(corsOrigins(' https://har.example , ,https://alt.example')).toEqual([
      'https://har.example',
      'https://alt.example',
      'tauri://localhost',
      'http://tauri.localhost',
    ]);
    expect(corsOrigins('http://tauri.localhost')).toEqual(['http://tauri.localhost', 'tauri://localhost']);
  });

  describe('as the server applies them', () => {
    const app = express();
    app.use(cors({ origin: corsOrigins('https://har.example'), credentials: true }));
    app.get('/instance-info', (_req, res) => {
      res.json({ ok: true });
    });
    const request = supertest(app);

    it.each(['tauri://localhost', 'http://tauri.localhost', 'https://har.example'])('admits %s with credentials', async (origin) => {
      const res = await request.get('/instance-info').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it.each(['https://tauri.localhost', 'http://localhost:5173', 'https://evil.example'])('admits no %s', async (origin) => {
      const res = await request.get('/instance-info').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers a preflight from the Windows and Android app', async () => {
      const res = await request
        .options('/instance-info')
        .set('Origin', 'http://tauri.localhost')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    });
  });
});
