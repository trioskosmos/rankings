import { db, guard, type Env } from '../_lib/util.ts';
import { handleAggregate } from '../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env, request }) => {
  const sp = new URL(request.url).searchParams;
  return guard(() => handleAggregate(db(env), { event: sp.get('event') ?? undefined, group: sp.get('group') ?? undefined }));
};
