import { db, guard, type Env } from '../_lib/util.ts';
import { handleAggregate } from '../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env, request }) => {
  const event = new URL(request.url).searchParams.get('event') ?? undefined;
  return guard(() => handleAggregate(db(env), { event }));
};
