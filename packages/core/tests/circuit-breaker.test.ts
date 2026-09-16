import { describe, expect, it } from 'vitest';
import {
  InMemoryCircuitBreaker,
  NoopCircuitBreaker,
  isCircuitBreakerFailure,
  RelayAuthenticationError,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
  RelayRateLimitError,
  RelayTimeoutError,
} from '../src/index.js';

describe('Circuit Breaker Foundation (@relay/core)', () => {
  describe('isCircuitBreakerFailure classification', () => {
    it('identifies 502, 503, 504 and RelayProviderUnavailableError / RelayTimeoutError as circuit failures', () => {
      expect(isCircuitBreakerFailure(new RelayProviderUnavailableError('Service down'))).toBe(true);
      expect(isCircuitBreakerFailure(new RelayTimeoutError('Timeout'))).toBe(true);
      expect(isCircuitBreakerFailure({ statusCode: 502 })).toBe(true);
      expect(isCircuitBreakerFailure({ statusCode: 503 })).toBe(true);
      expect(isCircuitBreakerFailure({ statusCode: 504 })).toBe(true);
      expect(isCircuitBreakerFailure({ code: 'provider_unavailable' })).toBe(true);
      expect(isCircuitBreakerFailure({ code: 'request_timeout' })).toBe(true);
      expect(isCircuitBreakerFailure({ code: 'ECONNREFUSED' })).toBe(true);
      expect(isCircuitBreakerFailure({ code: 'ENOTFOUND' })).toBe(true);
      expect(isCircuitBreakerFailure({ code: 'ECONNRESET' })).toBe(true);
      expect(isCircuitBreakerFailure({ code: 'ETIMEDOUT' })).toBe(true);
      expect(isCircuitBreakerFailure({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe(true);
      expect(isCircuitBreakerFailure(new Error('TypeError: fetch failed'))).toBe(true);
    });

    it('rejects client errors, rate limits, and non-qualifying errors from tripping circuit', () => {
      expect(isCircuitBreakerFailure(new RelayInvalidRequestError('Bad request'))).toBe(false);
      expect(isCircuitBreakerFailure(new RelayAuthenticationError('Bad key'))).toBe(false);
      expect(isCircuitBreakerFailure(new RelayRateLimitError('Rate limited'))).toBe(false);
      expect(isCircuitBreakerFailure({ statusCode: 400 })).toBe(false);
      expect(isCircuitBreakerFailure({ statusCode: 401 })).toBe(false);
      expect(isCircuitBreakerFailure({ statusCode: 403 })).toBe(false);
      expect(isCircuitBreakerFailure({ statusCode: 404 })).toBe(false);
      expect(isCircuitBreakerFailure({ statusCode: 429 })).toBe(false);
      expect(isCircuitBreakerFailure({ code: 'rate_limit_exceeded' })).toBe(false);
      expect(isCircuitBreakerFailure(new Error('User cancelled'))).toBe(false);
      expect(isCircuitBreakerFailure(null)).toBe(false);
      expect(isCircuitBreakerFailure(undefined)).toBe(false);
    });
  });

  describe('InMemoryCircuitBreaker State Transitions', () => {
    let mockTime = 1000;
    const getTime = () => mockTime;

    it('initializes in CLOSED state and allows requests', () => {
      const cb = new InMemoryCircuitBreaker({ getTime });
      expect(cb.getState('gemini')).toBe('closed');
      const decision = cb.beforeRequest('gemini');
      expect(decision.allow).toBe(true);
      expect(decision.state).toBe('closed');
      expect(decision.provider).toBe('gemini');
    });

    it('trips from CLOSED to OPEN after reaching failureThreshold', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 10000,
        getTime,
      });

      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('closed');
      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('closed');

      // 3rd failure trips the breaker
      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('open');

      const decision = cb.beforeRequest('gemini');
      expect(decision.allow).toBe(false);
      expect(decision.state).toBe('open');
      expect(decision.retryAfterMs).toBe(10000);
    });

    it('success in CLOSED state resets consecutive failure count', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 3,
        getTime,
      });

      cb.onFailure('gemini');
      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('closed');

      // Success resets failure count
      cb.onSuccess('gemini');

      // Needs 3 fresh failures to trip
      cb.onFailure('gemini');
      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('closed');
      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('open');
    });

    it('transitions from OPEN to HALF_OPEN after resetTimeoutMs expires', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        halfOpenMaxRequests: 1,
        getTime,
      });

      cb.onFailure('qwen');
      cb.onFailure('qwen');
      expect(cb.getState('qwen')).toBe('open');

      // Before timeout
      mockTime += 4000;
      expect(cb.getState('qwen')).toBe('open');
      const rejectDecision = cb.beforeRequest('qwen');
      expect(rejectDecision.allow).toBe(false);
      expect(rejectDecision.retryAfterMs).toBe(1000);

      // Advance past timeout
      mockTime += 1001; // total 5001ms elapsed
      expect(cb.getState('qwen')).toBe('half_open');

      // Trial request is permitted
      const trialDecision = cb.beforeRequest('qwen');
      expect(trialDecision.allow).toBe(true);
      expect(trialDecision.state).toBe('half_open');

      // Subsequent concurrent request while trial is active is rejected
      const concurrentDecision = cb.beforeRequest('qwen');
      expect(concurrentDecision.allow).toBe(false);
      expect(concurrentDecision.state).toBe('half_open');
    });

    it('recovers to CLOSED when trial request in HALF_OPEN succeeds', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        getTime,
      });

      cb.onFailure('gemini');
      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('open');

      mockTime += 5000;
      expect(cb.getState('gemini')).toBe('half_open');

      cb.beforeRequest('gemini'); // trial request starts
      cb.onSuccess('gemini'); // trial request succeeds

      expect(cb.getState('gemini')).toBe('closed');
      const nextDecision = cb.beforeRequest('gemini');
      expect(nextDecision.allow).toBe(true);
      expect(nextDecision.state).toBe('closed');
    });

    it('re-opens immediately when trial request in HALF_OPEN fails', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        getTime,
      });

      cb.onFailure('gemini');
      cb.onFailure('gemini');
      expect(cb.getState('gemini')).toBe('open');

      mockTime += 5000;
      expect(cb.getState('gemini')).toBe('half_open');

      cb.beforeRequest('gemini');
      cb.onFailure('gemini', new RelayProviderUnavailableError('Still broken'));

      expect(cb.getState('gemini')).toBe('open');
      const decision = cb.beforeRequest('gemini');
      expect(decision.allow).toBe(false);
      expect(decision.state).toBe('open');
    });

    it('ignores non-qualifying errors passed to onFailure', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 2,
        getTime,
      });

      // 400 errors do not increment failure count
      cb.onFailure('gemini', new RelayInvalidRequestError('User error'));
      cb.onFailure('gemini', new RelayAuthenticationError('Key error'));
      cb.onFailure('gemini', new RelayRateLimitError('Rate limited'));
      expect(cb.getState('gemini')).toBe('closed');

      // Only qualifying errors advance failure count
      cb.onFailure('gemini', new RelayProviderUnavailableError('Service down'));
      expect(cb.getState('gemini')).toBe('closed');
      cb.onFailure('gemini', new RelayTimeoutError('Timeout'));
      expect(cb.getState('gemini')).toBe('open');
    });

    it('supports isolated state tracking per provider', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 2,
        getTime,
      });

      cb.onFailure('provider-a');
      cb.onFailure('provider-a');
      expect(cb.getState('provider-a')).toBe('open');
      expect(cb.getState('provider-b')).toBe('closed');

      expect(cb.beforeRequest('provider-a').allow).toBe(false);
      expect(cb.beforeRequest('provider-b').allow).toBe(true);
    });

    it('supports reset per provider and global reset', () => {
      const cb = new InMemoryCircuitBreaker({
        failureThreshold: 1,
        getTime,
      });

      cb.onFailure('provider-a');
      cb.onFailure('provider-b');
      expect(cb.getState('provider-a')).toBe('open');
      expect(cb.getState('provider-b')).toBe('open');

      cb.reset('provider-a');
      expect(cb.getState('provider-a')).toBe('closed');
      expect(cb.getState('provider-b')).toBe('open');

      cb.reset();
      expect(cb.getState('provider-b')).toBe('closed');
    });
  });

  describe('NoopCircuitBreaker', () => {
    it('always permits requests and reports closed state', () => {
      const noop = new NoopCircuitBreaker();
      expect(noop.getState('any')).toBe('closed');
      expect(noop.beforeRequest('any')).toEqual({
        allow: true,
        state: 'closed',
        provider: 'any',
      });

      noop.onFailure('any', new RelayProviderUnavailableError('503'));
      expect(noop.getState('any')).toBe('closed');
      expect(noop.beforeRequest('any').allow).toBe(true);

      noop.onSuccess('any');
      noop.reset('any');
      expect(noop.getState('any')).toBe('closed');
    });
  });
});
