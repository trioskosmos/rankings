import { db, guard, type Env } from '../../_lib/util.ts';
import { handleParse } from '../../../src/handlers.ts';

export const onRequestPost: PagesFunction<Env> = ({ env, request }) =>
  guard(async () => handleParse(db(env), await request.json()));
