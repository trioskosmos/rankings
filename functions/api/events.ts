import { db, guard, type Env } from '../_lib/util.ts';
import { handleEvents } from '../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env, request }) => {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  return guard(() => handleEvents(db(env), q));
};
