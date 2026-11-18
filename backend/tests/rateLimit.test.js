const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { createApp } = require('../app');
const { rateLimitOptions } = require('../middleware/rateLimit');
const { createMarketFeed } = require('../services/marketFeed');

const WINDOW_MS = 60000;

function tokenFor(userId) {
  return jwt.sign({ user: { id: userId } }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('explicit rate limiting', () => {
  test('enforces a limit, returns 429 with Retry-After, and still allows valid requests', async () => {
    const app = express();
    app.post('/probe', rateLimit(rateLimitOptions({ max: 2, windowMs: WINDOW_MS })), (req, res) => {
      res.json({ ok: true });
    });

    expect((await request(app).post('/probe')).status).toBe(200);
    expect((await request(app).post('/probe')).status).toBe(200);

    const limited = await request(app).post('/probe');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('limits signup/login attempts on the auth router', async () => {
    const app = createApp({
      feed: createMarketFeed(),
      auth: {
        rateLimits: {
          auth: { max: 2, windowMs: WINDOW_MS },
          authRead: { max: 100, windowMs: WINDOW_MS }
        }
      }
    });

    // Invalid payloads are rejected before any database access, but still
    // consume the route's limiter budget.
    const first = await request(app).post('/api/auth/login').send({ email: 42, password: 42 });
    const second = await request(app).post('/api/auth/login').send({ email: 42, password: 42 });
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);

    const limited = await request(app).post('/api/auth/login').send({ email: 42, password: 42 });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    const otherRoute = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'valid-name', email: 'valid@example.test', password: 'password-123' });
    expect(otherRoute.status).toBe(429);
  });

  test('limits manual trade endpoints across the shared trade budget', async () => {
    const app = createApp({
      feed: createMarketFeed(),
      trade: { rateLimit: { max: 2, windowMs: WINDOW_MS } }
    });
    const token = tokenFor('507f1f77bcf86cd799439011');

    const body = { symbol: 'BTCUSDT', quantity: 0.1, clientOrderId: 'not-a-uuid' };
    expect((await request(app).post('/api/trade/buy').set('x-auth-token', token).send(body)).status).toBe(400);
    expect((await request(app).post('/api/trade/sell').set('x-auth-token', token).send(body)).status).toBe(400);

    const limited = await request(app).post('/api/trade/limit').set('x-auth-token', token).send(body);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('the trade limiter runs before authentication', async () => {
    const app = createApp({
      feed: createMarketFeed(),
      trade: { rateLimit: { max: 1, windowMs: WINDOW_MS } }
    });

    // Unauthenticated requests must still consume the limiter budget. If auth
    // ran first, the second request would be a 401 instead of a 429.
    const first = await request(app).post('/api/trade/buy').send({});
    expect(first.status).toBe(401);

    const limited = await request(app).post('/api/trade/sell').send({});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  test('the auth read limiter runs before authentication on /me', async () => {
    const app = createApp({
      feed: createMarketFeed(),
      auth: {
        rateLimits: {
          auth: { max: 100, windowMs: WINDOW_MS },
          authRead: { max: 1, windowMs: WINDOW_MS }
        }
      }
    });

    const first = await request(app).get('/api/auth/me');
    expect(first.status).toBe(401);

    const limited = await request(app).get('/api/auth/me');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  test('the copilot limiter runs before authentication', async () => {
    const app = createApp({
      feed: createMarketFeed(),
      copilot: { rateLimit: { max: 1, windowMs: WINDOW_MS } }
    });

    const first = await request(app).post('/api/copilot/parse').send({ prompt: 'buy 0.1 BTC' });
    expect(first.status).toBe(401);

    const limited = await request(app).post('/api/copilot/execute').send({});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  test('limits the copilot revoke endpoint', async () => {
    const app = createApp({
      feed: createMarketFeed(),
      copilot: { rateLimit: { max: 2, windowMs: WINDOW_MS } }
    });
    const token = tokenFor('507f1f77bcf86cd799439012');
    const proposalId = '5f2a4c7e-1b9d-4a3e-8c6f-0d2e4b6a8c1f';

    const first = await request(app)
      .post(`/api/copilot/proposals/${proposalId}/revoke`)
      .set('x-auth-token', token)
      .send({});
    expect([400, 404]).toContain(first.status);

    const second = await request(app)
      .post(`/api/copilot/proposals/${proposalId}/revoke`)
      .set('x-auth-token', token)
      .send({});
    expect([400, 404]).toContain(second.status);

    const limited = await request(app)
      .post(`/api/copilot/proposals/${proposalId}/revoke`)
      .set('x-auth-token', token)
      .send({});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
