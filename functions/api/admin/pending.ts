import { db, guard, type Env } from '../../_lib/util.ts';
import { handleAdminPending } from '../../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env, request }) =>
  guard(() => handleAdminPending(db(env), request.headers.get('x-admin-token'), env.ADMIN_TOKEN));
