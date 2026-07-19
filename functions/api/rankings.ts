import { db, guard, fingerprint, type Env } from '../_lib/util.ts';
import { handleListRankings, handleCreateRanking } from '../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env, request }) => {
  const status = new URL(request.url).searchParams.get('status') ?? 'approved';
  return guard(() => handleListRankings(db(env), status));
};

export const onRequestPost: PagesFunction<Env> = ({ env, request }) =>
  guard(async () =>
    handleCreateRanking(db(env), await request.json(), fingerprint(request), env.REQUIRE_APPROVAL === 'true'),
  );
