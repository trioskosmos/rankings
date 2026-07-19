import { db, guard, type Env } from '../_lib/util.ts';
import { handleCatalog } from '../../src/handlers.ts';

export const onRequestGet: PagesFunction<Env> = ({ env }) => guard(() => handleCatalog(db(env)));
