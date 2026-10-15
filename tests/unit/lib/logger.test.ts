import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from '../../../src/lib/logger.js';
import { createLogCapture } from '../../helpers/log-capture.js';

describe('createLogger', () => {
  it('writes JSON lines with service name and ISO timestamp', () => {
    const capture = createLogCapture();
    const logger = createLogger(
      { level: 'info', nodeEnv: 'test' },
      capture.stream,
    );

    logger.info('hello');

    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).toMatchObject({
      level: 30,
      service: 'sparrow-api',
      msg: 'hello',
    });
    expect(capture.lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects the configured level', () => {
    const capture = createLogCapture();
    const logger = createLogger(
      { level: 'warn', nodeEnv: 'test' },
      capture.stream,
    );

    logger.info('dropped');
    logger.warn('kept');

    expect(capture.lines.map((line) => line.msg)).toEqual(['kept']);
  });

  it('redacts credentials and one-time codes', () => {
    const capture = createLogCapture();
    const logger = createLogger(
      { level: 'info', nodeEnv: 'test' },
      capture.stream,
    );

    const sensitive = {
      authorization: 'Bearer sentinel-authorization',
      cookie: 'sentinel-cookie',
      password: 'sentinel-password',
      otp: 'sentinel-otp',
      pin: 'sentinel-pin',
      token: 'sentinel-token',
      accessToken: 'sentinel-access-token',
      refreshToken: 'sentinel-refresh-token',
      secret: 'sentinel-secret',
    };

    logger.info(
      {
        req: {
          headers: {
            authorization: sensitive.authorization,
            cookie: sensitive.cookie,
          },
        },
        body: {
          password: sensitive.password,
          otp: sensitive.otp,
          pin: sensitive.pin,
          token: sensitive.token,
          accessToken: sensitive.accessToken,
          refreshToken: sensitive.refreshToken,
          secret: sensitive.secret,
        },
      },
      'request',
    );

    expect(capture.raw()).not.toContain('sentinel-');
    expect(capture.lines[0]).toMatchObject({
      req: { headers: { authorization: REDACTED, cookie: REDACTED } },
      body: { password: REDACTED, otp: REDACTED, pin: REDACTED },
    });
  });

  it('redacts sensitive keys at the top level of the log object', () => {
    const capture = createLogCapture();
    const logger = createLogger(
      { level: 'info', nodeEnv: 'test' },
      capture.stream,
    );

    logger.info(
      { token: 'sentinel-token', otp: 'sentinel-otp', phoneVerified: true },
      'issued',
    );

    expect(capture.raw()).not.toContain('sentinel-');
    expect(capture.lines[0]).toMatchObject({
      token: REDACTED,
      otp: REDACTED,
      phoneVerified: true,
    });
  });
});
