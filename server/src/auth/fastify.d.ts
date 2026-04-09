import { JwtPayload } from './index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by auth middleware on all JWT-authenticated requests */
    user?: JwtPayload;
  }
}
