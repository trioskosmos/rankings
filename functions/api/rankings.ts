import { db, guard, fingerprint, type Env } from '../_lib/util.ts';
import { handleListRankings, handleCreateRanking } from '../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env }) => guard(() => handleListRankings(db(env)));

export const onRequestPost: PagesFunction<Env> = ({ env, request }) =>
  guard(async () => handleCreateRanking(db(env), await request.json(), fingerprint(request)));
