import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import { AppError } from '../../shared/AppError';
import { Requester } from '../../application/BillingService';

/** Mesma identidade de token validada pelo authorizer do API Gateway (oficina-lambda-auth). */
export const JWT_ISSUERS = ['oficina-marimb0ndo-auth', 'oficina-marimb0ndo-os'];
export const JWT_AUDIENCE = 'oficina-marimb0ndo-api';

declare module 'express-serve-static-core' {
  interface Request {
    requester?: Requester;
  }
}

/** Defesa em profundidade: o Gateway já validou o token, mas o serviço valida de novo. */
export function authMiddleware(jwtSecret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) throw new AppError('Token de autenticação não fornecido', 401);
    try {
      const claims = jwt.verify(match[1], jwtSecret, {
        algorithms: ['HS256'],
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUERS as [string, ...string[]],
      }) as jwt.JwtPayload;
      const type = claims.type === 'client' ? 'client' : 'staff';
      if (type === 'client' && claims.status !== 'ATIVO') throw new Error('cliente inativo');
      req.requester = { sub: String(claims.sub), type };
      next();
    } catch {
      throw new AppError('Token inválido ou expirado', 401);
    }
  };
}

const ORIGIN_EXEMPT = new Set(['/health']);

/** Recusa chamadas que não vieram do API Gateway (header x-origin-verify). */
export function originVerifyMiddleware(secret: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!secret || ORIGIN_EXEMPT.has(req.path)) return next();
    const received = Buffer.from(req.header('x-origin-verify') ?? '');
    const expected = Buffer.from(secret);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new AppError('Acesso permitido somente via API Gateway', 403);
    }
    next();
  };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ status: 'error', message: err.message });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ status: 'error', message: 'JSON inválido no corpo da requisição' });
    return;
  }
  console.error('[Unhandled Error]', err);
  res.status(500).json({ status: 'error', message: 'Erro interno do servidor' });
}
