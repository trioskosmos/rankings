import { db, guard, type Env } from '../../../_lib/util.ts';
import { handleModerate } from '../../../../src/handlers.ts';

export const onRequestPost: PagesFunction<Env> = ({ env, request, params }) =>
  guard(async () => {
    const body = (await request.json()) as { action?: 'approve' | 'reject' };
    const action = body.action === 'reject' ? 'reject' : 'approve';
    return handleModerate(db(env), Number(params.id), action, request.headers.get('x-admin-token'), env.ADMIN_TOKEN);
  });
