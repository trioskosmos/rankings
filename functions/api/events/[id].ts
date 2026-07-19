import { db, guard, type Env } from '../../_lib/util.ts';
import { handleEventSongs } from '../../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env, params }) =>
  guard(() => handleEventSongs(db(env), String(params.id)));
