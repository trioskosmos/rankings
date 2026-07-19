import { db, guard, type Env } from '../../_lib/util.ts';
import { handleGetRanking } from '../../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env, params }) =>
  guard(() => handleGetRanking(db(env), Number(params.id)));
